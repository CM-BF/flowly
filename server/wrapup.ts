import type { PaseoApi } from "@getpaseo/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BoardStore } from "./store";
import type { WrapupCheck, WrapupResult } from "../shared/rpc";

const execute = promisify(execFile);
type Git = (cwd: string, args: string[]) => Promise<string>;
const defaultGit: Git = async (cwd, args) =>
  (await execute("git", ["-C", cwd, ...args], { timeout: 10000, maxBuffer: 1 << 20 })).stdout;

async function workspaceSessions(paseo: PaseoApi, workspaceId: string) {
  const sessions: { id: string; status: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({
      filter: { includeArchived: false },
      page: { limit: 200, cursor },
    });
    for (const { agent } of page.entries)
      if (agent.workspaceId === workspaceId && !agent.archivedAt)
        sessions.push({ id: agent.id, status: agent.status });
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return sessions;
}

/** Explicit, user-confirmed cleanup of a finished card's Paseo resources. */
export class WrapupService {
  constructor(
    readonly store: BoardStore,
    readonly git: Git = defaultGit,
  ) {}

  async check(id: string, paseo: PaseoApi): Promise<WrapupCheck> {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === id);
    if (!task) throw new Error("Task not found.");
    const blockers: string[] = [],
      warnings: string[] = [];
    if (task.archivedAt) blockers.push("Card is already archived.");
    if (task.status !== "done" && task.status !== "cancelled")
      blockers.push("Only Done or Cancelled cards can be wrapped up.");
    const workspace = await paseo.workspaces.ref(task.workspaceId).refresh();
    const kind = workspace?.workspaceKind ?? null;
    const directory = workspace?.workspaceDirectory ?? null;
    if (workspace?.archivingAt) blockers.push("Workspace is being archived.");
    const sessions = workspace
      ? await workspaceSessions(paseo, task.workspaceId)
      : [];
    const active = sessions.filter(
      (s) => s.status === "running" || s.status === "initializing",
    ).length;
    if (active)
      blockers.push(
        `${active} session${active === 1 ? " is" : "s are"} still running. Stop or wait for ${active === 1 ? "it" : "them"} first.`,
      );
    let git: WrapupCheck["git"] = null;
    if (kind === "worktree" && directory) {
      try {
        const [branch, status] = await Promise.all([
          this.git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]),
          this.git(directory, ["status", "--porcelain"]),
        ]);
        // Commits reachable from no other local branch or remote, e.g. not yet
        // merged into main and not pushed. Merged work is not reported.
        const unpushed = await this.git(directory, [
          "rev-list", "--count", "HEAD", "--not",
          `--exclude=${branch.trim()}`, "--branches", "--remotes",
        ]);
        git = {
          branch: branch.trim(),
          uncommitted: status.split("\n").filter((line) => line.trim()).length,
          unpushed: Number.parseInt(unpushed.trim(), 10) || 0,
        };
        if (git.uncommitted)
          warnings.push(
            `${git.uncommitted} uncommitted change${git.uncommitted === 1 ? "" : "s"} in the worktree will be lost if Paseo removes it.`,
          );
        if (git.unpushed)
          warnings.push(
            `${git.unpushed} commit${git.unpushed === 1 ? "" : "s"} exist${git.unpushed === 1 ? "s" : ""} only on ${git.branch} (not merged or pushed elsewhere). The branch is kept.`,
          );
      } catch {
        warnings.push("Git status of the worktree could not be read.");
      }
    }
    return {
      taskId: task.id,
      revision: task.revision,
      workspace: workspace
        ? { id: task.workspaceId, kind: kind || "unknown", directory: directory || "" }
        : null,
      archiveWorkspace: kind === "worktree",
      sessions: sessions.length,
      git,
      blockers,
      warnings,
    };
  }

  async run(
    input: { id: string; revision: number; acknowledgeWarnings: boolean },
    paseo: PaseoApi,
  ): Promise<WrapupResult> {
    const check = await this.check(input.id, paseo);
    if (check.revision !== input.revision)
      throw new Error("Revision conflict: this card changed. Review the wrap-up again.");
    if (check.blockers.length)
      throw new Error(`Cannot wrap up: ${check.blockers.join(" ")}`);
    if (check.warnings.length && !input.acknowledgeWarnings)
      throw new Error(`Confirm the warnings first: ${check.warnings.join(" ")}`);
    let archivedSessions = 0,
      archivedWorkspace = false;
    const failures: string[] = [];
    if (check.workspace) {
      if (check.archiveWorkspace) {
        const result = await paseo.workspaces
          .archive(check.workspace.id)
          .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e), archivedAt: null }));
        if (result.error || !result.archivedAt)
          failures.push(`Workspace: ${result.error || "not archived"}`);
        else {
          archivedWorkspace = true;
          archivedSessions = check.sessions;
        }
      } else {
        for (const session of await workspaceSessions(paseo, check.workspace.id)) {
          try {
            await paseo.agents.ref(session.id).archive();
            archivedSessions++;
          } catch (e) {
            failures.push(`Session ${session.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
    if (failures.length)
      throw new Error(
        `Wrap-up incomplete; the card was not archived. ${archivedSessions} session(s) archived. Failed: ${failures.join("; ")}. Retry to continue.`,
      );
    const note = [
      `${archivedSessions} session(s) archived`,
      archivedWorkspace ? "worktree workspace archived" : "workspace kept",
      ...(check.warnings.length ? [`acknowledged: ${check.warnings.join(" ")}`] : []),
    ].join("; ");
    await this.store.mutate((board) => {
      const task = board.tasks.find((t) => t.id === input.id);
      if (!task) throw new Error("Task not found.");
      if (task.revision !== input.revision)
        throw new Error("Revision conflict: this card changed during wrap-up. Resources were archived; archive the card manually.");
      const now = new Date().toISOString();
      task.archivedAt = now;
      task.revision++;
      task.updatedAt = now;
      this.store.event(board, {
        taskId: task.id,
        actor: "human",
        action: "wrapped_up",
        note,
      });
    });
    return { archivedSessions, archivedWorkspace, note };
  }
}
