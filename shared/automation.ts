import type { Board, BoardEvent, Project, Task } from "./model";
import { childrenOf, linksOf, parentOf } from "./links";
import { laneEnabled } from "./lanes";
import { executionModel, type AgentModel } from "./agent-defaults";
import {
  automationSettingsSchema,
  type AutomationCode,
  type AutomationJob,
  type AutomationSettings,
  type AutomationState,
  type ReviewLevel,
} from "./automation-schema";
import { levelRounds, panelDefaults, resolveReviewLevel, seatModel, seatOf } from "./review-levels";

export * from "./automation-schema";
export * from "./review-levels";

/** The project's automation settings with defaults filled in, or null while it is off. */
export function automationOf(project: Pick<Project, "automation"> | null | undefined): AutomationSettings | null {
  if (!project?.automation?.enabled) return null;
  return automationSettingsSchema.parse(project.automation);
}

export const jobOf = (board: Pick<Board, "automation">, taskId: string) => board.automation.find((j) => j.taskId === taskId);

/** States in which the job still drives its card. */
export const liveStates: readonly AutomationState[] = ["queued", "starting", "working", "needs_human", "waiting", "retry_wait", "reviewing"];
/** States that hold one of the project's running slots (Hermes counts claimed tasks the same way). */
export const slotStates: readonly AutomationState[] = ["starting", "working", "retry_wait", "reviewing"];
export const isLive = (job: Pick<AutomationJob, "state"> | undefined) => !!job && liveStates.includes(job.state);

/**
 * Every dispatcher, recovery and side effect uses the same current ownership gate. A project
 * without the In review lane (a configuration saved before automation required it) is frozen:
 * its jobs are neither dispatched nor closed until the lane is back (AUTOMATION-SPEC §10).
 */
export function automationAllowed(board: Pick<Board, "tasks" | "projects" | "links">, job: AutomationJob): boolean {
  const task = board.tasks.find((t) => t.id === job.taskId && t.projectId === job.projectId);
  const project = board.projects.find((p) => p.id === job.projectId);
  if (!task || task.archivedAt || ["done", "cancelled"].includes(task.status) || !project || project.archivedAt || !automationOf(project) || !laneEnabled(project, "in_review")) return false;
  const seen = new Set<string>();
  for (let id = parentOf(board.links, task.id); id && !seen.has(id); id = parentOf(board.links, id)) {
    seen.add(id);
    const parent = board.tasks.find((t) => t.id === id);
    if (!parent || parent.archivedAt || parent.status === "cancelled") return false;
  }
  return true;
}

/**
 * Whether someone moved the card after its job failed: a person dragging it back, a session's turn resuming it.
 * Automation's own move to Blocked (rule AUTO) is part of the failure. The daemon records it on the job
 * (`takenBack`) while the move is still in the card's history, which keeps only its newest events.
 */
export const failureTakenBack = (job: Pick<AutomationJob, "taskId" | "state" | "updatedAt" | "takenBack">, events: readonly Pick<BoardEvent, "taskId" | "action" | "rule" | "at">[]) =>
  job.state === "failed" && (!!job.takenBack || events.some((e) => e.taskId === job.taskId && e.action === "status_changed" && e.rule !== "AUTO" && e.at > job.updatedAt));

/** The session the job supervises right now. */
export const activeAgent = (job: Pick<AutomationJob, "role" | "implementerId" | "reviewerId">) =>
  job.role === "reviewer" ? job.reviewerId : job.implementerId;

/** One role/retirement gate for tools, hooks and card management. Never infer retirement from a title. */
export function automationSessionRole(board: Pick<Board, "automation">, agentId: string, taskId?: string, priorSessions: readonly { agentId: string; role: string; endedAt?: string }[] = []): { job: AutomationJob; role: "implementer" | "reviewer" | "retired" | "finalizing" } | null {
  for (const job of board.automation) {
    if (taskId && job.taskId !== taskId) continue;
    if (job.rotation?.fromAgentId === agentId && ["finalizing", "sealing"].includes(job.rotation.stage)) return { job, role: "finalizing" };
    if (job.rotation?.fromAgentId === agentId && job.rotation.stage === "creating") return { job, role: job.implementerId === agentId || job.reviewerId === agentId ? "finalizing" : "retired" };
    if (job.implementerId === agentId) return { job, role: "implementer" };
    if (job.reviewerId === agentId) return { job, role: "reviewer" };
    if (job.retired?.some((s) => s.agentId === agentId) || job.reviewers?.includes(agentId)) return { job, role: "retired" };
    if (taskId && priorSessions.some(s => s.agentId === agentId && !!s.endedAt && (s.role === "implementer" || s.role === "reviewer"))) return { job, role: "retired" };
  }
  return null;
}

/**
 * The job this session is the reviewer of, while that job runs or its delivery waits for the user.
 * The reviewer's turns are not work on the card, in its round or outside it (a person asking it about
 * its verdict): rule A1 must not pull the card out of In review, and the job is not taken over.
 */
/** Whether `agentId` is one of the job's reviewer sessions, the current one or an earlier one (`reviewers`). */
export const reviewsFor = (job: Pick<AutomationJob, "reviewerId" | "reviewers">, agentId: string) => job.reviewerId === agentId || !!job.reviewers?.includes(agentId);
/** Whether `agentId` reviews (or reviewed) automation of card `taskId` and is not its implementer: it reports findings, it does not work the card. */
export const reviewerOfCard = (board: Pick<Board, "automation">, taskId: string, agentId: string) =>
  board.automation.some((j) => j.taskId === taskId && reviewsFor(j, agentId) && agentId !== j.implementerId);
export const reviewerJob = (board: Pick<Board, "automation">, agentId: string) =>
  // Older jobs could carry one session in both roles; that session is the implementer.
  board.automation.find((j) => reviewsFor(j, agentId) && agentId !== j.implementerId && (isLive(j) || j.state === "delivered"));

/** The delivery the job's latest verdict was given on (jobs recorded before `reviewedEvent` existed: a verdict judged `deliveryEvent`). */
export const judgedDelivery = (job: Pick<AutomationJob, "reviewedEvent" | "deliveryEvent" | "verdict">) =>
  job.reviewedEvent ?? (job.verdict ? job.deliveryEvent : undefined);

/** The delivery id of a review started on a card that reached In review without a delivery of the agent (a person moved it). */
export const arrivalDelivery = (endedAt: string) => `turn:${endedAt}`;
const isArrival = (id: string) => id.startsWith("turn:");

/**
 * The implementer's newest delivery: its latest status event to In review while the card's history (the newest
 * 100 events per card) still has it, else the one recorded on the job when that delivery was written (`latestDelivery`).
 */
export function newestDelivery(board: Pick<Board, "events">, job: Pick<AutomationJob, "taskId" | "latestDelivery">, agentId: string | undefined) {
  for (let i = board.events.length - 1; agentId && i >= 0; i--) {
    const e = board.events[i];
    if (e.taskId === job.taskId && e.agentId === agentId && e.actor === "agent" && e.to === "in_review") return e.id;
  }
  return job.latestDelivery;
}

/**
 * Whether the implementer's turn ended on the delivery the latest verdict judged: a casual answer, nothing new.
 * A delivery the agent made this turn is always new. A review the card reached without a delivery of the agent
 * (`turn:` ids) is only matched by a turn that rule A1r put back in In review, and so is a verdict whose delivery
 * is unknown (jobs recorded before `latestDelivery` existed); any other arrival in In review is new.
 */
