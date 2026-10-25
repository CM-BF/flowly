import { z } from "zod";
import { cardHandoffSchema, handoffInputSchema } from "./handoff";
import { maxImages, outgoingImageSchema } from "./composer";

const id = z.string().min(1).max(200);
export const handoffGetInputSchema = z.strictObject({ handoff: z.literal("full").optional(), handoffCursor: z.string().max(4096).optional() });
export const handoffReadInputSchema = z.strictObject({ taskId: id, etag: z.string().optional(), cursor: z.string().max(4096).optional(), full: z.boolean().optional() });
export const handoffViewSchema = z.object({
  revision: z.number().int().nonnegative(), record: cardHandoffSchema,
  openIds: z.array(z.string()), openIdsTotal: z.number().int().nonnegative(),
  complete: z.boolean(), omitted: z.number().int().nonnegative(), truncatedIds: z.array(z.string()), fullRead: z.string(),
});
export const handoffPageSchema = z.object({
  taskId: id, revision: z.number().int(),
  items: z.array(z.object({ section: z.string(), id: z.string(), origin: z.enum(["current", "archive"]), value: z.unknown().optional(), text: z.string().optional(), field: z.enum(["text", "json"]).optional(), offset: z.number().int().optional(), complete: z.boolean() })),
  openIds: z.array(z.string()), openIdsTotal: z.number().int(), total: z.number().int(), omitted: z.number().int(),
  nextCursor: z.string().optional(), complete: z.boolean(), viewChanged: z.boolean().optional(),
});
export const handoffContextSchema = z.object({
  revision: z.number().int().nonnegative(), fresh: z.boolean(), due: z.array(z.string()),
  unavailable: z.string().optional(), staleSince: z.string().optional(),
  view: handoffViewSchema.optional(), page: handoffPageSchema.optional(),
  unchanged: z.boolean().optional(), ackRequired: z.boolean().optional(),
  currentAgentId: z.string().optional(), storageBytes: z.number().int().nonnegative().optional(),
  attachmentRoot: z.string().optional(),
});
export type HandoffContextView = z.infer<typeof handoffContextSchema>;
export const handoffInputRecordSchema = z.strictObject({
  taskId: id, workspaceId: id, agentId: id, messageId: id,
  text: z.string().max(20000), via: z.enum(["session", "comment", "launch", "run_again"]).default("session"),
  commentId: id.optional(), images: z.array(outgoingImageSchema).max(maxImages).optional(),
});
export type HandoffInputRecord = z.infer<typeof handoffInputRecordSchema>;
export const handoffInputConfirmSchema = z.strictObject({ taskId: id, workspaceId: id, agentId: id, messageId: id });
export const handoffNoteInputSchema = z.strictObject({ taskId: id, operationId: id, kind: z.enum(["direction", "incident", "environment", "other"]), text: z.string().min(1).max(2000) });
export const handoffInputDispositionSchema = z.strictObject({
  taskId: id, id, operationId: id, handoffRevision: z.number().int().nonnegative(),
  status: handoffInputSchema.shape.status.exclude(["received"]).optional(), standing: z.boolean().optional(), note: z.string().max(300).optional(),
});
export const handoffContinueSchema = z.strictObject({ taskId: id, agentId: id.optional(), fresh: z.boolean() });
