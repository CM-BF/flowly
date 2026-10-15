import { appendFile, mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { flowEntry, flowEntrySchema, type FlowEntry } from "../shared/insights";
import type { Board, BoardEvent } from "../shared/model";

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, "-");
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * `flow/<projectId>.jsonl`: every board event, never trimmed (PROJECT-INSIGHTS-SPEC §2).
 * Writes are serialized; the board stays the source of truth and `reconcile`
 * appends whatever it holds that the log lacks.
 */
export class FlowLog {
  private tail: Promise<unknown> = Promise.resolve();
  /** Known ids per project, loaded on first use. */
  private known = new Map<string, Set<string>>();
  /** Deleted cards and removed projects: a stale board read must not bring them back. */
  private forgotten = new Set<string>();
  constructor(readonly directory: string) {}
  get folder() {
    return join(this.directory, "flow");
  }
  path(projectId: string) {
    return join(this.folder, `${safeId(projectId)}.jsonl`);
  }
  private queue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  /** Parsed entries; invalid lines are skipped, never rewritten away. */
  private async load(projectId: string): Promise<FlowEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path(projectId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const out: FlowEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = flowEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // skip a torn or invalid line
      }
    }
    return out;
  }
  private async ids(projectId: string) {
    let set = this.known.get(projectId);
    if (!set) {
      set = new Set((await this.load(projectId)).map((e) => e.id));
      this.known.set(projectId, set);
    }
    return set;
  }
  private async write(projectId: string, events: readonly FlowEntry[]) {
    const ids = await this.ids(projectId);
    if (this.forgotten.has(projectId)) return 0;
    const fresh = events.filter((e) => !ids.has(e.id) && !this.forgotten.has(e.taskId));
    if (!fresh.length) return 0;
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    await appendFile(this.path(projectId), fresh.map((e) => JSON.stringify(e) + "\n").join(""), { mode: 0o600 });
    for (const e of fresh) ids.add(e.id);
    return fresh.length;
  }
  /** Appends events committed to the board, grouped by their card's project. */
  append(events: readonly BoardEvent[], board: Pick<Board, "tasks">) {
    if (!events.length) return Promise.resolve(0);
    return this.queue(async () => {
      const project = new Map(board.tasks.map((t) => [t.id, t.projectId]));
      let written = 0;
      for (const [projectId, list] of group(events, (e) => project.get(e.taskId))) written += await this.write(projectId, list.map(flowEntry));
      return written;
    });
  }
  /** Adds board events the log does not have yet (first run backfill, missed appends). */
  reconcile(board: Pick<Board, "tasks" | "events">) {
    return this.append(board.events, board);
  }
  async read(projectId: string): Promise<FlowEntry[]> {
    await this.tail;
    return this.load(projectId);
  }
  /** Permanent card delete: rewrite the project's log without the card; its lines go to `removed/`. */
  removeTask(projectId: string, taskId: string, now = new Date()) {
    this.forgotten.add(taskId);
    return this.queue(async () => {
      const all = await this.load(projectId);
      const removed = all.filter((e) => e.taskId === taskId);
      if (!removed.length) return null;
      const removedFolder = join(this.directory, "removed");
      await mkdir(removedFolder, { recursive: true, mode: 0o700 });
      const backup = join(removedFolder, `task-${safeId(taskId)}-flow-${stamp(now)}.jsonl`);
      await writeFile(backup, removed.map((e) => JSON.stringify(e) + "\n").join(""), { mode: 0o600, flag: "wx" });
      const kept = all.filter((e) => e.taskId !== taskId);
      const temporary = `${this.path(projectId)}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, kept.map((e) => JSON.stringify(e) + "\n").join(""), { mode: 0o600 });
        await rename(temporary, this.path(projectId));
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      this.known.set(projectId, new Set(kept.map((e) => e.id)));
      return backup;
    });
  }
  /** Project Remove: the whole log moves to `removed/`. */
  removeProject(projectId: string, now = new Date()) {
    this.forgotten.add(projectId);
    return this.queue(async () => {
      this.known.delete(projectId);
      const removedFolder = join(this.directory, "removed");
      await mkdir(removedFolder, { recursive: true, mode: 0o700 });
      const backup = join(removedFolder, `${safeId(projectId)}-flow-${stamp(now)}.jsonl`);
      try {
        await rename(this.path(projectId), backup);
        return backup;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    });
  }
}

function group<T>(items: readonly T[], key: (item: T) => string | undefined) {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!k) continue;
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}
