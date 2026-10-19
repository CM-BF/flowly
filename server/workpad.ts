import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import type { BoardStore } from "./store";
import type { ToolIdentity } from "../shared/tools";
import type { GitHead, Workpad, WorkpadCheck } from "../shared/model";
import { planFromTimeline, workpadCheckedAction, workpadEnabled } from "../shared/workpad";

const execute = promisify(execFile);
export type Git = (cwd: string, args: string[]) => Promise<string>;
export const defaultGit: Git = async (cwd, args) =>
  (await execute("git", ["-C", cwd, ...args], { timeout: 5000, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout;

const shaPattern = /^[0-9a-f]{4,40}$/;

/** HEAD, branch and dirty state of a workspace; null when it is not a git repository or git fails (WORKPAD-SPEC §4.2). */
export async function readHead(dir: string, git: Git, now = new Date().toISOString()): Promise<GitHead | null> {
  try {
    const sha = (await git(dir, ["rev-parse", "--short=12", "HEAD"])).trim();
    if (!shaPattern.test(sha)) return null;
    const [branch, status] = await Promise.all([
      git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim(), () => ""),
      git(dir, ["status", "--porcelain"]).then((s) => s, () => ""),
    ]);
    return { sha, ...(branch && branch !== "HEAD" ? { branch } : {}), dirty: !!status.trim(), at: now };
  } catch {
    return null;
  }
}

/** The 12-character sha of a commit in the workspace repository, or null when it is not one (§5.1). */
export async function resolveCommit(dir: string, sha: string, git: Git): Promise<string | null> {
  const value = sha.trim().toLowerCase();
  if (!shaPattern.test(value)) return null;
  try {
    const out = (await git(dir, ["rev-parse", "--verify", "--quiet", "--short=12", `${value}^{commit}`])).trim();
    return shaPattern.test(out) ? out : null;
  } catch {
    return null;
  }
}

const sameHead = (a: GitHead | null, b: GitHead | null) =>
  (a?.sha || "") === (b?.sha || "") && (a?.branch || "") === (b?.branch || "") && !!a?.dirty === !!b?.dirty;

const refreshMs = 30_000;

/**
 * Human edits of a card's workpad, its HEAD refreshes and the plans read from
 * session timelines (WORKPAD-SPEC §2.2, §5.2, §6.3). None of these change the
 * task revision; human edits bump the workpad revision.
 */
export class WorkpadService {
  private refreshed = new Map<string, number>();
  constructor(
    readonly store: BoardStore,
    readonly git: Git = defaultGit,
    readonly clock = () => Date.now(),
  ) {}

  private async directory(workspaceId: string, paseo: PaseoApi) {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh().catch(() => null);
    return workspace?.workspaceDirectory || null;
  }

  async head(taskId: string, paseo: PaseoApi) {
    const task = (await this.store.read()).tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("Task not found.");
    const dir = await this.directory(task.workspaceId, paseo);
    return dir ? readHead(dir, this.git, new Date(this.clock()).toISOString()) : null;
  }

  /** Stores a changed HEAD; no event, only the board revision moves. */
  private async storeHead(taskId: string, head: GitHead | null) {
    return this.store.transaction((board) => {
      const workpad = board.workpads.find((w) => w.taskId === taskId);
      if (!workpad) return { value: null, changed: false };
      if (sameHead(workpad.head, head)) return { value: workpad.head, changed: false };
      workpad.head = head;
      return { value: head, changed: true };
    });
  }

  /** The drawer's Workpad section asks for a fresh HEAD; git runs at most once per card per 30 s. */
  async refresh(input: { taskId: string }, paseo: PaseoApi) {
    const board = await this.store.read();
    const workpad = board.workpads.find((w) => w.taskId === input.taskId);
    const task = board.tasks.find((t) => t.id === input.taskId);
    if (!workpad || !workpadEnabled(board.projects.find((p) => p.id === task?.projectId))) return { head: null };
    const last = this.refreshed.get(input.taskId) ?? 0;
    if (this.clock() - last < refreshMs) return { head: workpad.head };
    this.refreshed.set(input.taskId, this.clock());
    const head = await this.head(input.taskId, paseo).catch(() => workpad.head);
    await this.storeHead(input.taskId, head);
    return { head };
  }

  async check(input: WorkpadCheck, paseo: PaseoApi): Promise<Workpad> {
    if ((input.done === undefined) === (input.state === undefined)) throw new Error("Change either done or state.");
    if (input.section === "acceptance" ? input.done === undefined : input.state === undefined)
      throw new Error("Acceptance criteria take done; checks take state.");
    const stamp = input.state === "pass" || input.state === "fail" ? await this.head(input.taskId, paseo).catch(() => null) : null;
    return this.store.mutate((board) => {
      const { task, workpad } = editable(board, input.taskId);
      const now = new Date(this.clock()).toISOString();
      let note: string;
      if (input.section === "acceptance") {
        const item = workpad.acceptance.find((a) => a.id === input.itemId);
        if (!item) throw new Error("This item is no longer in the workpad.");
        item.done = input.done!;
        item.by = "human";
        item.at = now;
        note = `Acceptance: ${clip(item.text)} → ${item.done ? "met" : "not met"}`;
      } else {
        const item = workpad.validation.find((v) => v.id === input.itemId);
        if (!item) throw new Error("This item is no longer in the workpad.");
        item.state = input.state!;
        delete item.sha;
        delete item.dirty;
        delete item.ranAt;
        if (item.state !== "unrun") {
          if (stamp?.sha) item.sha = stamp.sha;
          if (stamp?.dirty) item.dirty = true;
          item.ranAt = now;
        }
        item.by = "human";
        item.at = now;
        if (stamp) workpad.head = stamp;
        note = `Check: ${clip(item.text)} → ${item.state}`;
      }
      touch(workpad, now);
      this.store.event(board, { taskId: task.id, actor: "human", action: workpadCheckedAction, note });
      return workpad;
    });
  }

  resolveConfusion(input: { taskId: string; itemId: string }): Promise<Workpad> {
    return this.store.mutate((board) => {
      const { task, workpad } = editable(board, input.taskId);
      const item = workpad.confusions.find((c) => c.id === input.itemId);
      if (!item) throw new Error("This item is no longer in the workpad.");
      workpad.confusions = workpad.confusions.filter((c) => c !== item);
      touch(workpad, new Date(this.clock()).toISOString());
      this.store.event(board, { taskId: task.id, actor: "human", action: workpadCheckedAction, note: `Confusion resolved: ${clip(item.text)}` });
      return workpad;
    });
  }

  /**
   * A Kanban-managed session finished a turn: keep its latest native todo list
   * as the card's plan, and refresh HEAD when checks have run (§2.2, §5.2).
   */
  async recordTurn(identity: ToolIdentity, timeline: readonly { type: string }[] | undefined, paseo: PaseoApi) {
    const items = planFromTimeline(timeline);
    const board = await this.store.read();
    // Off for the project: nothing is recorded (WORKPAD-SPEC §9).
    const task = board.tasks.find((t) => t.id === identity.taskId);
    if (!workpadEnabled(board.projects.find((p) => p.id === task?.projectId))) return;
    const ran = board.workpads.find((w) => w.taskId === identity.taskId)?.validation.some((v) => v.state !== "unrun");
    const head = ran ? await this.head(identity.taskId, paseo).catch(() => undefined) : undefined;
    if (items === undefined && head === undefined) return;
    await this.store.transaction((b) => {
      const task = b.tasks.find((t) => t.id === identity.taskId);
      if (!task || task.workspaceId !== identity.workspaceId) return { value: undefined, changed: false };
      let changed = false;
      if (items !== undefined) {
        const at = new Date(this.clock()).toISOString();
        const index = b.plans.findIndex((p) => p.taskId === task.id && p.agentId === identity.agentId);
        const previous = index >= 0 ? b.plans[index] : undefined;
        if (!items.length) {
          if (previous) {
            b.plans.splice(index, 1);
            changed = true;
          }
        } else if (!previous || JSON.stringify(previous.items) !== JSON.stringify(items)) {
          const plan = { taskId: task.id, agentId: identity.agentId, items, at };
          if (previous) b.plans[index] = plan;
          else b.plans.push(plan);
          changed = true;
        }
      }
      const workpad = b.workpads.find((w) => w.taskId === task.id);
      if (head !== undefined && workpad && !sameHead(workpad.head, head)) {
        workpad.head = head;
        changed = true;
      }
      return { value: undefined, changed };
    });
  }
}

const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

function editable(board: Awaited<ReturnType<BoardStore["read"]>>, taskId: string) {
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error("Task not found.");
  const project = board.projects.find((p) => p.id === task.projectId);
  if (task.archivedAt || project?.archivedAt) throw new Error("Archived cards can't be changed.");
  if (!workpadEnabled(project)) throw new Error("The workpad is turned off for this project.");
  const workpad = board.workpads.find((w) => w.taskId === taskId);
  if (!workpad) throw new Error("This card has no workpad.");
  return { task, workpad };
}

function touch(workpad: Workpad, now: string) {
  workpad.revision++;
  workpad.updatedAt = now;
  workpad.updatedBy = "human";
  delete workpad.agentId;
}