function onJudgedDelivery(board: Pick<Board, "events">, job: AutomationJob, agentId: string) {
  const turn = thisTurn(board, job.taskId, agentId);
  if (turn.some((e) => e.actor === "agent" && e.to === "in_review")) return false;
  const restored = turn.some((e) => e.action === "status_changed" && e.rule === "A1r" && e.to === "in_review");
  const delivery = newestDelivery(board, job, agentId);
  const judged = judgedDelivery(job);
  if (delivery && judged) return delivery === judged && (!isArrival(judged) || restored);
  return !!job.verdict && (!!delivery || restored);
}

export type Readiness =
  | { ready: true }
  | { ready: false; reason: "missing" | "finished" }
  | { ready: false; reason: "blockers"; waiting: Task[]; cancelled: Task[] };

/**
 * Whether a queued card may start. A blocker releases its card only when it is
 * Done: Cancelled (or archived unfinished) work is not an input to build on, so
 * such a card waits until the user removes the link.
 */
export function readiness(board: Pick<Board, "tasks" | "links">, taskId: string): Readiness {
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task || task.archivedAt) return { ready: false, reason: "missing" };
  if (task.status === "done" || task.status === "cancelled") return { ready: false, reason: "finished" };
  const blockers = linksOf(board, task.id)
    .filter((v) => v.relation === "blocked_by" && v.other && v.other.status !== "done")
    .map((v) => v.other!);
  if (!blockers.length) return { ready: true };
  const cancelled = blockers.filter((b) => b.status === "cancelled" || b.archivedAt);
  return { ready: false, reason: "blockers", waiting: blockers.filter((b) => !cancelled.includes(b)), cancelled };
}

/** Claude Code's rejected-quota notices ("You've hit your session limit · resets 2pm (…)"), not its "close to" warnings. */
const claudeLimitPrefix = /^(?:You've (?:hit|reached|exceeded) your (?:(?:session|weekly|(?:Opus|Sonnet|Haiku|Fable)(?: weekly| usage)?|fast|usage(?: credit)?) )?(?:limit|allowance)|You're out of (?:extra usage|usage credits))(?=\s*(?:[.·]|$))/i;
/** Only explicit provider failure messages, never completed assistant prose. */
export const providerLimited = (message: string) =>
  /\b429\b|rate[ _-]?limit|quota (?:exceeded|exhausted|reached)|usage limit|overloaded|insufficient_quota|too many requests|\b(?:at|over) capacity\b|capacity (?:exceeded|reached)|try a different model/i.test(message) ||
  claudeLimitPrefix.test(message.trim());

/**
 * A provider limit inside a turn that ended "completed" (AUTOMATION-SPEC §4.5): Claude Code can finish a turn with its
 * API error or its quota notice as the last assistant row. `items`: the session's newest timeline items, oldest first.
 * Only rows after the latest user message count; prose that quotes a notice, tool calls and reasoning are no evidence.
 */
export function limitNotice(items: readonly unknown[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as { type?: unknown; text?: unknown; message?: unknown; isApiErrorMessage?: unknown } | null;
    if (!item || typeof item !== "object") continue;
    if (item.type === "user_message" || item.type === "turn_started") return null;
    if (item.type === "error") {
      const message = typeof item.message === "string" ? item.message : "";
      return providerLimited(message) ? message : null;
    }
    if (item.type === "assistant_message") {
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (!text) continue;
      const prefix = text.match(claudeLimitPrefix);
      const standalone = !!prefix && /^(?:\.?|\s*·\s*resets\s+[^·\r\n()]+\([A-Za-z0-9_+\-/]+\)(?:\s*·\s*progress saved)?)$/i.test(text.slice(prefix[0].length));
      const apiError = item.isApiErrorMessage === true || /^API Error\s*:/i.test(text);
      return (standalone || apiError) && providerLimited(text) ? text : null;
    }
    if (item.type === "tool_call" || item.type === "reasoning") return null;
  }
  return null;
}

/**
 * The outcome of a supervised turn whose end hook was missed (a plugin reload or restart during the turn), from the
 * daemon's own record of the session: an errored session, or the attention it raised when the turn finished or
 * failed after `since`. Null when the daemon kept nothing (someone read the session since): a person decides then.
 */
export function recoveredOutcome(
  agent: { status?: string | null; lastError?: string | null; attentionReason?: string | null; attentionTimestamp?: string | null },
  since: string | undefined,
): TurnOutcome | null {
  const failed = (): TurnOutcome => ({ kind: "failed", message: agent.lastError || "The session stopped with an error." });
  if (agent.status === "error") return failed();
  if (!agent.attentionTimestamp || (since && agent.attentionTimestamp <= since)) return null;
  if (agent.attentionReason === "error") return failed();
  if (agent.attentionReason === "finished") return { kind: "completed" };
  return null;
}

/** The model `role` switches to after a provider limit (§4.5), when the project set one. */
export const fallbackModel = (settings: AutomationSettings, role: AutomationJob["role"]) => (role === "reviewer" ? settings.reviewerFallback : settings.implementerFallback);
/**
 * A role's own model as far as the board knows it; the implementer can also come from a card's launch or the global
 * default. A reviewer session started for panel rounds (`job.panel`) runs on the panel model, one on a review level's
 * own model (`job.seat`, §5.2.3) on that one.
 */
export const primaryModel = (settings: AutomationSettings, project: Pick<Project, "agentModel"> | undefined, role: AutomationJob["role"], job?: Pick<AutomationJob, "panel" | "seat">) =>
  role === "reviewer" ? seatModel(settings, job ? seatOf(job) : undefined) : (settings.implementer ?? project?.agentModel ?? undefined);

/**
 * Provider history sizes (AUTOMATION-SPEC §4.6). Paseo reads a Codex session's whole history as one message when it
 * loads the session; around half a gigabyte that crashes the daemon's worker for every session on the host.
 * `rotate`: automation continues the card in a new session instead of sending this one another instruction, and
 * Flowly stops reading its timeline. `warn`: a running session past it is flagged on the card.
 */
export const historyLimits = { rotate: 200 * 2 ** 20, warn: 300 * 2 ** 20 } as const;

export function rotationNote(role: AutomationJob["role"], megabytes: number) {
  return `${tag} The previous ${role} session of this card grew a ${megabytes} MB provider history, too large for Paseo to load safely, so Flowly started this new session to take over. Continue from the current state of the card and the workspace (flowly_get_task, git status, git log); do not redo finished work. Keep tool output small: write screenshots, DOM dumps and logs to files instead of returning them through tools.`;
}

/**
 * The settings change for a panel choice in Edit project, or null when it changes nothing. Picking the default leaves
 * the key unstored (removes it), so boards stay readable by builds without panels (§5.1).
 */
