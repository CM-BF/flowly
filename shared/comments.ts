import { z } from "zod";
import type { BoardEvent } from "./model";

/** Card comments (CARD-COMMENTS-SPEC): people write on a card; the daemon keeps each one as an event. */
export const commentAction = "commented";

export const commentLimits = {
  /** A comment is an event note, so it has the notes' bound (CARD-COMMENTS-SPEC §4). */
  text: 10000,
  /** Comments a card keeps. They do not count against its 100 other events, so automation noise never pushes them out. */
  perTask: 50,
  /** flowly_get_task: the latest comments, each cut to this many characters. */
  agentCount: 20,
  agentChars: 4000,
} as const;

/** `tasks.comment`: the exact text; the same operation id returns the same event. */
export const commentInput = z.strictObject({
  taskId: z.string().min(1).max(200),
  text: z
    .string()
    .min(1)
    .max(commentLimits.text)
    .refine((text) => text.trim().length > 0, "Write a comment first."),
  operationId: z.string().min(1).max(200),
});
export type CommentInput = z.infer<typeof commentInput>;

/** A comment a person wrote on the card (the only kind there is). */
export const isComment = (event: Pick<BoardEvent, "action" | "actor">) => event.action === commentAction && event.actor === "human";

/** The card's comments, oldest first. */
export function commentsOf(events: readonly BoardEvent[], taskId: string): BoardEvent[] {
  return events.filter((e) => e.taskId === taskId && isComment(e));
}

/** A long comment as an agent reads it: at most `max` characters, the cut said in the text. */
export function clipComment(text: string, max: number = commentLimits.agentChars) {
  if (text.length <= max) return text;
  const note = (shown: number) => `\n[Comment truncated: the first ${shown} of ${text.length} characters. The full text was sent to the card's session when it was written.]`;
  // The note's length depends on the number in it; settle it once.
  const shown = max - note(max).length;
  return text.slice(0, shown) + note(shown);
}

/** flowly_get_task `comments`: the latest human comments, oldest first, each clipped (CARD-COMMENTS-SPEC §3). */
export function agentComments(events: readonly BoardEvent[], taskId: string) {
  return commentsOf(events, taskId)
    .slice(-commentLimits.agentCount)
    .map((e) => ({ id: e.id, at: e.at, text: clipComment(e.note ?? "") }));
}
