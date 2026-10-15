import { z } from "zod";

const id = z.string().min(1).max(200);
export const queuedMessageSchema = z.object({ id: z.string(), text: z.string().min(1).max(20000), at: z.string() });
export const composerEntrySchema = z.object({
  taskId: id,
  draft: z.string().max(20000),
  draftAt: z.string().nullable(),
  queue: z.array(queuedMessageSchema).max(50),
  /** Last failure sending a queued message; cleared on the next success. */
  lastError: z.string().max(2000).nullable(),
});
export const composerStateSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), composerEntrySchema),
});
export type ComposerState = z.infer<typeof composerStateSchema>;
export type ComposerEntry = z.infer<typeof composerEntrySchema>;
export const composerTarget = z.strictObject({ taskId: id, agentId: id });