export function panelChoice(settings: AutomationSettings, key: "panelAfter" | "panelSize", value: number | null): Partial<AutomationSettings> | null {
  const stored = settings[key];
  if (value === (key === "panelAfter" ? panelDefaults.after : panelDefaults.size)) return stored === undefined ? null : { [key]: undefined };
  return stored === value ? null : { [key]: value };
}
/** Whether no round of a cycle can be a panel round: it would start only after the last round (§5.1). */
export function panelOutOfReach(settings: Pick<AutomationSettings, "panelAfter" | "maxReviewRounds">) {
  const after = settings.panelAfter === undefined ? panelDefaults.after : settings.panelAfter;
  return after !== null && after >= settings.maxReviewRounds;
}
export const modelKey = (model: Pick<AgentModel, "provider" | "model">) => `${model.provider}/${model.model}`;
/** How long a limited model is avoided: new sessions start on their role's fallback, then try it again. */
export const fallbackHoldMs = 30 * 60_000;
/** Whether a recent limit was recorded for `model` (or its provider, when the limited model was not known). */
export function modelLimited(board: Pick<Board, "automation">, model: Pick<AgentModel, "provider" | "model">, now: number) {
  return board.automation.some(
    (job) =>
      [job.providerLimit, ...(job.heldLimits ?? [])].some(
        (limit) => !!limit && Date.parse(limit.until) > now && (limit.model ? limit.model === modelKey(model) : limit.provider === model.provider),
      ),
  );
}
/**
 * A failure of the host, not of the card's work (§4.4): another plugin's hook timed out while a session was created or
 * messaged, or a connection dropped. Retried with the cooldown backoff; it never uses up `failureLimit`.
 */
export const hostTransient = (message: string) => /Plugin RPC timed out|\bplugin [\w.-]+ before agent\.[\w.]+ failed\b|\bETIMEDOUT\b|\bECONNRESET\b|socket hang up/i.test(message);
/** Provider-limit retries before the job waits for a person; they never use up `failureLimit`. */
export const cooldownLimit = 5;
/** Wait before provider-limit retry n (1-based): 1, 2, 4, 8, then 15 minutes. */
export const cooldownDelayMs = (n: number) => Math.min(60_000 * 2 ** Math.max(0, n - 1), 900_000);

/**
 * Whether a job other than `except` is cooling down after a limit of `provider`. A provider nobody
 * knows (the asking side's or the cooling job's) is compared only within `projectId`: it never
 * holds back the cards of every project and provider.
 */
export function coolingProvider(board: Pick<Board, "automation">, provider: string | undefined, now: number, scope: { except?: string; projectId?: string } = {}) {
  return board.automation.some(
    (job) =>
      job.taskId !== scope.except &&
      job.state === "retry_wait" &&
      job.code === "cooldown" &&
      Date.parse(job.retryAt ?? "") > now &&
      (provider && job.provider ? job.provider === provider : scope.projectId !== undefined && job.projectId === scope.projectId),
  );
}
/**
 * Whether the project's next card would start on a cooling provider. A role with a fallback model on another,
 * uncooled provider is not held back (§4.5). `fallbackProvider`: the global default model's.
 */
export function providerCooling(board: Pick<Board, "automation" | "projects">, project: Project, now: number, fallbackProvider?: string) {
  const scope = { projectId: project.id };
  const settings = project.automation;
  const cooling = (provider: string | undefined) => coolingProvider(board, provider, now, scope);
  const held = (provider: string | undefined, fallback: AgentModel | undefined) => cooling(provider) && (!fallback || cooling(fallback.provider));
  const implementer = settings?.implementer?.provider ?? project.agentModel?.provider ?? fallbackProvider;
  return held(implementer, settings?.implementerFallback) || (!!settings?.reviewer && held(settings.reviewer.provider, settings.reviewerFallback));
}

const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

/**
 * One dispatcher pass (Hermes `dispatch`): per project with automation on, the
 * retries that are due and the queued cards that fit in the free slots, highest
 * priority and longest waiting first. Projects with automation off do nothing.
 * `fallbackProvider`: the global default model's provider, for projects that set none.
 */
export function dispatchPlan(board: Pick<Board, "projects" | "tasks" | "links" | "automation">, now: number, fallbackProvider?: string) {
  const start: AutomationJob[] = [],
    retry: AutomationJob[] = [];
  for (const project of board.projects) {
    const settings = automationOf(project);
    if (!settings || project.archivedAt) continue;
    const jobs = board.automation.filter((j) => j.projectId === project.id);
    retry.push(...jobs.filter((j) => automationAllowed(board, j) && j.state === "retry_wait" && (!j.retryAt || Date.parse(j.retryAt) <= now)));
    let free = providerCooling(board, project, now, fallbackProvider) ? 0 : settings.maxRunning - jobs.filter((j) => slotStates.includes(j.state)).length;
    const task = (j: AutomationJob) => board.tasks.find((t) => t.id === j.taskId);
    const candidates = jobs
      .filter((j) => j.state === "queued" && automationAllowed(board, j) && readiness(board, j.taskId).ready)
      .sort(
        (a, b) =>
          priorityRank[task(a)?.priority ?? "normal"] - priorityRank[task(b)?.priority ?? "normal"] ||
          a.queuedAt.localeCompare(b.queuedAt) ||
          a.taskId.localeCompare(b.taskId),
      );
    for (const job of candidates) {
      if (free <= 0) break;
      start.push(job);
      free--;
    }
  }
  return { start, retry };
}

/** Wait before retry n (1-based): 30 s, 60 s, 120 s … at most 5 minutes. */
export const retryDelayMs = (n: number) => Math.min(30_000 * 2 ** Math.max(0, n - 1), 300_000);

export type TurnOutcome = { kind: "completed" } | { kind: "failed"; message: string } | { kind: "canceled" };
export type TurnDecision =
  | { kind: "ignore" }
  /** The implementer delivered `delivery` (its status event; absent when the card reached In review without one): start the next review round on it. */
  | { kind: "review"; delivery?: string }
  /**
   * The implementer delivered and no (further) review runs: the user takes over. `unreviewed`: new
   * work no reviewer will judge, so an earlier verdict does not describe it.
   */
  | { kind: "deliver"; code?: AutomationCode; unreviewed?: true }
  /** The session waits for a person; its next turn resumes supervision. */
  | { kind: "wait"; code: AutomationCode }
  | { kind: "stop"; code: AutomationCode }
  | { kind: "nudge"; count: number }
  | { kind: "retry"; count: number; at: string; cooldown?: boolean }
  /** Limits exhausted. `blockCard`: the card moves to Blocked so it stops looking active. */
  | { kind: "give_up"; code: AutomationCode; blockCard: boolean }
  /** The implementer dispatched sub-cards that are still moving: wait for them (Multica's sub-issue wakeup). */
  | { kind: "await_children"; signature: string }
  /** A casual implementer turn during a review delivered nothing new: that review round goes on, it is not sent again. */
  | { kind: "resume_review" }
  /** The role's model reported a provider limit and the project set a fallback: a new session continues on it (§4.5). */
  | { kind: "fallback" };

/** `agentId`'s events since its latest turn started. */
function thisTurn(board: Pick<Board, "events">, taskId: string, agentId: string) {
  const mine = board.events.filter((e) => e.taskId === taskId && e.agentId === agentId);
  let start = mine.length;
  for (let i = mine.length - 1; i >= 0; i--)
    if (mine[i].action === "agent.turn_started") {
      start = i;
      break;
    }
  return mine.slice(start + 1);
}

/** Whether `agentId` asked the user something or reported a blocker during its latest turn. */
export const askedThisTurn = (board: Pick<Board, "events">, taskId: string, agentId: string) =>
  thisTurn(board, taskId, agentId).some((e) => e.reportKind === "question" || e.reportKind === "blocker");

