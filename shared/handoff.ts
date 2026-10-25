import { z } from "zod";
import { agentModelSchema } from "./agent-defaults";

/** At the hard current budget, even unresolved indexes may fill the file: reject new writes, never drop existing ids or original text. */
export const handoffLimits = { currentBytes: 1024 * 1024, pageBytes: 96 * 1024, agentCharacters: 16000, defaultCharacters: 24000, reviewerCharacters: 40000, warningBytes: 32 * 1024 * 1024, inlineBytes: 4096 } as const;
export const handoffSections = ["done", "next", "decisions", "ruledOut", "problems", "pitfalls", "running", "where", "env"] as const;
export type HandoffSection = typeof handoffSections[number];
export const handoffEntrySections = [...handoffSections, "notes", "gaps", "inputs", "questions", "reviews", "ledger"] as const;
export type HandoffEntrySection = typeof handoffEntrySections[number];
export const handoffActorSchema = z.object({ kind: z.enum(["agent", "human", "flowly"]), agentId: z.string().optional() });
export type HandoffActor = z.infer<typeof handoffActorSchema>;
const id = z.string().min(1).max(240);
const base = z.object({ id, rev: z.number().int().nonnegative(), at: z.string(), by: handoffActorSchema, sourceId: id.optional(), operationId: id.optional(), unconfirmed: z.boolean().optional(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), contentRef: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const text = (max: number) => z.string().max(max);
const noteKinds = ["incident", "direction", "environment", "hazard", "background", "checkpoint", "retired_turn", "other"] as const;
export const handoffInputSchema = base.extend({
  atSource: z.enum(["typed", "captured"]), via: z.enum(["session", "comment", "launch", "run_again", "composer", "retired_session", "agent"]),
  agentId: z.string().optional(), from: z.object({ agentId: z.string().optional(), title: text(120).optional() }).optional(), commentId: z.string().optional(), messageId: z.string().optional(),
  text: z.string().optional(), firstLine: text(160).optional(), textRef: z.string().regex(/^[a-f0-9]{64}$/).optional(), characters: z.number().int().nonnegative(), redacted: z.boolean().optional(), images: z.array(z.string()).max(6).optional(), imagesLost: z.number().int().nonnegative().optional(),
  standing: z.object({ by: handoffActorSchema, at: z.string() }).optional(), answers: z.array(id).optional(), status: z.enum(["open", "received", "done", "answered", "superseded", "declined"]),
  handled: z.object({ by: handoffActorSchema, at: z.string(), note: text(300).optional() }).optional(),
});
export const handoffQuestionSchema = base.extend({ kind: z.enum(["question", "blocker"]), text: text(10000), askedBy: z.string(), status: z.enum(["open", "answered", "withdrawn"]), answeredBy: z.array(id).max(5).optional(), note: text(300).optional() });
export const handoffReviewSchema = base.extend({
  cycle: z.number().int().nonnegative(), round: z.number().int().positive(), level: z.enum(["light", "standard", "deep"]).optional(), panel: z.boolean().optional(), reviewerId: z.string(), verdict: z.enum(["approve", "changes", "incomplete"]), summary: text(4000),
  findings: z.array(z.object({ id, text: text(1000), status: z.enum(["open", "done", "obsolete"]) })).max(20), risks: z.array(text(500)).max(10), gaps: z.array(text(300)).max(5),
  delivery: z.object({ event: z.string().optional(), text: text(10000) }).optional(),
});
export const handoffNoteSchema = base.extend({ kind: z.enum(noteKinds), text: text(2000) });
/** Flowly capture gaps are aggregated per session, kind and type hint: count, first/last occurrence. `resolution.count` is the count that was acknowledged; growth past it reopens the gap. */
export const handoffGapSchema = base.extend({ kind: z.enum(["reviewer", "successor", "answerer", "flowly"]).optional(), agentId: z.string().optional(), text: text(300), status: z.enum(["open", "closed"]), count: z.number().int().positive().optional(), firstAt: z.string().optional(), lastAt: z.string().optional(), resolution: z.object({ by: handoffActorSchema, at: z.string(), note: text(300).min(1), count: z.number().int().positive().optional() }).optional() });
export const handoffGitSchema = z.object({ repo: z.string(), sha: z.string().nullable(), branch: z.string().optional(), dirty: z.boolean(), dirtyHash: z.string().optional(), files: z.array(z.string()).max(50).optional(), filesTotal: z.number().int().nonnegative().optional(), diffstat: text(1000).optional(), upstream: z.string().optional(), at: z.string(), error: z.string().optional() });
export const handoffAckSchema = z.object({ handoffRevision: z.number().int().nonnegative(), heads: z.array(z.object({ repo: z.string(), sha: z.string().nullable(), dirty: z.boolean() })).max(8), understanding: text(800), items: z.array(z.object({ id, disposition: z.enum(["doing", "done", "obsolete", "ask"]), note: text(300).optional() })), questions: z.array(text(300)).max(5).optional() });
export type HandoffAck = z.infer<typeof handoffAckSchema>;
export const captureCursorSchema = z.object({ path: z.string(), identity: z.string(), offset: z.number().int().nonnegative(), size: z.number().int().nonnegative(), at: z.string(), lagBytes: z.number().int().nonnegative(), gaps: z.number().int().nonnegative(), skipped: z.number().int().nonnegative().optional(), resume: z.unknown().optional() });
export type CaptureCursor = z.infer<typeof captureCursorSchema>;
export const handoffSessionSchema = base.extend({
  agentId: z.string(), n: z.number().int().positive(), role: z.enum(["implementer", "reviewer", "manual", "other"]), provider: z.string(), model: z.string().optional(), launchModel: agentModelSchema.optional(), startedAt: z.string(), endedAt: z.string().optional(), reason: z.string(), endReason: z.string().optional(), finalized: z.boolean(), handoffRevisionAtEnd: z.number().int().optional(), abandoned: z.string().optional(), measured: z.object({ C: z.number().optional(), C0: z.number().optional(), W: z.number().optional(), B: z.number().optional(), S: z.number().optional(), K: z.number().optional(), turns: z.number().int().nonnegative(), peakC: z.number().optional() }).optional(), anchors: z.array(z.string()).max(60).optional(), growth: z.array(z.object({ kind: z.string(), calls: z.number().int().nonnegative(), bytes: z.number().nonnegative() })).max(12).optional(), nextMoves: z.array(text(300)).max(3).optional(), skeleton: z.string().optional(), /** Informational: script/workflow calls whose inner tool calls are not itemized; the raw session history holds them. Never an open item. */ scriptCalls: z.number().int().nonnegative().optional(), capturedThrough: z.number().int().optional(), through: captureCursorSchema.optional(),
  turns: z.array(z.object({ n: z.number().int(), startedAt: z.string(), endedAt: z.string().optional(), outcome: z.string(), final: text(2000).optional(), wroteHandoff: z.boolean() })).max(10).default([]),
  background: z.array(z.object({ id, callId: z.string().max(200).optional(), kind: z.enum(["async_shell", "exec_session", "browser_tab", "terminal", "script", "subagent", "schedule", "heartbeat"]), ref: z.string(), label: text(120), startedAt: z.string(), status: z.enum(["open", "closed", "unknown"]), /** How it ended (exit code, workflow status, settled by an ACK); older versions drop it. */ outcome: text(120).optional(), source: z.enum(["hook", "live", "skeleton"]) })).max(40).default([]),
  live: z.array(z.object({ at: z.string(), text: text(800), truncated: z.boolean().optional() })).max(8).default([]),
  ack: handoffAckSchema.extend({ at: z.string(), complete: z.boolean(), recordRevision: z.number().int().nonnegative().optional() }).optional(), understanding: text(800).optional(),
});
const sectionSchemas = {
  done: base.extend({ text: text(300), ref: text(200).optional() }),
  next: base.extend({ text: text(300), gate: text(200).optional() }),
  decisions: base.extend({ text: text(300), why: text(400).min(1), source: id.optional() }),
  ruledOut: base.extend({ text: text(300), why: text(400).min(1) }),
  problems: base.extend({ text: text(400), status: z.enum(["open", "resolved"]), note: text(300).optional() }),
  pitfalls: base.extend({ text: text(400) }),
  running: base.extend({ what: text(200), how: text(300), check: text(200), owner: z.string(), startedAt: z.string(), status: z.enum(["running", "done", "unknown"]), endedAt: z.string().optional(), result: text(300).optional() }),
  where: base.extend({ ref: text(300), what: text(200) }), env: base.extend({ text: text(300) }),
  inputs: handoffInputSchema, questions: handoffQuestionSchema, reviews: handoffReviewSchema, notes: handoffNoteSchema, gaps: handoffGapSchema, ledger: handoffSessionSchema,
} as const;
export const handoffEntrySchemas = sectionSchemas;
export const overflowEntrySchema = z.object({ section: z.enum(handoffEntrySections), id, rev: z.number().int(), at: z.string(), status: z.string(), firstLine: text(160), contentRef: z.string().regex(/^[a-f0-9]{64}$/), requirementsHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), sourceId: id.optional(), unconfirmed: z.boolean().optional(), operationId: id.optional(), openIds: z.array(id), cycle: z.number().int().optional(), round: z.number().int().optional(), verdict: z.string().optional() });
export const cardHandoffSchema = z.object({
  version: z.literal(1), taskId: id, projectId: id, revision: z.number().int().nonnegative(), updatedAt: z.string(), updatedBy: handoffActorSchema,
  checkpoint: z.object({ agentId: z.string(), at: z.string(), heads: z.array(z.object({ repo: z.string(), sha: z.string().nullable() })).optional(), dirtyHash: z.string().optional(), turnStartedAt: z.string().optional() }).optional(),
  state: base.extend({ text: text(1200) }).optional(),
  done: z.array(sectionSchemas.done), next: z.array(sectionSchemas.next), decisions: z.array(sectionSchemas.decisions), ruledOut: z.array(sectionSchemas.ruledOut), problems: z.array(sectionSchemas.problems), pitfalls: z.array(sectionSchemas.pitfalls), running: z.array(sectionSchemas.running), where: z.array(sectionSchemas.where), env: z.array(sectionSchemas.env),
  notes: z.array(handoffNoteSchema), gaps: z.array(handoffGapSchema), inputs: z.array(handoffInputSchema), questions: z.array(handoffQuestionSchema), reviews: z.array(handoffReviewSchema), ledger: z.array(handoffSessionSchema), git: z.array(handoffGitSchema).max(8),
  lastWords: z.object({ agentId: z.string(), at: z.string(), since: z.string(), text: text(2000) }).optional(),
  overflow: z.array(overflowEntrySchema).default([]), tombstones: z.array(z.object({ section: z.enum(handoffEntrySections), item: id, removedBy: handoffActorSchema, reason: text(200), at: z.string(), rev: z.number().int() })).default([]),
  archivedCount: z.number().int().nonnegative().default(0), seen: z.record(z.string(), z.number().int()).default({}), ops: z.array(id).max(50).default([]), pendingOperations: z.array(z.object({ id, sourceId: id, at: z.string() })).default([]),
});
export type CardHandoff = z.infer<typeof cardHandoffSchema>;
export type HandoffInput = z.infer<typeof handoffInputSchema>;
export type HandoffQuestion = z.infer<typeof handoffQuestionSchema>;
export type HandoffReview = z.infer<typeof handoffReviewSchema>;
export type HandoffNote = z.infer<typeof handoffNoteSchema>;
export type HandoffGap = z.infer<typeof handoffGapSchema>;
export type HandoffSession = z.infer<typeof handoffSessionSchema>;
export type HandoffEntry = { [K in HandoffEntrySection]: z.infer<typeof sectionSchemas[K]> }[HandoffEntrySection];
const handoffSetSchema = z.strictObject({
  section: z.enum(handoffSections), id: id.optional(), text: z.string().optional(), ref: z.string().optional(), why: z.string().optional(), source: id.optional(), gate: z.string().optional(), note: z.string().optional(),
  status: z.enum(["open", "resolved", "running", "done", "unknown"]).optional(), what: z.string().optional(), how: z.string().optional(), check: z.string().optional(), owner: z.string().optional(), startedAt: z.string().optional(), endedAt: z.string().optional(), result: z.string().optional(),
}).superRefine(({ section, ...fields }, ctx) => {
  const result = handoffEntrySchemas[section].safeParse({ ...fields, id: fields.id ?? "new", rev: 0, at: "", by: { kind: "agent" } });
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
});
export const handoffUpdateSchema = z.strictObject({
  handoffRevision: z.number().int().nonnegative(), operationId: id.optional(), state: text(1200).optional(),
  set: z.array(handoffSetSchema).max(30).optional(),
  remove: z.array(z.object({ section: z.enum(handoffSections), id, reason: text(200) })).max(30).optional(), order: z.object({ next: z.array(id).max(12) }).optional(),
  note: z.object({ kind: z.enum(noteKinds), text: text(2000) }).optional(),
  inputs: z.array(z.object({ id, status: z.enum(["done", "answered", "superseded", "declined", "open"]).optional(), standing: z.boolean().optional(), note: text(300).optional() })).max(30).optional(),
  questions: z.array(z.object({ id, status: z.enum(["answered", "withdrawn"]), answerInputIds: z.array(id).max(5).optional(), note: text(300).optional() })).max(10).optional(), ack: handoffAckSchema.optional(),
  gaps: z.array(z.union([
    z.strictObject({ text: text(300).min(1), status: z.literal("open") }),
    z.strictObject({ id, status: z.enum(["open", "closed"]), note: text(300).min(1) }),
  ])).max(10).optional(),
});
export type HandoffUpdate = z.infer<typeof handoffUpdateSchema>;
export function emptyHandoff(taskId: string, projectId: string): CardHandoff {
  return cardHandoffSchema.parse({ version: 1, taskId, projectId, revision: 0, updatedAt: "", updatedBy: { kind: "flowly" }, ...Object.fromEntries(handoffEntrySections.map((section) => [section, []])), git: [] });
}
export function agentCharacters(record: CardHandoff) {
  const sizes: Record<string, number> = { state: record.state?.text.length ?? 0 };
  for (const section of handoffSections) sizes[section] = record[section].reduce((total, entry) => total + Object.entries(entry).filter(([key]) => !["id", "rev", "at", "by", "sourceId", "operationId", "contentRef", "sourceHash"].includes(key)).reduce((sum, [, value]) => sum + (typeof value === "string" ? value.length : 0), 0), 0);
  return { used: Object.values(sizes).reduce((a, b) => a + b, 0), max: handoffLimits.agentCharacters, sections: sizes };
}
export function entryOpenIds(section: HandoffEntrySection, entry: HandoffEntry): string[] {
  const e = entry as unknown as Record<string, unknown>;
  if (e.unconfirmed) return [];
  if (section === "inputs") return e.status === "open" ? [entry.id] : [];
  if (section === "questions" || section === "gaps") return e.status === "open" ? [entry.id] : [];
  if (section === "running") return e.status !== "done" ? [entry.id] : [];
  if (section === "reviews") return (entry as HandoffReview).findings.filter((f) => f.status === "open").map((f) => f.id);
  if (section === "ledger") return (entry as HandoffSession).background.filter((b) => b.status !== "closed").map((b) => b.id);
  return [];
}
/** Internal complete set. A bounded transport page must label its subset/continuation instead of claiming completeness. */
export function handoffOpenIds(record: CardHandoff): string[] {
  const reviews = [...record.reviews, ...record.overflow.filter((e) => e.section === "reviews")].filter((e) => !e.unconfirmed);
  const cycle = Math.max(-1, ...reviews.map((r) => r.cycle ?? -1));
  const round = Math.max(-1, ...reviews.filter((r) => r.cycle === cycle).map((r) => r.round ?? -1));
  const currentReview = (entry: { cycle?: number; round?: number }) => entry.cycle === cycle && entry.round === round;
  const ids = handoffEntrySections.flatMap((section) => record[section].flatMap((entry) => section === "reviews" && !currentReview(entry as HandoffReview) ? [] : entryOpenIds(section, entry)));
  return [...new Set([...ids, ...record.overflow.flatMap((e) => e.unconfirmed || (e.section === "reviews" && !currentReview(e)) ? [] : e.openIds)])];
}
/** `supersededSnapshots`: archived ledger versions so far not returned because the next version holds the same history (Flowly observation snapshots); their bodies stay on disk under entries/. */
export type HandoffPage = { taskId: string; revision: number; items: { section: string; id: string; origin: "current" | "archive"; value?: unknown; text?: string; field?: "text" | "json"; offset?: number; complete: boolean }[]; openIds: string[]; openIdsTotal: number; total: number; omitted: number; supersededSnapshots?: number; nextCursor?: string; complete: boolean; viewChanged?: boolean };
export type HandoffWriteResult = { ok: true; handoffRevision: number; replayed?: boolean; at: string; budget: ReturnType<typeof agentCharacters>; open: { inputs: number; questions: number; findings: number; running: number; gaps: number }; handoffDue: string | null; ackMissing?: string[] };

export const handoffWriteResultSchema = z.object({ ok: z.literal(true), handoffRevision: z.number().int().nonnegative(), replayed: z.boolean().optional(), at: z.string(), budget: z.object({ used: z.number(), max: z.number(), sections: z.record(z.string(), z.number()) }), open: z.object({ inputs: z.number(), questions: z.number(), findings: z.number(), running: z.number(), gaps: z.number() }), handoffDue: z.string().nullable(), ackMissing: z.array(z.string()).optional() });
