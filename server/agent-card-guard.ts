import type { Board, Project, Receipt, Task } from "../shared/model";
import type { ToolIdentity } from "../shared/tools";
import { parentOf } from "../shared/links";
import { automationOf } from "../shared/automation";
import { laneEnabled } from "../shared/lanes";
import { ToolError } from "./tool-error";

export interface AgentCardActor extends ToolIdentity {
  expectedRevision: { task: number; project: number };
  key: string;
  payloadHash: string;
  start: "now" | "later";
}

export const agentCardLimits = { perCard: 50, perLineage: 100 } as const;

/**
 * Rechecked before provisioning and in its commit, against the store's current board.
 * `revision: false` skips the signed-revision check: a request that was already reserved
 * passed it then, and a later change must not turn its workspace into an orphan.
 */
export function authorizeCardActor(board: Board, actor: AgentCardActor, { revision = true }: { revision?: boolean } = {}) {
  const task = board.tasks.find((t) => t.id === actor.taskId);
  const project = board.projects.find((p) => p.id === task?.projectId);
  if (!task || !project || task.workspaceId !== actor.workspaceId) throw new ToolError("SESSION_MISMATCH", "Card binding changed.");
  if (task.archivedAt || project.archivedAt) throw new ToolError("ARCHIVED", "Task or project is archived.");
  if (["done", "cancelled"].includes(task.status)) throw new ToolError("TASK_FINISHED", "A finished card cannot manage cards.");
  if (board.automation.some((j) => j.taskId === task.id && j.reviewerId === actor.agentId)) throw new ToolError("REVIEWER_ONLY", "Reviewer sessions may inspect the card and submit a review, not create or manage cards.");
  if (revision && (task.revision !== actor.expectedRevision.task || project.revision !== actor.expectedRevision.project)) throw new ToolError("REVISION_CONFLICT", "Card or project changed. Re-read before deciding again.");
  return { task, project };
}

/** The first card above `taskId` (sub-card links) that is cancelled, archived or gone: its tree was abandoned. */
export function abandonedAncestor(board: Pick<Board, "tasks" | "links">, taskId: string): { id: string; task?: Task } | null {
  const seen = new Set([taskId]);
  for (let id = parentOf(board.links, taskId); id && !seen.has(id); id = parentOf(board.links, id)) {
    seen.add(id);
    const task = board.tasks.find((t) => t.id === id);
    if (!task || task.archivedAt || task.status === "cancelled") return { id, task };
  }
  return null;
}

/**
 * Card creation (SUB-CARDS-SPEC §3): the actor's authority, a tree nobody abandoned (automation
 * would never run work under a cancelled or archived ancestor) and the creation budget.
 */
export function authorizeCardCreation(board: Board, actor: AgentCardActor, options: { revision?: boolean } = {}) {
  const found = authorizeCardActor(board, actor, options);
  const ancestor = abandonedAncestor(board, actor.taskId);
  if (ancestor)
    throw new ToolError(
      "ANCESTOR_FINISHED",
      `${ancestor.task ? `"${ancestor.task.title}" (${ancestor.id}), a card above this one, is ${ancestor.task.archivedAt ? "archived" : "cancelled"}` : `A card above this one (${ancestor.id}) is gone`}, so this card cannot create cards. Ask a person before continuing this work.`,
    );
  checkAgentCardBudget(board, actor.taskId);
  return found;
}

/**
 * A started card under automation is queued, and automation needs the In review lane to deliver it.
 * Projects saved before that rule may still lack it; refuse before any workspace exists.
 */
export function checkStartable(project: Project, start: AgentCardActor["start"]) {
  if (start === "now" && automationOf(project) && !laneEnabled(project, "in_review"))
    throw new ToolError(
      "STATUS_UNAVAILABLE",
      "Agent automation is on for this project but its In review lane is off, so a started card could never be delivered. Ask a person to turn the In review lane back on, or create the card with start=later.",
    );
}

/** The reservation a create_card request made before provisioning (its receipt, matched by key and payload). */
export const cardReservation = (board: Pick<Board, "agentReceipts">, actor: Pick<AgentCardActor, "key" | "payloadHash">): Receipt | undefined =>
  board.agentReceipts.find((r) => r.key === actor.key && r.payloadHash === actor.payloadHash && r.action === "create_card");

/** Kept on the request's receipt when its workspace exists but its card was not saved; reported until it is. */
export const orphanNotice = (workspaceId: string) =>
  `Workspace ${workspaceId} was created for this request but has no card yet: retry this same request to reuse it, or ask a person to link or archive it.`;

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