/**
 * Whether the agent itself set the card to Blocked during its latest turn, also when it already was
 * (flowly_update_status records that as a progress report from and to Blocked). A card that is
 * Blocked for another reason (rule A1r restoring it after a silent turn, automation having
 * given up earlier) is not the agent asking for a person.
 */
export const blockedThisTurn = (board: Pick<Board, "events">, taskId: string, agentId: string) =>
  thisTurn(board, taskId, agentId).some((e) => e.actor === "agent" && (e.action === "status_changed" || e.action === "progress_reported") && e.to === "blocked");

/**
 * What a supervised session's turn end means (Hermes worker protocol): a
 * delivery hands over to review or to the user, a question or blocker waits for
 * a person, a silent end is nudged a bounded number of times, a failed turn is
 * retried with backoff, and exhausted limits give up. Turn ends of other
 * sessions are ignored.
 */
export function turnDecision(
  board: Pick<Board, "tasks" | "events" | "links" | "automation"> & { workpads?: Board["workpads"] },
  job: AutomationJob,
  agentId: string,
  outcome: TurnOutcome,
  settings: AutomationSettings,
  now: number,
): TurnDecision {
  if (!["starting", "working", "reviewing", "needs_human", "waiting"].includes(job.state) || activeAgent(job) !== agentId) return { kind: "ignore" };
  const task = board.tasks.find((t) => t.id === job.taskId);
  if (!task) return { kind: "ignore" };
  if (task.archivedAt || task.status === "done" || task.status === "cancelled") return { kind: "stop", code: "card_finished" };
  const reviewer = job.role === "reviewer";
  if (outcome.kind === "failed") {
    if (providerLimited(outcome.message)) {
      if (fallbackModel(settings, job.role) && !job.fallback?.[job.role]) return { kind: "fallback" };
      const count = (job.cooldowns ?? 0) + 1;
      return count > cooldownLimit ? { kind: "wait", code: "cooldown" } : { kind: "retry", count, cooldown: true, at: new Date(now + cooldownDelayMs(count)).toISOString() };
    }
    const count = job.failures + 1;
    if (count < settings.failureLimit) return { kind: "retry", count, at: new Date(now + retryDelayMs(count)).toISOString() };
    return reviewer ? { kind: "give_up", code: "review_incomplete", blockCard: false } : { kind: "give_up", code: "failed", blockCard: true };
  }
  if (outcome.kind === "canceled") return { kind: "wait", code: "interrupted" };
  if (reviewer) {
    // A verdict ends the review (submitReview moves the job on); the card leaving review is the user's doing.
    if (task.status !== "in_review") return { kind: "stop", code: "card_moved" };
    if (askedThisTurn(board, task.id, agentId)) return { kind: "wait", code: "question" };
  } else {
    if (task.status === "in_review") {
      // Nothing new since the latest verdict (a casual answer): the verdict still stands.
      if (onJudgedDelivery(board, job, agentId)) return { kind: "deliver" };
      if (!settings.reviewer) return { kind: "deliver", unreviewed: true };
      const delivery = newestDelivery(board, job, agentId);
      if (job.reopened && delivery && delivery === job.deliveryEvent && judgedDelivery(job) !== delivery) return { kind: "resume_review" };
      // Feedback after a delivery (or during its review) starts a new cycle: its rounds count from zero (§4.2).
      const rounds = job.reopened ? 0 : job.reviewRounds;
      // The cap of the level the next round would have (§5.2.3): a level changed mid-cycle applies from that round.
      const cap = levelRounds(settings, resolveReviewLevel(board, task).level);
      return rounds < cap ? { kind: "review", ...(delivery && !isArrival(delivery) ? { delivery } : {}) } : { kind: "deliver", code: "review_rounds" };
    }
    if (task.status === "blocked" && blockedThisTurn(board, task.id, agentId)) return { kind: "wait", code: "blocked" };
    if (askedThisTurn(board, task.id, agentId)) return { kind: "wait", code: "question" };
    const children = childrenOf(board.links, task.id);
    const motion = children.length ? motionOf(board, now) : undefined;
    if (motion && children.some((id) => motion.has(id))) return { kind: "await_children", signature: subCardSignature(board, task.id, motion) };
  }
  if (job.nudges < settings.nudgeLimit) return { kind: "nudge", count: job.nudges + 1 };
  return reviewer ? { kind: "give_up", code: "review_incomplete", blockCard: false } : { kind: "give_up", code: "no_delivery", blockCard: true };
}

/** The cards that move (`subCardActive`) on one board snapshot. */
export type Motion = ReadonlySet<string>;

/** How long a turn whose end was never recorded still counts as running: a missed hook must not hold a parent forever. */
export const openTurnMs = 6 * 3600_000;
/**
 * Cards with a Flowly-managed session in the middle of a turn, from the lifecycle facts the turn hooks record on
 * the card: whatever its automation job says, a person (or an agent) is working on it right now.
 */
export function cardsInTurn(board: Pick<Board, "events">, now: number): Set<string> {
  const latest = new Map<string, BoardEvent>();
  for (const event of board.events)
    if ((event.action === "agent.turn_started" || event.action === "agent.turn_ended") && event.agentId) latest.set(`${event.taskId}|${event.agentId}`, event);
  const open = new Set<string>();
  for (const event of latest.values()) if (event.action === "agent.turn_started" && now - Date.parse(event.at) < openTurnMs) open.add(event.taskId);
  return open;
}

/**
 * Every card still moving without its parent (SUB-CARDS-SPEC §5), on one board snapshot: an agent works on it,
 * waits for a person (a question, a blocker, a permission: the person answers it, not the parent), or is about to
 * start. A queued card held by blockers that are not Done moves only while one of them moves itself: a sibling
 * delivered to In review waits for this parent to accept it, and a blocker nobody runs (delivered, failed, stopped,
 * never run by automation) waits for a person. Either way the parent is told. An unfinished card also moves while
 * any of its own sub-cards moves, whatever its own job says: their work is its work. Walked backwards from the
 * cards that move by themselves through the cards their motion holds up and their parents, so each card and link
 * is visited once and a dependency cycle never moves on its own.
 */
