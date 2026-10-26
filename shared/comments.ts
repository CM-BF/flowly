import { z } from "zod";
import type { BoardEvent } from "./model";

/** Card comments (CARD-COMMENTS-SPEC): people write on a card; the daemon keeps each one as an event. */
export const commentAction = "commented";

export const commentLimits = {
  /** A comment is an event note, so it has the notes' bound (CARD-COMMENTS-SPEC §4). */
  text: 10000,
  /** Comments a card keeps. They do not count against its 100 other events, so automation noise never pushes them out. */
  perTask: 50,
  /** flowly_get_task: the latest comments; one this session already read is cut to `agentChars`. */
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
  /** Missing only for older clients, which still dispatch their own recorded comment. */
  deliver: z.union([z.enum(["auto", "fresh", "save"]), z.strictObject({ agentId: z.string().min(1).max(200) })]).optional(),
  whenRunning: z.enum(["steer", "interrupt", "queue"]).optional(),
  alternate: z.boolean().optional(),
});
export type CommentInput = z.infer<typeof commentInput>;

export const commentDeliverySchema = z.object({
  kind: z.enum(["sent", "queued", "pending", "fresh", "saved", "failed"]),
  agentId: z.string().optional(), reason: z.string().max(500).optional(), error: z.string().max(500).optional(),
});
export type RoutedCommentDelivery = z.infer<typeof commentDeliverySchema>;
/** Only routing references live on the board; the full original remains in the card handoff. */
export const commentRouteSchema = z.object({
  taskId: z.string(), sourceId: z.string().max(240), eventId: z.string(), messageId: z.string().max(240),
  choice: commentInput.shape.deliver.unwrap(), mode: z.enum(["steer", "interrupt", "queue"]).optional(),
  phase: z.enum(["prepared", "sending", "sent", "queued", "pending", "fresh", "saved", "failed"]),
  agentId: z.string().optional(), reason: z.string().max(500).optional(), error: z.string().max(500).optional(), at: z.string(),
});
export type CommentRoute = z.infer<typeof commentRouteSchema>;

/** A comment a person wrote on the card (the only kind there is). */
export const isComment = (event: Pick<BoardEvent, "action" | "actor">) => event.action === commentAction && event.actor === "human";

/** The card's comments, oldest first. */
export function commentsOf(events: readonly BoardEvent[], taskId: string): BoardEvent[] {
  return events.filter((e) => e.taskId === taskId && isComment(e));
}

/**
 * A long comment the session already read, as get_task repeats it: at most `max`
 * characters, the cut said in the text. Only read comments are cut, so the note
 * is true whether or not the comment was ever sent to this session.
 */
export function clipComment(text: string, max: number = commentLimits.agentChars) {
  if (text.length <= max) return text;
  const note = (shown: number) =>
    `\n[Comment shortened: the first ${shown} of ${text.length} characters. This session received the full text in an earlier flowly_get_task.]`;
  // The note's length depends on the number in it; settle it once.
  const shown = max - note(max).length;
  return text.slice(0, shown) + note(shown);
}

/**
 * flowly_get_task `comments` (CARD-COMMENTS-SPEC §3): the latest human comments,
 * oldest first. `lastRead`: when this session last read the card (none: it never
 * did). A comment written since is unread and comes in full; one it read before
 * is cut to `agentChars`.
 */
export function agentComments(events: readonly BoardEvent[], taskId: string, lastRead?: string) {
  return commentsOf(events, taskId)
    .slice(-commentLimits.agentCount)
    .map((e) => {
      const unread = !lastRead || e.at > lastRead;
      const text = e.note ?? "";
      return { id: e.id, at: e.at, text: unread ? text : clipComment(text), unread };
    });
}
