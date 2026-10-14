import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { Board, BoardEvent, Status } from "../shared/model";
import type { ToolIdentity } from "../shared/tools";

type Store = { event(board: Board, input: Omit<BoardEvent, "id" | "at">): unknown };

function bound(board: Board, identity: ToolIdentity) {
  const task = board.tasks.find(
    (t) => t.id === identity.taskId && t.workspaceId === identity.workspaceId,
  );
  const project = task && board.projects.find((p) => p.id === task.projectId);
  return task && project ? { task, project } : null;
}

/** Records a lifecycle fact for a Kanban-managed session's card. */
export function recordLifecycle(
  store: Store,
  board: Board,
  identity: ToolIdentity,
  action: "agent.turn_started" | "agent.turn_ended" | "agent.permission_requested",
  outcome?: PluginTurnOutcome,
) {
  const target = bound(board, identity);
  if (!target) return;
  store.event(board, {
    taskId: target.task.id,
    actor: "system",
    action,
    agentId: identity.agentId,
    ...(outcome ? { outcome: outcome.kind } : {}),
    ...(outcome?.kind === "failed" ? { note: outcome.error.message.slice(0, 500) } : {}),
  });
}

/** Statuses a new turn moves to In progress: starting, or continuing after review/blocker. */
const restartable: readonly Status[] = ["backlog", "todo", "in_review", "blocked"];

/**
 * Rule A1: a Kanban-managed session starting a turn means work is (re)starting.
 * Never touches finished/archived cards or projects that turned the rules off.
 */
export function applyTurnStarted(
  store: Store,
  board: Board,
  identity: ToolIdentity,
  sessionTitle: string | null,
  now = new Date(),
): boolean {
  const target = bound(board, identity);
  if (!target) return false;
  const { task, project } = target;
  if (
    task.archivedAt ||
    project.archivedAt ||
    project.autoStatus === false ||
    !restartable.includes(task.status)
  )
    return false;
  const from = task.status;
  task.status = "in_progress";
  task.revision++;
  task.updatedAt = now.toISOString();
  store.event(board, {
    taskId: task.id,
    actor: "system",
    action: "status_changed",
    agentId: identity.agentId,
    rule: "A1",
    from,
    to: "in_progress",
    note:
      from === "backlog" || from === "todo"
        ? `${sessionTitle || "A session"} started working`
        : `${sessionTitle || "A session"} resumed after a new message`,
  });
  return true;
}