export function motionOf(board: Pick<Board, "tasks" | "links" | "automation" | "events">, now = Date.now()): Motion {
  const inTurn = cardsInTurn(board, now);
  const tasks = new Map<string, Task>();
  for (const task of board.tasks) if (!tasks.has(task.id)) tasks.set(task.id, task);
  const jobs = new Map<string, AutomationJob>();
  for (const job of board.automation) if (!jobs.has(job.taskId)) jobs.set(job.taskId, job);
  const parents = new Map<string, string>();
  /** Each card's blockers that are not Done, and the cards each blocker holds. */
  const blockers = new Map<string, Task[]>();
  const holds = new Map<string, string[]>();
  for (const link of board.links) {
    if (link.kind === "subtask" && !parents.has(link.from)) parents.set(link.from, link.to);
    const blocker = link.kind === "blocks" && link.from !== link.to ? tasks.get(link.from) : undefined;
    if (!blocker || blocker.status === "done") continue;
    blockers.set(link.to, [...(blockers.get(link.to) ?? []), blocker]);
    holds.set(link.from, [...(holds.get(link.from) ?? []), link.to]);
  }
  const finished = (task: Task) => !!task.archivedAt || task.status === "done" || task.status === "cancelled";
  /** "self": moves by itself; "held": queued, moves only through a blocker; null: does not move. */
  const kinds = new Map<string, "self" | "held" | null>();
  const kind = (id: string) => {
    if (kinds.has(id)) return kinds.get(id)!;
    const task = tasks.get(id);
    const job = jobs.get(id);
    const waiting = blockers.get(id) ?? [];
    const value =
      !task || finished(task) ? null
      // A session working on the card moves it even when automation does not run it (a person took over a failed job).
      : !job || !isLive(job) ? (inTurn.has(id) ? "self" : null)
      : job.state !== "queued" || !waiting.length ? "self"
      : waiting.some((b) => b.status === "cancelled" || b.archivedAt) ? null
      : "held";
    kinds.set(id, value);
    return value;
  };
  const moving = new Set<string>();
  const next: string[] = [];
  const move = (id: string) => (moving.add(id), next.push(id));
  for (const id of tasks.keys()) if (kind(id) === "self") move(id);
  while (next.length) {
    const card = tasks.get(next.pop()!)!;
    for (const id of holds.get(card.id) ?? []) {
      if (moving.has(id) || kind(id) !== "held") continue;
      const parent = parents.get(id);
      if (parent && parents.get(card.id) === parent && card.status === "in_review") continue;
      move(id);
    }
    const parent = tasks.get(parents.get(card.id) ?? "");
    if (parent && !moving.has(parent.id) && !finished(parent)) move(parent.id);
  }
  return moving;
}

/** Whether a sub-card is still moving without its parent (`motionOf`); pass `motion` when asking about several cards of one snapshot. */
export const subCardActive = (board: Pick<Board, "tasks" | "links" | "automation" | "events">, id: string, motion: Motion = motionOf(board)) => motion.has(id);

/**
 * The sub-cards' state as the parent last saw it; a different value wakes the parent. A queued
 * sub-card also records whether it moves, which its blockers decide (one outside the parent's
 * tree can be cancelled or archived while the sub-card itself does not change).
 */
export function subCardSignature(board: Pick<Board, "tasks" | "links" | "automation" | "events">, parentId: string, motion?: Motion) {
  let known = motion;
  return childrenOf(board.links, parentId)
    .map((id) => {
      const task = board.tasks.find((t) => t.id === id);
      const job = jobOf(board, id);
      const held = job?.state === "queued" ? ((known ??= motionOf(board)).has(id) ? ":moving" : ":held") : "";
      // A sub-card moved by something other than its own job (a session outside automation, or its own sub-cards):
      // the end of that motion changes what the parent saw.
      const other = !isLive(job) && (known ??= motionOf(board)).has(id) ? ":moving" : "";
      return `${id}:${task?.archivedAt ? "archived" : (task?.status ?? "gone")}:${job?.state ?? ""}:${job?.verdict ?? ""}${held}${other}`;
    })
    .join("|");
}

/** A waiting parent wakes when none of its sub-cards is moving and they changed since it last looked. */
export function parentShouldWake(board: Pick<Board, "tasks" | "links" | "automation" | "projects" | "events">, job: AutomationJob, motion?: Motion) {
  if (job.state !== "waiting") return false;
  if (!automationAllowed(board, job)) return false;
  const project = board.projects.find((p) => p.id === job.projectId);
  const settings = automationOf(project)!;
  if (board.automation.filter((j) => j.projectId === job.projectId && slotStates.includes(j.state)).length >= settings.maxRunning) return false;
  const moving = motion ?? motionOf(board);
  if (childrenOf(board.links, job.taskId).some((id) => moving.has(id))) return false;
  return subCardSignature(board, job.taskId, moving) !== job.subSeen;
}

/** Provider modes that never stop for approval; unattended sessions use them when full access is on. */
export const unattendedModes: Readonly<Record<string, string>> = { claude: "bypassPermissions", codex: "full-access" };

/**
 * The execution settings an automation session starts with (AUTOMATION-SPEC §2): the role's model
 * inherits model settings from a same-provider project default; with Full access on, the
 * provider's no-approval mode overrides any Permissions the role or the project default chose.
 */
export function automationExecution(model: AgentModel, project: AgentModel | null | undefined, fullAccess: boolean): AgentModel {
  const settled = executionModel(model, project);
  const unattended = fullAccess ? unattendedModes[model.provider] : undefined;
  return unattended ? { ...settled, modeId: unattended } : settled;
}

// Messages the daemon sends to sessions. Agent-facing text stays English (I18N-SPEC).
export const automationTag = "[Flowly automation]";
export const isAutomationMessage = (text: string) => text.trimStart().startsWith(automationTag);
const tag = automationTag;
/** What makes a card Deep (§5.3.6): mistakes that are expensive to undo because other work or stored data depends on them. */
export const deepCriteria =
  "foundation work that later cards or stored data depend on: persistent storage formats of a long-lived system, schemas and protocols with other users, security and permission enforcement, data migrations, concurrency and crash recovery. A self-contained program verified by tests (a clone of a reference CLI, a parser, an emulator or hardware block, a benchmark task) is standard, even when it reads a file format, implements a protocol or runs concurrently.";
/** The unattended project's rule (§5.3.4): nobody answers, so automated sessions decide and deliver. */
export const unattendedNote =
  "This project runs unattended: nobody answers questions. Never ask or report a blocker (flowly_report_progress kind=question or blocker, status=blocked, or your own question tool): decide yourself, write down your assumptions and deliver. If part of the work cannot be done safely, deliver the rest and say in the note what you did not do and why.";
/** The implementer's part of acceptance-test review (§5.4.2); paths come from flowly_get_task.acceptance. */
export const acceptanceImplementerNote =
  "This project uses independent acceptance tests (§5.4): a separate session writes them from the card alone, without seeing your work. flowly_get_task's acceptance field gives their state, path and command (bash <suite>/run.sh <workspace>). Run them before you deliver and say in the delivery note what passed and failed. You may read and run them, but never edit, copy or game them; if a test contradicts the card, the card wins: explain it in the delivery note. The reviewer also runs tests you do not see, so meet the card itself, not only these tests. Keep scratch files and extra tests the card did not ask for out of the delivered paths.";
/** The reviewer's part of acceptance-test review (§5.4.2): tests are new information, the verdict needs evidence. */
export const acceptanceReviewerNote =
  "Acceptance tests (§5.4): flowly_get_task's acceptance field gives the visible suite, the reviewer-only holdout suite and requirements.md. When its state is ready, run both from a clean shell (bash <suite>/run.sh <workspace>, bash <holdout>/run.sh <workspace>), quote each command and the last lines of its output, and send the counts in flowly_submit_review acceptance { visible: { passed, failed }, holdout: { passed, failed } } (from each suite's final ACCEPTANCE line). Passing tests are necessary, not sufficient: in your summary give a table 'requirement → evidence' covering every explicit requirement and prohibition of the card and requirements.md, each with the check or command output that shows it; mark requirements without reliable evidence 'unverified' and list them in risks. verdict=changes only for a failing acceptance check (name it and quote its failure) or a violated explicit requirement or prohibition of the card you can show with evidence; never request changes on opinion or on edge cases the card does not ask for. verdict=approve only when both suites pass (a check that contradicts the card's text may fail: quote the card) and no requirement or prohibition is violated. A failing check that is itself wrong (it contradicts the card or itself) is the test's error, not the implementer's: never request changes for it and never ask anyone to change the tests (they belong to Flowly); quote the card, judge that requirement by the card, mark it unverified and note the faulty check in risks. Never put the holdout suite's path, file names or contents in your summary or findings: the implementer must not see them. If the state is writing or failed, review as above without the acceptance field.";
