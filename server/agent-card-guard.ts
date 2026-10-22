import type { Board, Task } from "../shared/model";
import type { ToolIdentity } from "../shared/tools";
import { ToolError } from "./tool-error";

export interface AgentCardActor extends ToolIdentity {
  expectedRevision: { task: number; project: number };
  key: string;
  payloadHash: string;
  start: "now" | "later";
}

export const agentCardLimits = { perCard: 50, perLineage: 100 } as const;

/** Rechecked before provisioning and in its commit, against the store's current board. */
export function authorizeCardActor(board: Board, actor: AgentCardActor) {
  const task = board.tasks.find((t) => t.id === actor.taskId);
  const project = board.projects.find((p) => p.id === task?.projectId);
  if (!task || !project || task.workspaceId !== actor.workspaceId) throw new ToolError("SESSION_MISMATCH", "Card binding changed.");
  if (task.archivedAt || project.archivedAt) throw new ToolError("ARCHIVED", "Task or project is archived.");
  if (["done", "cancelled"].includes(task.status)) throw new ToolError("TASK_FINISHED", "A finished card cannot manage cards.");
  if (board.automation.some((j) => j.taskId === task.id && j.reviewerId === actor.agentId)) throw new ToolError("REVIEWER_ONLY", "Reviewer sessions may inspect the card and submit a review, not create or manage cards.");
  if (task.revision !== actor.expectedRevision.task || project.revision !== actor.expectedRevision.project) throw new ToolError("REVISION_CONFLICT", "Card or project changed. Re-read before deciding again.");
  return { task, project };
}

function lineage(tasks: readonly Task[], taskId: string): string {
  const seen = new Set<string>();
  let id = taskId;
  while (!seen.has(id)) {
    seen.add(id);
    const parent = tasks.find((t) => t.id === id)?.createdByAgent?.taskId;
    if (!parent) return id;
    id = parent;
  }
  return [...seen].sort()[0];
}

export function checkAgentCardBudget(board: Board, taskId: string) {
  const mine = board.tasks.filter((t) => t.createdByAgent?.taskId === taskId).length;
  const root = lineage(board.tasks, taskId);
  const total = board.tasks.filter((t) => t.createdByAgent && lineage(board.tasks, t.id) === root).length;
  if (mine >= agentCardLimits.perCard || total >= agentCardLimits.perLineage) throw new ToolError("CARD_LIMIT", "Agent card creation budget exhausted (50 per card, 100 across its creation lineage). Ask the user to create a new root card.");
}
