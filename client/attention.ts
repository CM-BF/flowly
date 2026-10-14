import type { Project, Task, BoardEvent } from "../shared/model";
import {
  sessionAttention,
  type AttentionAgent,
  type SessionReadReceipt,
} from "../shared/session-attention";

type Agent = AttentionAgent & { updatedAt?: string; createdAt?: string };

export type AttentionItem = {
  task: Task;
  project: Project;
  permissions: number;
  errors: number;
  unread: number;
  /** Set when exactly one session needs attention, so it can be opened directly. */
  sessionId: string | null;
  updatedAt: string;
};

/** Cards across all active projects whose sessions need a human. Running alone does not count. */
export function attentionItems(
  board: { projects: Project[]; tasks: Task[]; events: BoardEvent[] },
  agents: readonly Agent[],
  receipts: readonly SessionReadReceipt[],
  readUnavailable: boolean,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const task of board.tasks) {
    if (task.archivedAt) continue;
    const project = board.projects.find((p) => p.id === task.projectId);
    if (!project || project.archivedAt) continue;
    const flagged = agents
      .filter((a) => a.workspaceId === task.workspaceId && !a.archivedAt)
      .map((agent) => ({
        agent,
        state: sessionAttention(agent, task.id, receipts, board.events),
      }))
      .map(({ agent, state }) => ({
        agent,
        permission: state.permission,
        error: state.error,
        unread: !readUnavailable && state.unread && !state.permission && !state.error,
      }))
      .filter((s) => s.permission || s.error || s.unread);
    if (!flagged.length) continue;
    items.push({
      task,
      project,
      permissions: flagged.filter((s) => s.permission).length,
      errors: flagged.filter((s) => s.error).length,
      unread: flagged.filter((s) => s.unread).length,
      sessionId: flagged.length === 1 ? flagged[0].agent.id : null,
      updatedAt: flagged
        .map((s) => s.agent.updatedAt || "")
        .sort()
        .at(-1) || "",
    });
  }
  return items.sort(
    (a, b) =>
      Number(!!(b.permissions || b.errors)) - Number(!!(a.permissions || a.errors)) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

type AttentionBoard = Parameters<typeof attentionItems>[0];

/**
 * The one counting rule shared by the board Attention button and the sidebar badge.
 * Returns null while the board or agent list is unavailable (loading or failed).
 * Read receipts that are pending or failed only drop finished-but-unread sessions.
 */
export function attentionFromSources(sources: {
  board: AttentionBoard | null | undefined;
  agents: readonly Agent[] | null | undefined;
  receipts: readonly SessionReadReceipt[];
  readUnavailable: boolean;
}): AttentionItem[] | null {
  if (!sources.board || !sources.agents) return null;
  return attentionItems(sources.board, sources.agents, sources.receipts, sources.readUnavailable);
}

/** Badge text for a count; null hides the badge. */
export function attentionBadgeText(count: number | null | undefined): string | null {
  if (!count || count < 0) return null;
  return count > 99 ? "99+" : String(count);
}

/** Board screen params that open the Needs attention modal; the token makes each press distinct. */
export function attentionScreenParams(token: string) {
  return { view: "attention", open: token };
}

/** The open token when params ask for the Needs attention modal, else null. */
export function attentionOpenToken(params: Record<string, string> | undefined): string | null {
  return params?.view === "attention" && params.open ? params.open : null;
}

/** Provider/model/mode of the most recently created session in any card workspace. */
export function lastSessionSettings(
  agents: readonly {
    workspaceId?: string | null;
    archivedAt?: string | null;
    createdAt: string;
    provider: string;
    model: string | null;
    currentModeId?: string | null;
  }[],
  workspaceIds: ReadonlySet<string>,
) {
  const latest = agents
    .filter((a) => !a.archivedAt && !!a.workspaceId && workspaceIds.has(a.workspaceId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest
    ? { provider: latest.provider, model: latest.model || "", mode: latest.currentModeId || "" }
    : null;
}