const lifecycle =
  `Follow the Flowly skill: read flowly_get_task, fix setup.missing, set the stage that matches the work, keep the workpad current. Meet every explicit requirement and prohibition in the card's description and comments; never add forbidden content, hard-code expected outputs, or edit tests or inputs to make checks pass. End by delivering with flowly_update_status status=in_review and a note on what changed, how you verified it and what you did not run; in a workspace without Git history, list every file you created, changed or deleted, since the reviewer has no diff. Make the delivery work where it will be used, not only in this session: for another unprivileged user, with its own directories read-only, without your caches, build products or environment variables; do not write into its own directories at import or run time or build it on first use unless the card asks for that. If flowly_get_task's workspace.kind is worktree, commit your changes on that worktree's branch before delivering: parents and dependent cards merge branches, so uncommitted work never reaches them. Any other workspace (directory) is the project root's own checkout with no branch of its own: leave your changes uncommitted there unless the card or the repository's rules ask for a commit. If the delivery returns WORKPAD_OPEN or SETUP_INCOMPLETE, fix what you can, then retry in this same turn with acknowledgeOpen=true and a note explaining each remaining item; do not end the turn on the refusal. A progress result (kind=result) does not end an automated turn. Doubt is not a reason to stop: if the task looks impossible, contradictory or wrong, test that conclusion first, then complete it on the most reasonable reading, deliver every required output, and state your doubts and the assumptions you chose in the delivery note. Ask with flowly_report_progress kind=question or set status=blocked with the reason only when only a person can unblock you (credentials, access, a decision only they can make) or going on would cause irreversible harm, then end your turn: nobody is watching this session live, so do not wait. If the card is too big for one session or has parts that can run in parallel, split it into sub-cards with flowly_create_card and end your turn; you are woken when they settle. In a directory workspace automated sub-cards share the project root and run one at a time, so split there only when a part needs its own session, not for speed. Give review_level=deep only to ${deepCriteria}`;

