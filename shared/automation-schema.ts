import { z } from "zod";
import { agentModelSchema } from "./agent-defaults";

/**
 * Agent automation (AUTOMATION-SPEC): the Hermes Kanban dispatcher, worker
 * supervision and review loop, per project and off by default. Kept apart from
 * model.ts so the logic module can import the board types without a cycle.
 */
export const automationLimits = { maxRunning: 10, reviewRounds: 5, nudges: 5, failures: 5, detail: 500, summary: 4000, finding: 1000, findings: 10 } as const;
/** Restarts of a sub-card's delivered work by its parent's agent before a person must act (SUB-CARDS-SPEC §8). */
export const agentRestartLimit = 2;

/** A project's automation settings. Absent on a project means off. */
export const automationSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** Cards of this project an agent works on at once (Hermes `max_in_progress`). */
  maxRunning: z.number().int().min(1).max(automationLimits.maxRunning).default(2),
  /** The implementer's model; absent: the project's default model, then the global one, then the first available. */
  implementer: agentModelSchema.optional(),
  /** The reviewer's model; absent: no agent review, a delivery waits for the user. */
  reviewer: agentModelSchema.optional(),
  /** Reviews per delivery cycle before the card is left to the user (Hermes review rounds). */
  maxReviewRounds: z.number().int().min(1).max(automationLimits.reviewRounds).default(3),
  /** Sessions start in the provider's no-approval mode (claude bypassPermissions, codex full-access). */
  fullAccess: z.boolean().default(true),
  /** Reminders after a turn that ended without a delivery, a question or a blocker (Hermes stop nudges). */
  nudgeLimit: z.number().int().min(0).max(automationLimits.nudges).default(2),
  /** Consecutive failed turns before automation gives up (Hermes `failure_limit`). */
  failureLimit: z.number().int().min(1).max(automationLimits.failures).default(2),
});
export type AutomationSettings = z.infer<typeof automationSettingsSchema>;

export const automationStates = [
  /** Waiting for its blockers and a free slot. */
  "queued",
  /** Claimed: the session is being created or sent its first instruction. */
  "starting",
  /** The implementer session is supervised. */
  "working",
  /** The active session waits for a person: a question, a blocker, a permission or an interrupted turn. */
  "needs_human",
  /** The implementer handed work to sub-cards; it is woken when they stop moving (SUB-CARDS-SPEC §5). Holds no slot. */
  "waiting",
  /** A turn failed; the same session is told to continue at `retryAt`. */
  "retry_wait",
  /** The reviewer session is supervised. */
  "reviewing",
  /** Delivered to In review; the user decides what happens next. */
  "delivered",
  /** Stopped by the user or by a move of the card. */
  "stopped",
  /** Gave up: limits exhausted or the session became unavailable. */
  "failed",
] as const;
export type AutomationState = (typeof automationStates)[number];

/** Why a job is in its state; the client shows a translated label per code. */
export const automationCodes = [
  "question",
  "blocked",
  "permission",
  "interrupted",
  "stopped",
  "card_moved",
  "card_finished",
  "no_delivery",
  "failed",
  "start_failed",
  "session_unavailable",
  "review_rounds",
  "review_incomplete",
  "sub_cards",
  "cooldown",
] as const;
export type AutomationCode = (typeof automationCodes)[number];

/** One card's automation (one per card, replaced when it is queued again). */
export const automationJobSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  state: z.enum(automationStates),
  role: z.enum(["implementer", "reviewer"]),
  implementerId: z.string().optional(),
  reviewerId: z.string().optional(),
  /** +1 each time the card is queued; a session's operation id carries it. */
  generation: z.number().int().positive(),
  nudges: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  /** Reviews started since the card was queued or the user last gave feedback. */
  reviewRounds: z.number().int().nonnegative(),
  verdict: z.enum(["approved", "changes", "incomplete"]).optional(),
  code: z.enum(automationCodes).optional(),
  /** Daemon text (an error message, the reviewer's summary); English or the agent's words, never translated. */
  detail: z.string().max(automationLimits.detail).optional(),
  retryAt: z.string().optional(),
  /** Turn ends at or before this time are not this job's to handle (handled already, or older than its last instruction). */
  turnAt: z.string().optional(),
  /** The preparation of a session being created; after a restart the same id is created again, never a second one. */
  pendingOp: z.string().optional(),
  launchKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  launchConsumed: z.boolean().optional(),
  /** Session preparations belong to one role; they can never be reused by its peer. */
  pendingRole: z.enum(["implementer", "reviewer"]).optional(),
  /** An instruction survives reloads and send failures with its original payload and identity. */
  instruction: z.object({ id: z.string(), role: z.enum(["implementer", "reviewer"]), text: z.string(), fresh: z.string() }).optional(),
  /** The delivery (the agent's status event to In review) the latest review round looks at. */
  deliveryEvent: z.string().optional(),
  /**
   * The delivery the latest verdict (approved, changes, incomplete) was given on. A turn that ends on it
   * again delivered nothing new (a casual answer keeps the verdict); any other delivery is new work.
   */
  reviewedEvent: z.string().optional(),
  /**
   * The implementer's newest delivery as of its last judged turn (`turn:<time>` when the card reached In review
   * without one). The card's history keeps only its newest events; this is what a turn is compared with once
   * the delivery event itself is gone. Absent on jobs recorded before it existed.
   */
  latestDelivery: z.string().optional(),
  feedback: z.string().max(4000).optional(),
  /**
   * Times a parent card's agent queued this card again since a person last ran (Run again) or moved it.
   * Carried into the next generation by agent queues; beyond `agentRestartLimit` a person must act.
   */
  restarts: z.number().int().nonnegative().optional(),
  reopened: z.boolean().optional(),
  provider: z.string().optional(),
  cooldowns: z.number().int().nonnegative().optional(),
  /** What the sub-cards looked like when the parent last saw them (SUB-CARDS-SPEC §5); a change wakes it. */
  subSeen: z.string().max(20000).optional(),
  /** Someone moved the card after this job failed (not automation's own move to Blocked): it no longer asks for attention (AUTOMATION-SPEC §6). */
  takenBack: z.boolean().optional(),
  queuedAt: z.string(),
  startedAt: z.string().optional(),
  updatedAt: z.string(),
});
export type AutomationJob = z.infer<typeof automationJobSchema>;

/** flowly_submit_review: the reviewer's verdict (AUTOMATION-SPEC §5). */
export const reviewInputSchema = z.strictObject({
  verdict: z.enum(["approve", "changes"]),
  summary: z.string().trim().min(1).max(automationLimits.summary),
  findings: z.array(z.string().trim().min(1).max(automationLimits.finding)).max(automationLimits.findings).default([]),
});
export type ReviewInput = z.input<typeof reviewInputSchema>;
export const reviewResultSchema = z.object({
  accepted: z.boolean(),
  verdict: z.enum(["approve", "changes"]),
  replayed: z.boolean().optional(),
  message: z.string(),
});
