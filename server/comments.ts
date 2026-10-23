import type { BoardStore } from "./store";
import { ToolError } from "./tool-error";
import { commentAction, type CommentInput } from "../shared/comments";
import type { BoardEvent } from "../shared/model";

/**
 * Records a person's comment on a card (CARD-COMMENTS-SPEC §4): one "commented"
 * event with the exact text. Only the board revision changes, like an agent's
 * progress note, so open forms and agents' signed requests stay valid. The same
 * operation id returns the event it wrote, also after the card was archived;
 * sending the comment to a session is the client's next step, apart from this.
 */
export function addComment(store: BoardStore, input: CommentInput): Promise<BoardEvent> {
  return store.transaction((board) => {
    const previous = board.events.find((e) => e.action === commentAction && e.operationId === input.operationId);
    if (previous) {
      if (previous.taskId !== input.taskId || previous.note !== input.text)
        throw new ToolError("REQUEST_REUSED", "This comment operation already recorded a different comment.");
      return { value: previous, changed: false };
    }
    const task = board.tasks.find((t) => t.id === input.taskId);
    if (!task) throw new ToolError("NOT_FOUND", "Card not found.");
    const project = board.projects.find((p) => p.id === task.projectId);
    if (task.archivedAt || !project || project.archivedAt)
      throw new ToolError("ARCHIVED", "This card or its project is archived, so it can't take comments.");
    const event = store.event(board, { taskId: task.id, actor: "human", action: commentAction, note: input.text, operationId: input.operationId });
    return { value: event, changed: true };
  });
}
