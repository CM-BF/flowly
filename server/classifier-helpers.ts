import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi, PaseoWorkspaceAgentCreateOptions } from "@getpaseo/client";
import { z } from "zod";
import type { RemoveAgent, RemovableAgent } from "./summarizer-remove";

export const CLASSIFIER_OWNER_LABEL = "flowly-review-classifier";
const ownershipSchema = z.object({ version: z.literal(1), entries: z.array(z.object({ id: z.string(), workspaceId: z.string(), owner: z.string(), confirmed: z.boolean() })) });
type Ownership = z.infer<typeof ownershipSchema>["entries"][number];
// Multiple generations may overlap briefly during shutdown. Serialize by file, and always read its latest contents.
const writes = new Map<string, Promise<unknown>>();
export class ClassifierHelperStore {
  readonly path: string;
  constructor(readonly directory: string) { this.path = join(directory, "review-classifier-helpers.json"); }
  private async load() {
    try { return ownershipSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 as const, entries: [] as Ownership[] }; throw error; }
  }
  async read() { await writes.get(this.path); return (await this.load()).entries; }
  private update(change: (entries: Ownership[]) => void) {
    const work = (writes.get(this.path) ?? Promise.resolve()).then(async () => {
      const data = await this.load(); change(data.entries);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
      await rename(temporary, this.path);
    });
    writes.set(this.path, work.catch(() => undefined));
    return work;
  }
  add(entry: Ownership) { return this.update((entries) => { entries.push(entry); }); }
  confirm(id: string) { return this.update((entries) => { const entry = entries.find((e) => e.id === id); if (entry) entry.confirmed = true; }); }
  forget(id: string) { return this.update((entries) => { const index = entries.findIndex((e) => e.id === id); if (index >= 0) entries.splice(index, 1); }); }
}

