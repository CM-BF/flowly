import type { Board, BoardEvent } from "../shared/model";
import type { CommentInput, CommentRoute } from "../shared/comments";
import { handoffSource } from "./handoff-source";
import { ToolError } from "./tool-error";

export const commentSettled = (phase: CommentRoute["phase"]) => ["sent", "queued", "fresh", "saved"].includes(phase);
export function commentMode(input: CommentInput) {
  const base = input.whenRunning ?? "steer";
  return input.alternate ? base === "queue" ? "steer" as const : "queue" as const : base;
}
/** Called in the same authoritative transaction that accepts the commented event. */
export function reserveCommentRoute(board: Board, input: CommentInput, event: BoardEvent) {
  if (input.deliver === undefined) return false;
  const sourceId = handoffSource(`comment:${input.operationId}`), mode = commentMode(input), routes = board.commentRoutes ?? [];
  const previous = routes.find(r => r.taskId === input.taskId && r.sourceId === sourceId);
  if (previous) {
    if (JSON.stringify(previous.choice) !== JSON.stringify(input.deliver) || previous.mode !== mode) throw new ToolError("REQUEST_REUSED", "Retry this comment with its original recipient choice. A new instruction requires a new comment.");
    return false;
  }
  if (routes.filter(r => r.taskId === input.taskId && ["prepared", "pending", "sending"].includes(r.phase)).length >= 20)
    throw new ToolError("HANDOFF_PENDING", "Twenty comments still await dispatch. Keep the draft and resolve pending deliveries before retrying.");
  const settled = routes.filter(r => r.taskId === input.taskId && (commentSettled(r.phase) || r.phase === "failed"));
  const remove = new Set(settled.slice(0, Math.max(0, settled.length - 49)));
  const retained = routes.filter(r => !remove.has(r));
  if (retained.length >= 5000) throw new ToolError("HANDOFF_PENDING", "The routing receipt budget is full. Keep the draft before retrying.");
  const next: CommentRoute = { taskId: input.taskId, sourceId, eventId: event.id, messageId: `comment:${input.operationId}`, choice: input.deliver, mode, phase: "prepared", at: event.at };
  board.commentRoutes = [...retained, next]; return true;
}
