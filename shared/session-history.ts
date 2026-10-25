import { z } from "zod";

/** Derived excerpts, never a complete transcript. Budgets include UTF-8 JSON overhead. */
export const sessionHistoryLimits = { pageBytes: 8 * 1024, skeletonBytes: 2 * 1024 * 1024, lineBytes: 256 * 1024, chunkBytes: 64 * 1024, sourceBytes: 2 * 1024 ** 3, records: 200_000, entries: 10_000, queue: 16, subagentBytes: 200 * 1024, subagents: 32 } as const;
export const sessionHistoryRoleSchema = z.enum(["user", "assistant", "tool"]);
export const sessionHistoryQuerySchema = z.object({
  session: z.string().min(1).max(240),
  query: z.string().min(1).max(200).optional(),
  around: z.number().int().nonnegative().optional(),
  roles: z.array(sessionHistoryRoleSchema).min(1).max(3).optional(),
  limit: z.number().int().min(1).max(20).default(10),
  cursor: z.string().min(1).max(2048).optional(),
  /** Explicitly rebuild a stale snapshot. Ordinary polling never rescans an enlarged source. */
  rebuild: z.boolean().optional(),
});
export type SessionHistoryQuery = z.input<typeof sessionHistoryQuerySchema>;
export const sessionHistoryEntrySchema = z.object({
  ordinal: z.number().int().nonnegative(), at: z.string().max(80).optional(), relativeMs: z.number().optional(),
  role: sessionHistoryRoleSchema, text: z.string().max(2000), characters: z.number().int().nonnegative(), truncated: z.boolean(),
  tool: z.object({ name: z.string().max(100), category: z.enum(["exec", "file", "browser", "agent", "network", "other"]), arguments: z.string().max(300).optional(), outcome: z.string().max(300).optional() }).optional(),
  paths: z.array(z.string().max(240)).max(5).default([]),
  evidence: z.object({ source: z.string().max(100), from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), type: z.string().max(100) }),
});
export type SessionHistoryEntry = z.infer<typeof sessionHistoryEntrySchema>;
export const sessionHistoryGapSchema = z.object({ kind: z.string().max(80), count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative().optional() });
export const sessionHistoryPageSchema = z.object({
  session: z.string().max(240), status: z.enum(["building", "ready", "changed", "unavailable", "unsupported"]), message: z.string().max(400),
  snapshot: z.string().max(64).optional(), evidenceRef: z.string().max(300).optional(), builtAt: z.string().optional(),
  entries: z.array(sessionHistoryEntrySchema).max(20), nextCursor: z.string().max(2048).optional(), viewChanged: z.boolean().optional(),
  matches: z.number().int().nonnegative().optional(), omitted: z.number().int().nonnegative(),
  coverage: z.object({ sourceBytes: z.number().nonnegative(), readBytes: z.number().nonnegative(), through: z.number().nonnegative(), totalRecords: z.number().nonnegative(), indexedEntries: z.number().nonnegative(), omittedEntries: z.number().nonnegative(), skippedLines: z.number().nonnegative(), skippedBytes: z.number().nonnegative(), complete: z.boolean() }).optional(),
  gaps: z.array(sessionHistoryGapSchema).max(20),
  growth: z.array(z.object({ type: z.string().max(100), bytes: z.number().nonnegative(), lines: z.number().nonnegative() })).max(16).optional(),
});
export type SessionHistoryPage = z.infer<typeof sessionHistoryPageSchema>;