export function startPrompt(input: { review: boolean; again: boolean; unattended?: boolean; acceptance?: boolean }) {
  return [
    input.again
      ? `${tag} Flowly's agent automation queued this card again. Continue from the current state of the workspace and the card; do not redo work that is already done.`
      : `${tag} Flowly's agent automation started this session to work on this card unattended, from start to finish.`,
    lifecycle,
    input.review ? "After you deliver, a reviewer agent checks the work and may send you requested changes." : "",
    input.acceptance ? acceptanceImplementerNote : "",
    input.unattended ? unattendedNote : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function nudgePrompt(count: number, limit: number, role: AutomationJob["role"] = "implementer", unattended = false) {
  if (role === "reviewer") return `${tag} Your review ended without a verdict (reminder ${count} of ${limit}). Continue checking the delivery, then call flowly_submit_review verdict=approve or verdict=changes with concrete findings. You only review: do not edit files or change card status. ${reviewerDecides(unattended)}`;
  return `${tag} Your turn ended without a delivery${unattended ? "" : ", a question or a blocker"} (reminder ${count} of ${limit}). If the card is finished, deliver it now with flowly_update_status status=in_review. If the delivery returns WORKPAD_OPEN or SETUP_INCOMPLETE, fix what you can, then retry in this same turn with acknowledgeOpen=true and a note explaining each remaining item; do not end the turn on the refusal. If work remains, continue it; doubt is not a reason to stop: deliver on the most reasonable reading and state your assumptions in the note. ${unattended ? "Nobody answers questions in this project: do not ask or report a blocker." : "Ask with flowly_report_progress kind=question or set status=blocked with the reason only when only a person can unblock you."} If you are the reviewer, submit your verdict with flowly_submit_review. Without ${unattended ? "a delivery" : "one of these"} after the last reminder, automation stops.`;
}

/** Whether the delivery meets the card is the reviewer's call (§5.3.2); a person is asked only for what only they can give. */
function reviewerDecides(unattended: boolean) {
  return unattended
    ? "Whether the delivery meets the card is yours to decide, and nobody answers questions in this project: decide the verdict yourself."
    : "Whether the delivery meets the card is yours to decide, not a person's. Ask a person with flowly_report_progress kind=question only for what only they can give (credentials, access, an authorization, or a preference the card and comments leave open), then end your turn.";
}

export function retryPrompt(count: number, limit: number, error: string) {
  return `${tag} The last turn failed: ${error.slice(0, 300) || "unknown error"}. Continue from the current state of the workspace; do not repeat work that is already done (attempt ${count + 1} of ${limit}).`;
}

/** The retry after a provider limit (429, quota, overload): counted against the cooldown budget, not the failure limit. */
export function cooldownPrompt(count: number, error: string) {
  return `${tag} The last turn stopped at a provider limit: ${error.slice(0, 300) || "unknown error"}. Continue from the current state of the workspace; do not repeat work that is already done (provider limit retry ${count} of ${cooldownLimit}).`;
}

/** The first message's preamble for a session that takes over a role after `limited` reported a provider limit (§4.5). */
export function takeoverNote(role: AutomationJob["role"], limited: string) {
  return role === "reviewer"
    ? `${tag} The previous reviewer model (${limited}) stopped at a provider limit; you run this review round in its place.`
    : `${tag} The previous agent on this card (${limited}) stopped at a provider limit; you take over its work in the same workspace. Read flowly_get_task (workpad, progress notes, comments and activity) and inspect the workspace (git status, git diff, git log) to see what is already done, then continue from there to a delivery. Do not redo finished work.`;
}

/** Hermes sdlc-review lenses: each round looks at the work differently. */
const lenses = [
  "Lens for this round: the artifact. Read the diff cold before the delivery note, form your own judgment, then compare it with the note and investigate every mismatch.",
  "Lens for this round: execution. Run the build, the tests and the reported behavior yourself; verify each claim of the delivery instead of re-reading it.",
  "Lens for this round: the contract. Re-read the original card, its comments and its acceptance criteria and audit the delivery strictly against every requirement and prohibition in them, including every change requested in earlier rounds and in the comments.",
];

/** What each reviewer of a panel round focuses on (§5.1); a panel of n takes the first n. */
const panelFocuses = [
  "the artifact: read the diff cold before the delivery note, then investigate every mismatch with the note",
  "execution: run the build, the tests and the reported behavior, and verify each claim of the delivery",
  "the contract: every requirement and prohibition in the card's description and comments, the acceptance criteria and every change requested in earlier rounds",
  "integration and regressions: callers and users of the changed code, other cards' work, data and cleanup",
  "failure paths and safety: errors, races, retries, authorization and data loss",
];

/** What the design-and-scale reviewer of a Deep panel answers every round (AUTOMATION-SPEC §5.2.3). */
export const designQuestions = [
  "What does the stored data look like after 10,000 operations or six months, and does anything grow without bound?",
  "What does one operation cost, and does that cost grow with history?",
  "How is old data cleaned up, and can cleanup remove something still needed?",
  "How will the format or schema be upgraded?",
  "What happens if the process dies mid-operation?",
  "Which security or permission boundary does it touch?",
];

/**
 * The angles of a Deep panel, in this order (§5.2.3): contract, design and scale, failure and safety, then execution
 * and integration as one angle for a panel of four, split in two for a panel of five.
 */
const deepAngles = {
  contract:
    "contract and correctness: every requirement and prohibition in the card's description and comments, the acceptance criteria, every change requested in earlier rounds, and whether the code does what it claims on every input, not only the tested ones",
  design: `design and scale: answer each of these questions with evidence from the code (file and line), every round: ${designQuestions.map((q, i) => `(${i + 1}) ${q}`).join(" ")} A question the code cannot answer is a finding when it must block the delivery, else a risk`,
  failure:
    "failure, data safety and security: errors, crashes and restarts mid-operation, retries, races, partial writes, data loss, and every permission, credential or trust boundary the change touches",
  executionAndIntegration:
    "execution and integration: run the build, the tests and the reported behavior and verify each claim of the delivery; then check callers and users of the changed code, other cards' work, and upgrades from the data and versions already in use",
  execution: "execution: run the build, the tests and the reported behavior, and verify each claim of the delivery",
  integration: "integration and regressions: callers and users of the changed code, other cards' work, and upgrades from the data and versions already in use",
};
const deepFocuses = (reviewers: number) =>
  reviewers >= 5
    ? [deepAngles.contract, deepAngles.design, deepAngles.failure, deepAngles.execution, deepAngles.integration]
    : [deepAngles.contract, deepAngles.design, deepAngles.failure, deepAngles.executionAndIntegration].slice(0, reviewers);

/** Every round of every level asks for risks the acceptance criteria do not cover (§5.2.4). */
const risksRequest = [
  "Look beyond the acceptance criteria too: they may not cover everything that matters. Report the risks they do not cover in risks: data or memory that grows over time, a cost per operation that grows with history, cleanup of old data, upgrades of formats or schemas, recovery after failures and crashes, security and permissions, and interactions with other cards' work. In this card's changes and their realistic interactions, confirmed serious correctness, data safety, security or unbounded-growth problems are findings requiring changes even when the acceptance criteria omit them. Keep unconfirmed risks and out-of-scope improvements in risks. Do not expand review into unrelated code.",
  'Write each risk as one plain sentence saying what could go wrong, when, and how bad (for example: "The supported six-month workload has not been measured, so storage costs beyond the tested workload remain uncertain."). List every risk you still see: Flowly keeps only the latest list, shows it on the card and gives it to the parent card. Send at most 10 risks, each under 500 characters: merge related ones and keep the most serious. Risks never block approval; confirmed serious delivery blockers must be findings requiring changes, not entries in risks.',
].join(" ");

/** What every round checks whatever its lens (§5.3.1): the card's own requirements, the changed files, regressions. */
const audit =
  "Every round, whatever its lens: (1) list each explicit requirement and prohibition in the card's description and the people's comments (required outputs, files, formats and paths; must, must not, do not, never; inputs that must stay unchanged; tools or methods that are not allowed) and check the delivery against each one: the workpad's acceptance criteria were written by the implementer and may leave some out. (2) Inspect every file the delivery added, changed or deleted, tests, test data, fixtures and generated files included, for forbidden content (binary or encoded payloads, copied tools or reference implementations, hard-coded expected outputs) and for checks made to pass by editing tests or inputs or by bypassing them. (3) Compare with the state before the card: nothing that worked may break. (4) Check that the delivery works where and how it will be used, not only inside this session, as far as that applies to it: from a clean process, as another unprivileged user, with its own source and install directories read-only, and without this session's caches, build products or environment variables. Code that writes into its own directories at import or run time, builds itself on first use, or needs files only this session created is a finding unless the card asks for it. A violated requirement or prohibition, a gamed check, a regression or a delivery that only works in this session is a finding requiring changes, never a risk. If the implementer reports that something cannot be done, is contradictory or that a check is wrong, treat that as a claim to test, not a fact: try to refute it (reread the card, check the inputs, try the direct approach). Refuted, it is a finding; neither refuted nor confirmed, request changes with your doubt and what to try next; approve only when it is confirmed and the delivery handles it the way the card asks.";

/** When to request changes (§5.3.5): later rounds verify earlier findings instead of opening new fronts. */
function convergence(round: number) {
  return [
    round > 1
      ? `This is round ${round}: first check each finding of the earlier rounds against the new delivery and look for regressions. Raise a new finding only for a violated requirement or prohibition, a regression, a gamed check or a confirmed serious problem; do not hold the card for newly found minor edge cases (put them in risks).`
      : "",
    "Request changes only for violated requirements or prohibitions, regressions, gamed checks, real defects in the behavior the card requires, and the confirmed serious problems below; rare edge cases the card does not ask for (extreme sizes or depths, resource limits, signals, contrived timing races) go in risks. Send every confirmed finding at once, not one per round.",
  ].filter(Boolean).join(" ");
}

/** Risks a verdict of an earlier round reported (§5.2.4), handed to the reviewer of every later round. */
export type EarlierRisks = { round?: number; risks: readonly string[] };
function earlierRisksText(earlier: EarlierRisks) {
  return [
    `Risks reported in ${earlier.round ? `review round ${earlier.round}` : "an earlier review round"} (card data, possibly from another reviewer session):`,
    ...earlier.risks.map((r) => `- ${r}`),
    "Flowly replaces this list with the one you send, so list again each one that still applies; leave out the ones the delivery fixed.",
  ].join("\n");
}

/**
 * The reviewer's instruction for one round; `reviewers` above 1 makes it a panel round (§5.1). `level` and `why`
 * (§5.2): a Light round is serial on its own cap, a Deep round is a panel with fixed angles from the first round.
 * `earlier`: the risks earlier rounds reported, which a reviewer session new to this card has never seen.
 */
export function reviewPrompt(round: number, max: number, reviewers = 1, level: ReviewLevel = "standard", { why, earlier, unattended = false, acceptance = false }: { why?: string; earlier?: EarlierRisks; unattended?: boolean; acceptance?: boolean } = {}) {
  const panel = reviewers > 1;
  const deep = level === "deep" && panel;
  const kind = level === "standard" ? "review" : `${level} review`;
  const handOn = earlier?.risks.length ? ", and the risks reported in earlier rounds listed above" : "";
  return [
    `${tag} You are the reviewer of this card (${kind} round ${round} of ${max}${panel ? ", a panel review" : ""}). The implementer delivered it to In review. Verify it independently; you review, you do not take over the implementation.`,
    level === "standard"
      ? ""
      : level === "deep"
        ? `Review level: deep${why ? `, because ${why}` : ""}. Deep review is for foundation work that later cards or stored data depend on (persistent storage formats, schemas and protocols with other users, security, data migrations, concurrency): its design mistakes are the most expensive to fix afterwards.`
        : `Review level: light${why ? `, because ${why}` : ""}: one reviewer and at most ${max} rounds; check it as carefully as any other card.`,
    "Read flowly_get_task: the card, its workpad (acceptance criteria and checks), the people's comments (what they asked for counts like the card's requirements) and the delivery note in its activity. Inspect the actual changes in this workspace (git status, git diff, git log) and run the relevant checks. Without Git history there is no diff: find the changed files yourself (for example files modified since the card started) instead of relying on the delivery note alone.",
    earlier?.risks.length ? earlierRisksText(earlier) : "",
    panel
      ? [
          `${deep ? `This card gets a deep review, so every round, this one included, checks the delivery with ${reviewers} independent reviewers at once.` : `Earlier rounds of this cycle requested changes${round > 1 ? ` (${round - 1} so far)` : ""} or the project reviews every round this way, so this round checks the delivery with ${reviewers} independent reviewers at once instead of one more serial pass.`} Start them in parallel with your subagent tool, in the foreground, and wait for all of them in this same turn (in Claude Code: ${reviewers} Agent calls in one message, not in the background); do not end your turn before you call flowly_submit_review${unattended ? ": a turn that ends without it" : " (or ask a person, only for what only they can give): a turn that ends with neither"} counts as an unfinished review. One reviewer per focus:`,
          ...(deep ? deepFocuses(reviewers) : panelFocuses.slice(0, reviewers)).map((focus, i) => `${i + 1}. ${focus}.`),
          `Give each the card id, this workspace's path and its focus, plus what you read in flowly_get_task: the card's description word for word (its requirements and prohibitions), the acceptance criteria, the delivery note, every change requested in earlier rounds and the people's comments${handOn}. Tell it to check the requirements, the prohibitions and the added or changed files as described below, to report findings with file, problem and evidence, and risks the acceptance criteria do not cover as plain sentences; they only read and run checks, never edit files or call Flowly tools. If you cannot start subagents, review from each focus in turn yourself, independently. Then confirm each finding yourself (drop what you cannot reproduce or point to), merge duplicates and send every confirmed finding at once: the implementer gets one complete list instead of one problem per round. Merge the risks they report the same way: drop duplicates and keep the most serious, at most 10.`,
        ].join("\n")
      : lenses[Math.min(round, lenses.length) - 1],
    audit,
    acceptance ? acceptanceReviewerNote : "",
    convergence(round),
    risksRequest,
    `Then call flowly_submit_review exactly once: verdict=changes with concrete findings the implementer can act on (file, problem, expected fix), including the confirmed serious problems above even if the acceptance criteria omit them; verdict=approve only when the card's requirements and prohibitions and the acceptance criteria are met, the relevant checks pass, and no such confirmed findings remain unresolved. Do not edit files, commit, push or change the card status. ${reviewerDecides(unattended)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function changesPrompt(round: number, max: number, summary: string, findings: readonly string[], reviewers = 1, level: ReviewLevel = "standard", risks: readonly string[] = []) {
  return [
    `${tag} The ${reviewers > 1 ? `review panel (${reviewers} reviewers)` : "reviewer"} requested changes (${level === "standard" ? "" : `${level} `}review round ${round} of ${max}):`,
    summary,
    ...findings.map((f) => `- ${f}`),
    reviewers > 1
      ? "This is every problem the panel confirmed: fix all of them before you deliver, check each one against its finding, rerun the checks, update the workpad and deliver again with flowly_update_status status=in_review. If the delivery returns WORKPAD_OPEN or SETUP_INCOMPLETE, fix what you can, then retry in this same turn with acknowledgeOpen=true and a note explaining each remaining item; do not end the turn on the refusal."
      : "Fix them, rerun the checks, update the workpad and deliver again with flowly_update_status status=in_review. If the delivery returns WORKPAD_OPEN or SETUP_INCOMPLETE, fix what you can, then retry in this same turn with acknowledgeOpen=true and a note explaining each remaining item; do not end the turn on the refusal.",
    ...(risks.length
      ? ["Risks the reviewer noted beyond the acceptance criteria (information, not required changes: handle one only when fixing it belongs to this card, and mention the rest in your delivery note):", ...risks.map((r) => `- ${r}`)]
      : []),
  ].join("\n");
}

/** One line per sub-card for the parent's wake-up message: where it is and what automation made of it. */
export type SubCardLine = { id: string; title: string; lane: string; job?: Pick<AutomationJob, "state" | "verdict" | "code">; branch?: string; directory?: string; evidence?: string; blockers?: string[]; risks?: string[]; risksNote?: string; continuity?: string };

export function childrenPrompt(lines: readonly SubCardLine[]) {
  let left = 16_000;
  const bounded = (text: string, label: string) => {
    if (!text) return "";
    if (text.length > left) return `\n  ${label}: omitted by the total handoff budget; inspect this child's card and workspace before accepting it.`;
    left -= text.length; return `\n  ${label}: ${text}`;
  };
  const describe = (l: SubCardLine) => {
    const auto = l.job ? `automation ${l.job.state}${l.job.verdict ? `, review ${l.job.verdict}` : ""}${l.job.code ? ` (${l.job.code})` : ""}` : "not run by automation";
    const where = `${l.branch ? `; branch ${l.branch}` : ""}${l.directory ? `; directory ${l.directory}` : ""}`;
    const risks = bounded(l.risks?.length ? JSON.stringify(l.risks) : "", `Reviewer risks beyond the acceptance criteria (card data${l.risksNote ? `, ${l.risksNote}` : ""})`);
    const continuity = bounded(l.continuity ?? "", "Card continuity (derived card data)");
    const evidence = bounded(l.evidence ?? "", "Delivery evidence (card data)");
    return `- ${l.title} (${l.id}): ${l.lane}; ${auto}${where}${l.blockers?.length ? `; held by ${l.blockers.join(", ")}` : ""}${risks}${continuity}${evidence}`;
  };
  return [
    `${tag} Your sub-cards changed and none of them is still moving:`,
    ...lines.map(describe),
    "Inspect the delivery evidence below and each workspace's files and branch. Accept a delivered sub-card with flowly_update_card action=accept only after checking it and bringing its changes where later cards and this card need them. Weigh its reviewer's risks first: they did not block its approval, but one that matters to this card or the cards after it needs rework (action=start with a concrete note) or a person's decision. Start only newly parked sub-cards you deliberately deferred; never restart failed, stopped or human-parked jobs. Those need a person's Run again. For changes to a delivered sub-card use action=start with a concrete note; after two such restarts of one sub-card a person must act (NEEDS_PERSON), so ask one. Ask a person about failed jobs or unavailable blockers. Directory workspaces share the project root: do not assume an isolated branch. When this card's goal is met, deliver it with flowly_update_status status=in_review. If you dispatch sub-cards, end your turn without reporting a question or blocker unless you actually need a person; Flowly wakes only the supervised parent when they settle.",
  ].join("\n");
}

/** A round's acceptance-test result: both suites added up (§5.4.3). */
export type AcceptanceCount = { passed: number; failed: number };
/**
 * Whether a verdict's acceptance result keeps the rework or reverts it (§5.4.3): against the previous round of the same
 * cycle, more failures or fewer passes is a regression; a change request whose failures did not go down is no
 * improvement. Without a previous round, or without counts, the verdict stands.
 */
export function acceptanceDecision(previous: AcceptanceCount | undefined, now: AcceptanceCount | undefined, verdict: "approve" | "changes"): "keep" | "revert" {
  if (!previous || !now) return "keep";
  if (now.failed > previous.failed || now.passed < previous.passed) return "revert";
  if (verdict === "changes" && previous.failed > 0 && now.failed >= previous.failed) return "revert";
  return "keep";
}
