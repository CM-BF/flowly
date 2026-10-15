import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { BoardStore } from "./store";
import type { BoardEvent } from "../shared/model";
import { paseoHome } from "./service";
import { isSummarizer } from "../shared/summary";

/** Paseo's answer to "can this archived workspace come back?". */
export type RecoveryState =
  | { kind: "recoverable"; workspaceId: string; workspaceName: string; action: string; branch: string | null }
  | { kind: "unavailable"; workspaceId: string; reason: string; message: string };

/** One short-lived daemon connection for a restore run. */
export interface RecoveryConnection {
  inspect(workspaceId: string): Promise<RecoveryState>;
  restore(workspaceId: string): Promise<void>;
  /** Archived sessions in the workspace. */
  archivedSessions(workspaceId: string): Promise<ArchivedSession[]>;
  /** Unarchives the session and reloads it from persistence (Paseo "refresh"). */
  reviveSession(agentId: string): Promise<void>;
  close(): Promise<void>;
}
export type ArchivedSession = { id: string; archivedAt: string; labels: Record<string, string> };
export interface WorkspaceRecovery {
  connect(): Promise<RecoveryConnection>;
}

/**
 * COMPAT(sdk-workspace-restore): the plugin SDK (`PaseoApi`) has no workspace
 * restore or session unarchive in @getpaseo/client 0.11.2, but the daemon
 * serves `workspace.recovery.inspect/restore` and agent refresh (which
 * unarchives). Until the SDK exposes them, open a short-lived local connection
 * the way the `paseo` CLI does: the address from `paseo.pid` and the local
 * credential file. The token is never logged. Replace with the SDK calls once
 * they exist (WORKSPACE-RESTORE-SPEC).
 */
export function daemonWorkspaceRecovery(home = paseoHome()): WorkspaceRecovery {
  return {
    async connect() {
      const lock = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")) as { listen?: unknown };
      const listen = typeof lock.listen === "string" ? lock.listen.trim().replace(/^tcp:\/\//, "") : "";
      if (!/^[\w.-]+:\d+$|^\[[\da-f:]+\]:\d+$/i.test(listen))
        throw new Error("The Paseo daemon address is not a local TCP endpoint.");
      const token = (await readFile(join(home, "local-credential"), "utf8").catch(() => "")).trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("The Paseo local credential is unavailable.");
      const client = new DaemonClient({
        url: `ws://${listen}/ws`,
        clientId: "paseo-ultra-kanban-restore",
        clientType: "cli",
        localCredential: () => token,
        reconnect: { enabled: false },
        connectTimeoutMs: 5000,
      });
      try {
        await client.connect();
        for (const method of ["inspectWorkspaceRecovery", "restoreWorkspace", "fetchAgents", "fetchAgent", "refreshAgent"] as const)
          if (typeof client[method] !== "function") throw new Error("This Paseo version cannot restore workspaces.");
      } catch (e) {
        await client.close().catch(() => undefined);
        throw e;
      }
      return {
        inspect: (id) => client.inspectWorkspaceRecovery(id) as Promise<RecoveryState>,
        restore: (id) => client.restoreWorkspace(id),
        async archivedSessions(workspaceId) {
          const found: ArchivedSession[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.fetchAgents({ filter: { includeArchived: true }, page: { limit: 200, cursor } });
            for (const { agent } of page.entries)
              if (agent.workspaceId === workspaceId && agent.archivedAt)
                found.push({ id: agent.id, archivedAt: agent.archivedAt, labels: agent.labels ?? {} });
            cursor = page.pageInfo.nextCursor ?? undefined;
          } while (cursor);
          return found;
        },
        async reviveSession(id) {
          try {
            await client.refreshAgent(id);
          } catch (e) {
            // Refresh unarchives before reloading; a session that never ran has
            // nothing to reload but is back all the same.
            const now = await client.fetchAgent(id).catch(() => null);
            if (!now || now.agent.archivedAt) throw e;
          }
        },
        close: () => client.close().catch(() => undefined),
      };
    },
  };
}

const finished = (status: string) => status === "done" || status === "cancelled";

/**
 * Whether the plugin itself archived this card's workspace and has not brought
 * it back since: a wrap-up that archived the workspace, or auto wrap-up.
 */
export function archivedByWrapup(events: BoardEvent[], taskId: string) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.taskId !== taskId) continue;
    if (e.action === "workspace_restored") return false;
    if (e.action === "workspace_auto_archived") return true;
    if (e.action === "wrapped_up" && /(^|; )workspace archived(;|$)/.test(e.note || "")) return true;
  }
  return false;
}

