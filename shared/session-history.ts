import { z } from "zod";

/** Derived excerpts, never a complete transcript. Budgets include UTF-8 JSON overhead. */
export const sessionHistoryLimits = { pageBytes: 8 * 1024, skeletonBytes: 2 * 1024 * 1024, lineBytes: 256 * 1024, chunkBytes: 64 * 1024, sourceBytes: 2 * 1024 ** 3, records: 200_000, entries: 10_000, queue: 16, subagentBytes: 200 * 1024, subagents: 32, entryChars: 4400 } as const;
/**
 * Head and tail characters an entry keeps, by level (SESSION-HANDOFF-SPEC §8.1). An index that would pass its byte or
 * entry budget is spent from the newest entry back: the newest calls and outputs keep level 0, older ones step down by
 * age (never messages), and the oldest leave the index. The omitted middle is located in the source by raw byte range.
 */
export const sessionHistoryExcerpts = {
  message: [{ head: 1500, tail: 500 }],
  arguments: [{ head: 3000, tail: 1000 }, { head: 1100, tail: 400 }, { head: 220, tail: 80 }],
  output: [{ head: 1500, tail: 1500 }, { head: 500, tail: 700 }, { head: 150, tail: 250 }, { head: 0, tail: 0 }],
} as const;
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
  role: sessionHistoryRoleSchema, text: z.string().max(sessionHistoryLimits.entryChars), characters: z.number().int().nonnegative(), truncated: z.boolean(),
  /** A call's arguments or a tool's output; `outcome` is its exit code or error. `arguments` was the 300-character preview of format 1. */
  tool: z.object({ name: z.string().max(100), category: z.enum(["exec", "file", "browser", "agent", "network", "other"]), kind: z.enum(["call", "output"]).optional(), arguments: z.string().max(300).optional(), outcome: z.string().max(300).optional() }).optional(),
  /**
   * The part of the text the excerpt leaves out: raw byte offsets in the source file (`evidence.source`) and its length in
   * decoded characters. Exact: the bytes are that JSON string's escaped middle. Otherwise (text that was decoded before
   * redaction, re-serialized arguments) the middle lies within those bytes.
   */
  middle: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), characters: z.number().int().nonnegative(), exact: z.boolean() }).optional(),
  /**
   * The text was JSON- or script-escaped and is shown decoded: stored so because a credential was only visible decoded,
   * or on this page only because the query matched its decoded form.
   */
  decoded: z.boolean().optional(),
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
  coverage: z.object({ sourceBytes: z.number().nonnegative(), readBytes: z.number().nonnegative(), through: z.number().nonnegative(), totalRecords: z.number().nonnegative(), indexedEntries: z.number().nonnegative(), omittedEntries: z.number().nonnegative(), skippedLines: z.number().nonnegative(), skippedBytes: z.number().nonnegative(), complete: z.boolean(),
    /** The narrowest head plus tail characters a kept entry of each kind has (`sessionHistoryExcerpts`; the newest keep the widest). */
    excerpts: z.object({ message: z.number().int().nonnegative(), arguments: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).optional() }).optional(),
  gaps: z.array(sessionHistoryGapSchema).max(20),
  growth: z.array(z.object({ type: z.string().max(100), bytes: z.number().nonnegative(), lines: z.number().nonnegative() })).max(16).optional(),
});
export type SessionHistoryPage = z.infer<typeof sessionHistoryPageSchema>;