/** Only classifier-owned ids are recovered. Missing unconfirmed creates stay owned: the daemon may finish later. */
export class ClassifierHelpers {
  readonly store: ClassifierHelperStore;
  private paseo?: PaseoApi;
  private stopped = false;
  private active = new Set<string>();
  private handles = new Map<string, RemovableAgent>();
  private pending = new Set<Promise<unknown>>();
  private removing = new Map<string, Promise<void>>();
  private recovery?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private cursor = 0;
  /**
   * Helpers whose last hard delete left them in place (archived at best), per id: the 30-second check still probes them, but
   * the delete (a local daemon connection, an archive call, a log line) is retried only after a backoff that doubles from one
   * minute up to an hour, and quietly. In memory: each plugin start tries once at its first pass (a new Paseo may delete).
   */
  private failures = new Map<string, { attempts: number; retryAt: number }>();
  constructor(directory: string, private removeAgent: RemoveAgent, private options: { graceMs?: number; recoverMs?: number; probeMs?: number; newId?: () => string; now?: () => number } = {}) {
    this.store = new ClassifierHelperStore(directory);
  }
  private now() { return (this.options.now ?? Date.now)(); }
  attach(paseo: PaseoApi) {
    if (this.stopped) return;
    const first = !this.paseo;
    this.paseo = paseo;
    if (!first) return;
    void this.recover().catch((error) => console.error("Flowly classifier helper recovery:", String(error)));
    this.timer = setInterval(() => void this.recover().catch((error) => console.error("Flowly classifier helper recovery:", String(error))), this.options.recoverMs ?? 30_000);
    this.timer.unref?.();
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }
  create(workspaceId: string, input: PaseoWorkspaceAgentCreateOptions, signal: AbortSignal) {
    const entry = { id: this.options.newId?.() ?? randomUUID(), workspaceId, owner: randomUUID(), confirmed: false };
    this.active.add(entry.id);
    return this.track((async () => {
    try {
      await this.store.add(entry); // Durable ownership precedes the native request, including a failed/late create.
      if (this.stopped || signal.aborted) { await this.store.forget(entry.id); throw new Error("Cancelled"); }
      return await this.paseo!.workspaces.ref(workspaceId).agents.create({
        ...input, agentId: entry.id, labels: { ...input.labels, [CLASSIFIER_OWNER_LABEL]: entry.owner },
      }).then(async (agent) => {
        if (agent.id !== entry.id) throw new Error("Classifier helper creation returned an unexpected id.");
        this.handles.set(agent.id, agent);
        await this.store.confirm(entry.id);
        if (this.stopped || signal.aborted) await this.remove(agent);
        return agent;
      });
    } catch (error) { this.active.delete(entry.id); throw error; }
    })());
  }
  remove(agent: RemovableAgent): Promise<void> {
    const existing = this.removing.get(agent.id);
    if (existing) return existing;
    const work = (async () => {
      const owned = (await this.store.read()).find((e) => e.id === agent.id);
      if (!owned) return;
      const failure = this.failures.get(agent.id);
      await this.removeAgent(agent, failure ? { quiet: true } : undefined);
      // The existing remover may only archive when hard deletion fails. Keep ownership until absence is confirmed.
      const current = await this.paseo!.agents.ref(agent.id).refresh().catch(() => undefined);
      const gone = current === null || (!!current && !current.agent);
      if (gone) this.failures.delete(agent.id);
      else if (current) { const attempts = (failure?.attempts ?? 0) + 1; this.failures.set(agent.id, { attempts, retryAt: this.now() + Math.min((this.options.recoverMs ?? 30_000) * 2 ** attempts, 3_600_000) }); }
      if (owned.confirmed && gone) await this.store.forget(agent.id);
    })().finally(() => { this.active.delete(agent.id); this.handles.delete(agent.id); this.removing.delete(agent.id); });
    this.removing.set(agent.id, work);
    return this.track(work);
  }
  recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (!this.paseo || this.stopped) return Promise.resolve();
    const work = (async () => {
      const entries = await this.store.read();
      // Bounded work per pass; rotate so unresolved creates cannot starve later records.
      for (let i = 0; i < Math.min(20, entries.length) && !this.stopped; i++) {
        const entry = entries[(this.cursor + i) % entries.length];
        if (this.active.has(entry.id)) continue;
        const agent = this.paseo!.agents.ref(entry.id);
        const current = await deadline(agent.refresh(), this.options.probeMs ?? 1000).catch(() => undefined);
        if (this.stopped || current === undefined) continue;
        if (!current?.agent) {
          this.failures.delete(entry.id);
          if (entry.confirmed) await this.store.forget(entry.id);
          continue;
        }
        if (current.agent.workspaceId !== entry.workspaceId || current.agent.labels?.[CLASSIFIER_OWNER_LABEL] !== entry.owner) continue;
        if ((this.failures.get(entry.id)?.retryAt ?? 0) > this.now()) continue; // its last delete failed: back off
        await deadline(this.remove(agent), this.options.probeMs ?? 1000).catch(() => undefined);
      }
      this.cursor += Math.min(20, entries.length);
    })().finally(() => { this.recovery = undefined; });
    this.recovery = work;
    return this.track(work);
  }
  /**
   * Settles once no tracked work is left (creates, removals, recoveries, including work they started). stop() stays bounded by
   * its grace: a create that resolves later is still cleaned up (removal, then its ownership write), in production until Paseo
   * stops the plugin subprocess (the durable record then waits for the next start's recovery). Teardown that deletes the data
   * folder waits for this.
   */
  async drained() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  /** Host gives plugins two seconds. Spend at most one second draining, then keep unresolved ids for recovery. */
  async stop(workers: readonly Promise<unknown>[] = []) {
    this.stopped = true; clearInterval(this.timer);
    for (const agent of this.handles.values()) void this.remove(agent).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...workers, ...this.pending]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, this.options.graceMs ?? 1000); }),
    ]).finally(() => clearTimeout(timer));
  }
}

function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Classifier cleanup deferred")), ms); })]).finally(() => clearTimeout(timer));
}