/**
 * Sessions archived by one of this card's wrap-ups: archived at the moment a
 * wrap-up ran (the event is recorded right after archiving, and re-archiving a
 * workspace re-stamps its sessions). Sessions the user archived at other times,
 * and summarizer children, stay archived.
 */
export function sessionsArchivedByWrapup(events: BoardEvent[], taskId: string, sessions: ArchivedSession[]) {
  const times = events
    .filter((e) => e.taskId === taskId && (e.action === "wrapped_up" || e.action === "workspace_auto_archived"))
    .map((e) => Date.parse(e.at));
  return sessions.filter((s) => {
    if (isSummarizer(s)) return false;
    const at = Date.parse(s.archivedAt);
    return times.some((t) => at >= t - 120_000 && at <= t + 5_000);
  });
}

/**
 * Moving a wrapped-up card out of Done/Cancelled brings its workspace back:
 * Paseo unarchives it in place, or recreates a removed worktree on its kept
 * branch, under the same workspace ID, and the sessions its wrap-up archived
 * come back too. Only workspaces the plugin archived, or that the card created,
 * are restored; shared ones (e.g. the project main) are never touched.
 */
export class WorkspaceRestoreService {
  constructor(
    readonly store: BoardStore,
    readonly recovery: WorkspaceRecovery = daemonWorkspaceRecovery(),
  ) {}

  private readonly runs = new Map<string, Promise<void>>();

  restoreAfterReopen(id: string): Promise<void> {
    const pending = this.runs.get(id);
    if (pending) return pending;
    const run = this.once(id).finally(() => this.runs.delete(id));
    this.runs.set(id, run);
    return run;
  }

  private async once(id: string) {
    const record = (action: string, note: string) =>
      this.store.mutate((board) => {
        if (board.tasks.some((t) => t.id === id))
          this.store.event(board, { taskId: id, actor: "system", action, note });
      });
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === id);
    if (!task || task.archivedAt || finished(task.status)) return;
    const wrapped = board.events.some(
      (e) => e.taskId === id && (e.action === "wrapped_up" || e.action === "workspace_auto_archived"),
    );
    const ours = archivedByWrapup(board.events, id);
    const owned = task.ownsWorkspace === true;
    if (!wrapped && !owned) return;
    let daemon: RecoveryConnection;
    try {
      daemon = await this.recovery.connect();
    } catch (e) {
      if (ours) await record("workspace_restore_skipped", `Could not reach Paseo: ${message(e)}`);
      return;
    }
    try {
      let state: RecoveryState;
      try {
        state = await daemon.inspect(task.workspaceId);
      } catch (e) {
        if (ours) await record("workspace_restore_skipped", `Could not reach Paseo: ${message(e)}`);
        return;
      }
      let restored: RecoveryState | null = null;
      if (state.kind === "recoverable") {
        // Someone else archived it: leave the workspace and its sessions alone.
        if (!ours && !owned) return;
        const current = (await this.store.read()).tasks.find((t) => t.id === id);
        if (!current || current.archivedAt || finished(current.status)) return;
        try {
          await daemon.restore(task.workspaceId);
        } catch (e) {
          await record("workspace_restore_skipped", `Restoring failed: ${message(e)}`);
          return;
        }
        restored = state;
      } else if (state.reason !== "workspace_not_archived") {
        if (ours) await record("workspace_restore_skipped", state.message);
        return;
      }
      const revive = sessionsArchivedByWrapup(
        (await this.store.read()).events,
        id,
        await daemon.archivedSessions(task.workspaceId).catch(() => []),
      );
      let revived = 0;
      const failed: string[] = [];
      for (const session of revive) {
        try {
          await daemon.reviveSession(session.id);
          revived++;
        } catch (e) {
          failed.push(`${session.id.slice(0, 8)}: ${message(e)}`);
        }
      }
      const sessions = [
        `${revived} session(s) restored`,
        ...(failed.length ? [`not restored: ${failed.join("; ")}`] : []),
      ].join("; ");
      if (restored)
        await record(
          "workspace_restored",
          `${restored.action === "restore" ? `Worktree recreated${restored.branch ? ` on branch ${restored.branch}` : ""} and workspace restored` : "Workspace restored"}; ${sessions}.`,
        );
      else if (revive.length) await record("sessions_restored", `${sessions}.`);
    } finally {
      await daemon.close();
    }
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
