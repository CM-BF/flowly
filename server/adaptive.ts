import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { adaptiveDefaults, adaptiveLimit, integratorPrompt, isAdaptive, itemPrompt, parseProgress, progressFormat, reminderPrompt, splitRecorded, type Card } from "../shared/adaptive";
import { automationOf, isLive } from "../shared/automation";
import type { AutomationSettings } from "../shared/automation-schema";
import type { Board } from "../shared/model";
import { logFailure } from "./error-report";
import { ToolError } from "./tool-error";

/**
 * Adaptive mode (AUTOMATION-SPEC §5.6): watches each implementer's context while its turn runs, asks it for a checkpoint
 * when the context fills up, and hands the remaining items, one by one, to fresh sessions on the same card, then to a
 * fresh integrator. Everything it observes is kept in adaptive/<taskId>/adaptive.json for evaluation.
 */

const reminderSchema = z.object({ reason: z.enum(["usage", "compaction"]), at: z.string(), used: z.number().optional(), max: z.number().optional() });
const splitSchema = z.object({ at: z.string(), used: z.number().optional(), max: z.number().optional(), items: z.number().int() });
const sessionSchema = z.object({
  agentId: z.string(),
  role: z.enum(["implementer", "item", "integrator"]),
  item: z.number().int().optional(),
  depth: z.number().int(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  peakUsed: z.number().default(0),
  max: z.number().optional(),
  compactions: z.number().int().default(0),
  /** The one reminder Flowly steered in (§5.6.3), and the session's own flowly_split call, if any. */
  reminded: reminderSchema.optional(),
  split: splitSchema.optional(),
});
const itemSchema = z.object({ title: z.string(), body: z.string() });
const recordSchema = z.object({
  version: z.literal(1),
  taskId: z.string(),
  generation: z.number().int(),
  startedAt: z.string(),
  /** The guards in force for this card: items per split, splits of splits. */
  maxItems: z.number().int().default(adaptiveDefaults.maxItems),
  maxDepth: z.number().int().default(adaptiveDefaults.maxDepth),
  maxSessions: z.number().int().default(adaptiveDefaults.maxSessions),
  sessions: z.array(sessionSchema).default([]),
  /** The fresh session the dispatcher starts next (its role is known before its id). */
  pending: z.object({ role: z.enum(["implementer", "item", "integrator"]), item: z.number().int().optional(), depth: z.number().int() }).optional(),
  /** Items still to do, in order, and the depth of the split that made them. */
  queue: z.object({ items: z.array(itemSchema), next: z.number().int(), depth: z.number().int(), progress: z.object({ done: z.string(), decisions: z.string(), howToTest: z.string() }) }).optional(),
  splits: z.array(z.object({ at: z.string(), by: z.string(), depth: z.number().int(), reason: z.string(), items: z.array(z.string()) })).default([]),
  checks: z.array(z.object({ at: z.string(), ok: z.boolean(), exit: z.number().nullable(), tail: z.string() })).default([]),
  deliveredAt: z.string().optional(),
});
export type AdaptiveRecord = z.infer<typeof recordSchema>;
export type AdaptiveNext = { kind: "deliver"; note: string } | { kind: "fresh"; prompt: string; reason: string };
type Usage = { used?: number; max?: number; compactions: number };
type Agent = { lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null; status?: string; activeTurn?: unknown; archivedAt?: string | null };
export type AdaptiveOptions = { exec?: (command: string, cwd: string, timeoutMs: number) => Promise<{ exit: number | null; output: string }>; now?: () => number };

/** A flowly_split call Flowly cannot accept; nothing was recorded. */
class SplitRefused extends ToolError { constructor(message: string) { super("SPLIT_REFUSED", `${message} Nothing was recorded.`); } }
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const busy = (agent: Agent) => agent.status === "running" || !!agent.activeTurn;

export class AdaptiveService {
  /** Adaptive implementers: their Flowly MCP server offers only flowly_request_split. */
  private sessions = new Set<string>();
  private watchedAt = new Map<string, number>();
  private paseo?: PaseoApi;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, private options: AdaptiveOptions = {}) {}
  private now() { return new Date(this.options.now?.() ?? Date.now()).toISOString(); }

  paths(taskId: string) {
    if (!/^[\w-]{1,200}$/.test(taskId)) throw new Error("Invalid card id.");
    const root = join(this.directory, "adaptive", taskId);
    return { root, progress: join(root, "progress.md"), record: join(root, "adaptive.json") };
  }
  async record(taskId: string): Promise<AdaptiveRecord | null> {
    try { return recordSchema.parse(JSON.parse(await readFile(this.paths(taskId).record, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private update(taskId: string, change: (r: AdaptiveRecord) => AdaptiveRecord | void) {
    const job = this.tail.then(async () => {
      const current = await this.record(taskId);
      if (!current) return null;
      const next = change(current) ?? current;
      const file = this.paths(taskId).record, tmp = `${file}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(tmp, file);
      return next;
    });
    this.tail = job.catch(() => undefined);
    return job;
  }

  isSession(agentId: string) { return this.sessions.has(agentId); }
  /** The dispatcher's Paseo connection, for reading a session's usage when it calls flowly_split. */
  attach(paseo: PaseoApi) { this.paseo = paseo; }

  /** A job of an adaptive card starts: a new record, and its first session will be the implementer (depth 0). */
  async begin(taskId: string, generation: number, settings?: Pick<AutomationSettings, "adaptive">) {
    const existing = await this.record(taskId).catch(() => null);
    if (existing?.generation === generation) return;
    await mkdir(this.paths(taskId).root, { recursive: true, mode: 0o700 });
    const record: AdaptiveRecord = { version: 1, taskId, generation, startedAt: this.now(), maxItems: settings?.adaptive?.maxItems ?? adaptiveDefaults.maxItems, maxDepth: settings?.adaptive?.maxDepth ?? adaptiveDefaults.maxDepth, maxSessions: settings?.adaptive?.maxSessions ?? adaptiveDefaults.maxSessions, sessions: [], pending: { role: "implementer", depth: 0 }, splits: [], checks: [] };
    const file = this.paths(taskId).record, tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  /** The dispatcher is creating a session for an adaptive card: it gets the thin tool surface and its role from `pending`. */
  async started(taskId: string, agentId: string) {
    this.sessions.add(agentId);
    await this.update(taskId, (r) => {
      if (r.sessions.some((s) => s.agentId === agentId)) return r;
      const role = r.pending ?? { role: "implementer" as const, depth: 0 };
      return { ...r, pending: undefined, sessions: [...r.sessions, { agentId, role: role.role, ...(role.item !== undefined ? { item: role.item } : {}), depth: role.depth, startedAt: this.now(), peakUsed: 0, compactions: 0 }] };
    });
  }
  /** After a plugin restart: the adaptive sessions of live jobs get their thin tool surface again. */
  remember(agentIds: Iterable<string>) { for (const id of agentIds) this.sessions.add(id); }

  /** Reads a session's context size and automatic compactions; no model call. */
  private async observe(taskId: string, agentId: string, paseo: PaseoApi, agent?: Agent | null): Promise<Usage> {
    const snapshot = agent ?? ((await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent as Agent | undefined);
    const used = snapshot?.lastUsage?.contextWindowUsedTokens, max = snapshot?.lastUsage?.contextWindowMaxTokens;
    const timeline = await paseo.agents.ref(agentId).timeline.refetch({ limit: 500 }).catch(() => null);
    const compactions = (timeline?.entries ?? []).filter((e: { item?: { type?: string; trigger?: string } }) => e.item?.type === "compaction" && e.item.trigger !== "manual").length;
    await this.update(taskId, (r) => ({
      ...r,
      sessions: r.sessions.map((s) => s.agentId === agentId ? { ...s, peakUsed: Math.max(s.peakUsed, used ?? 0), ...(max ? { max } : {}), compactions: Math.max(s.compactions, compactions) } : s),
    }));
    return { used, max, compactions };
  }

  /**
   * Every dispatcher pass (at most every 30 s per session): a running adaptive session whose context crosses the limit,
   * or first compacts, is told once that it may split (§5.6.3). Information only: whether to split is its decision.
   */
  async watch(board: Board, paseo: PaseoApi, steer: (agentId: string, text: string) => Promise<unknown>) {
    this.paseo = paseo;
    for (const job of board.automation) {
      const project = board.projects.find((p) => p.id === job.projectId);
      const settings = automationOf(project);
      if (!isAdaptive(settings) || !isLive(job) || job.role !== "implementer" || !job.implementerId || job.state !== "working") continue;
      const agentId = job.implementerId;
      const last = this.watchedAt.get(agentId) ?? 0;
      if (Date.now() - last < 30_000) continue;
      this.watchedAt.set(agentId, Date.now());
      const agent = (await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent as Agent | undefined;
      if (!agent || agent.archivedAt || !busy(agent)) continue;
      const record = await this.record(job.taskId).catch(() => null);
      const session = record?.sessions.find((s) => s.agentId === agentId);
      if (!record || record.generation !== job.generation || !session) continue;
      const usage = await this.observe(job.taskId, agentId, paseo, agent);
      if (session.reminded || session.split || session.depth >= record.maxDepth || record.sessions.length + 2 > record.maxSessions) continue;
      const over = !!usage.max && usage.used !== undefined && usage.used >= adaptiveLimit(settings!, usage.max);
      if (!over && usage.compactions === 0) continue;
      const reason = usage.compactions > 0 ? "compaction" as const : "usage" as const;
      const share = usage.max && usage.used !== undefined ? Math.round((usage.used / usage.max) * 100) : null;
      const why = reason === "compaction" ? "Your context was compacted, so earlier details may be lost." : `Your context is about ${share}% full (${usage.used} of ${usage.max} tokens).`;
      await this.update(job.taskId, (r) => ({ ...r, sessions: r.sessions.map((s) => s.agentId === agentId ? { ...s, reminded: { reason, at: this.now(), ...(usage.used !== undefined ? { used: usage.used } : {}), ...(usage.max ? { max: usage.max } : {}) } } : s) }));
      await steer(agentId, reminderPrompt(why)).catch((e) => logFailure("Flowly could not send the context reminder:", e, job.taskId));
    }
  }

  /**
   * flowly_split: the session hands the rest of its work to fresh sessions with its own plan. Flowly keeps the plan as
   * progress.md (item sessions add their decisions there); the split starts when the session's turn ends.
   */
  async split(taskId: string, agentId: string, plan: string) {
    const record = await this.record(taskId);
    const session = record?.sessions.find((s) => s.agentId === agentId);
    if (!record || !session) throw new SplitRefused("This session is not an adaptive session of the card.");
    if (session.depth >= record.maxDepth) throw new SplitRefused(`This session already continues a split ${session.depth} level${session.depth === 1 ? "" : "s"} deep and cannot split again; finish your part.`);
    const progress = parseProgress(plan, record.maxItems);
    if (!progress.items.length) throw new SplitRefused(`The plan has no items. Write it in this format:\n\n${progressFormat}`);
    // The card's session budget covers what is queued, the new items and one more integrator.
    const queued = record.queue ? record.queue.items.length - record.queue.next : 0;
    if (record.sessions.length + queued + progress.items.length + 1 > record.maxSessions)
      throw new SplitRefused(`This card has used ${record.sessions.length} of its ${record.maxSessions} sessions${queued ? ` and ${queued} more are queued` : ""}, so it cannot split into ${progress.items.length} more; finish your part in this session.`);
    await writeFile(this.paths(taskId).progress, plan, { mode: 0o600 });
    const usage = this.paseo ? await this.observe(taskId, agentId, this.paseo).catch(() => null) : null;
    await this.update(taskId, (r) => ({ ...r, sessions: r.sessions.map((s) => s.agentId === agentId ? { ...s, split: { at: this.now(), items: progress.items.length, ...(usage?.used !== undefined ? { used: usage.used } : {}), ...(usage?.max ? { max: usage.max } : {}) } } : s) }));
    return { accepted: true, items: progress.items.map((i) => i.title), message: splitRecorded(progress.items.length) };
  }

  /**
   * A session's turn ended. A checkpoint with items starts the split: the next item goes to a fresh session; after the
   * last one, a fresh integrator. Otherwise the card is delivered (or the next queued item starts).
   */
  async afterTurn(taskId: string, agentId: string, settings: AutomationSettings, card: Card, paseo: PaseoApi): Promise<AdaptiveNext> {
    this.paseo = paseo;
    await this.observe(taskId, agentId, paseo).catch(() => undefined);
    const record = await this.record(taskId);
    const session = record?.sessions.find((s) => s.agentId === agentId);
    if (!record || !session) return { kind: "deliver", note: "" };
    await this.update(taskId, (r) => ({ ...r, sessions: r.sessions.map((s) => s.agentId === agentId ? { ...s, endedAt: this.now() } : s) }));
    const path = this.paths(taskId).progress;
    const text = session.split ? await readFile(path, "utf8").catch(() => "") : "";
    const progress = parseProgress(text, record.maxItems);
    if (session.split && progress.items.length) {
      // The new items come first; what was left of an earlier split follows them.
      const rest = record.queue ? record.queue.items.slice(record.queue.next) : [];
      const depth = session.depth + 1;
      await this.update(taskId, (r) => ({
        ...r,
        queue: { items: [...progress.items, ...rest], next: 0, depth, progress: { done: progress.done, decisions: progress.decisions, howToTest: progress.howToTest } },
        splits: [...r.splits, { at: this.now(), by: agentId, depth, reason: session.reminded ? `after a ${session.reminded.reason} reminder` : "on its own", items: progress.items.map((i) => i.title) }],
      }));
    }
    return this.next(taskId, card);
  }

  /** What follows: the next queued item, the integrator after the last item, or the delivery. */
  private async next(taskId: string, card: Card): Promise<AdaptiveNext> {
    const record = (await this.record(taskId))!;
    const path = this.paths(taskId).progress;
    const queue = record.queue;
    // Past the session budget nothing new starts: what is in the workspace is delivered (§5.6.3).
    if (queue && record.sessions.length >= record.maxSessions) {
      await this.update(taskId, (r) => ({ ...r, queue: undefined }));
      return { kind: "deliver", note: `The card used all ${record.maxSessions} sessions; ${queue.items.length - queue.next} split items were not started.` };
    }
    if (queue && queue.next < queue.items.length) {
      const index = queue.next;
      // The decisions are re-read: earlier item sessions append theirs to the file.
      const live = parseProgress(await readFile(path, "utf8").catch(() => ""), 1000);
      const progress = { ...queue.progress, decisions: live.decisions || queue.progress.decisions, items: queue.items };
      await this.update(taskId, (r) => ({ ...r, queue: { ...r.queue!, next: index + 1 }, pending: { role: "item", item: index + 1, depth: queue.depth } }));
      return { kind: "fresh", prompt: itemPrompt(card, progress, index, path, queue.depth < record.maxDepth), reason: `Item ${index + 1} of ${queue.items.length}: ${queue.items[index]!.title}` };
    }
    if (queue) {
      await this.update(taskId, (r) => ({ ...r, queue: undefined, pending: { role: "integrator", depth: queue.depth } }));
      return { kind: "fresh", prompt: integratorPrompt(card, await readFile(path, "utf8").catch(() => ""), path, queue.depth < record.maxDepth), reason: "Integration of the split items" };
    }
    return { kind: "deliver", note: "" };
  }

  /** The project's check after a delivery, in the workspace (§5.6.4). */
  async check(taskId: string, settings: AutomationSettings, cwd: string) {
    const check = settings.check!;
    const run = this.options.exec ?? runCommand;
    const { exit, output } = await run(check.command, cwd, (check.timeoutSec ?? adaptiveDefaults.checkTimeoutSec) * 1000);
    const ok = exit === 0;
    const tail = clip(output.slice(-4000), 4000);
    await this.update(taskId, (r) => ({ ...r, checks: [...r.checks, { at: this.now(), ok, exit, tail }].slice(-20) }));
    return { ok, exit, tail };
  }

  async delivered(taskId: string) { await this.update(taskId, (r) => ({ ...r, deliveredAt: this.now() })); }
}

function runCommand(command: string, cwd: string, timeoutMs: number) {
  return new Promise<{ exit: number | null; output: string }>((resolve) => {
    execFile("bash", ["-lc", command], { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`;
      if (!error) return resolve({ exit: 0, output });
      const code = (error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean }).code;
      resolve({ exit: typeof code === "number" ? code : (error as { killed?: boolean }).killed ? null : 1, output: `${output}${error.message ? `\n${error.message}` : ""}` });
    });
  });
}
