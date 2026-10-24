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
} from "./automation-schema";

export * from "./automation-schema";

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

/**
 * The job this session is the reviewer of, while that job runs or its delivery waits for the user.
 * The reviewer's turns are not work on the card, in its round or outside it (a person asking it about
 * its verdict): rule A1 must not pull the card out of In review, and the job is not taken over.
 */
/** Whether `agentId` is one of the job's reviewer sessions, the current one or an earlier one (`reviewers`). */
export const reviewsFor = (job: Pick<AutomationJob, "reviewerId" | "reviewers">, agentId: string) => job.reviewerId === agentId || !!job.reviewers?.includes(agentId);
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
 * default. A reviewer session started for panel rounds (`job.panel`) runs on the panel model.
 */
export const primaryModel = (settings: AutomationSettings, project: Pick<Project, "agentModel"> | undefined, role: AutomationJob["role"], job?: Pick<AutomationJob, "panel">) =>
  role === "reviewer" ? ((job?.panel && settings.panelReviewer) || settings.reviewer) : (settings.implementer ?? project?.agentModel ?? undefined);

/** Panel review (§5.1) when a project never chose: from the third round of a cycle, three reviewers. */
export const panelDefaults = { after: 2, size: 3 } as const;
/** How many reviewers check review round `round` of a cycle: 1 for a serial round, the panel size for a panel round. */
export function reviewersFor(settings: AutomationSettings, round: number) {
  const after = settings.panelAfter === undefined ? panelDefaults.after : settings.panelAfter;
  return after !== null && round > after ? (settings.panelSize ?? panelDefaults.size) : 1;
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
  board: Pick<Board, "tasks" | "events" | "links" | "automation">,
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
      return rounds < settings.maxReviewRounds ? { kind: "review", ...(delivery && !isArrival(delivery) ? { delivery } : {}) } : { kind: "deliver", code: "review_rounds" };
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
const lifecycle =
  "Follow the Flowly skill: read flowly_get_task, fix setup.missing, set the stage that matches the work, keep the workpad current. End by delivering with flowly_update_status status=in_review and a note on what changed, how you verified it and what you did not run. If you cannot continue without a person (a decision, credentials, access), ask with flowly_report_progress kind=question or set status=blocked with the reason, then end your turn: nobody is watching this session live, so do not wait and do not guess. If the card is too big for one session or has parallel parts, split it into sub-cards with flowly_create_card and end your turn; you are woken when they settle.";

export function startPrompt(input: { review: boolean; again: boolean }) {
  return [
    input.again
      ? `${tag} Flowly's agent automation queued this card again. Continue from the current state of the workspace and the card; do not redo work that is already done.`
      : `${tag} Flowly's agent automation started this session to work on this card unattended, from start to finish.`,
    lifecycle,
    input.review ? "After you deliver, a reviewer agent checks the work and may send you requested changes." : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function nudgePrompt(count: number, limit: number, role: AutomationJob["role"] = "implementer") {
  if (role === "reviewer") return `${tag} Your review ended without a verdict (reminder ${count} of ${limit}). Continue checking the delivery, then call flowly_submit_review verdict=approve or verdict=changes with concrete findings. You only review: do not edit files or change card status. If a person must decide, use flowly_report_progress kind=question and end your turn.`;
  return `${tag} Your turn ended without a delivery, a question or a blocker (reminder ${count} of ${limit}). If the card is finished, deliver it now with flowly_update_status status=in_review. If work remains, continue it. If you need a person, ask with flowly_report_progress kind=question or set status=blocked with the reason. If you are the reviewer, submit your verdict with flowly_submit_review. Without one of these after the last reminder, automation stops.`;
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
  "Lens for this round: the contract. Re-read the original card and its acceptance criteria and audit the delivery strictly against them, including every change requested in earlier rounds and in the comments.",
];

/** What each reviewer of a panel round focuses on (§5.1); a panel of n takes the first n. */
const panelFocuses = [
  "the artifact: read the diff cold before the delivery note, then investigate every mismatch with the note",
  "execution: run the build, the tests and the reported behavior, and verify each claim of the delivery",
  "the contract: the card's acceptance criteria, every change requested in earlier rounds and every comment",
  "integration and regressions: callers and users of the changed code, other cards' work, data and cleanup",
  "failure paths and safety: errors, races, retries, authorization and data loss",
];

/** The reviewer's instruction for one round; `reviewers` above 1 makes it a panel round (§5.1). */
export function reviewPrompt(round: number, max: number, reviewers = 1) {
  const panel = reviewers > 1;
  return [
    `${tag} You are the reviewer of this card (review round ${round} of ${max}${panel ? ", a panel review" : ""}). The implementer delivered it to In review. Verify it independently; you review, you do not take over the implementation.`,
    "Read flowly_get_task: the card, its workpad (acceptance criteria and checks), the people's comments (what they asked for counts like the card's requirements) and the delivery note in its activity. Inspect the actual changes in this workspace (git status, git diff, git log) and run the relevant checks.",
    panel
      ? [
          `Earlier rounds of this cycle requested changes${round > 1 ? ` (${round - 1} so far)` : ""} or the project reviews every round this way, so this round checks the delivery with ${reviewers} independent reviewers at once instead of one more serial pass. Start them in parallel with your subagent tool, in the foreground, and wait for all of them in this same turn (in Claude Code: ${reviewers} Agent calls in one message, not in the background); do not end your turn before you call flowly_submit_review (or ask a person with flowly_report_progress kind=question when only they can decide): a turn that ends with neither counts as an unfinished review. One reviewer per focus:`,
          ...panelFocuses.slice(0, reviewers).map((focus, i) => `${i + 1}. ${focus}.`),
          "Give each the card id, this workspace's path and its focus, plus what you read in flowly_get_task: the acceptance criteria, the delivery note, every change requested in earlier rounds and the people's comments. Tell it to report findings with file, problem and evidence; they only read and run checks, never edit files or call Flowly tools. If you cannot start subagents, review from each focus in turn yourself, independently. Then confirm each finding yourself (drop what you cannot reproduce or point to), merge duplicates and send every confirmed finding at once: the implementer gets one complete list instead of one problem per round.",
        ].join("\n")
      : lenses[Math.min(round, lenses.length) - 1],
    "Then call flowly_submit_review exactly once: verdict=approve when the acceptance criteria are met and the checks pass; verdict=changes with concrete findings the implementer can act on (file, problem, expected fix). Do not edit files, commit, push or change the card status. If only a person can decide something, ask with flowly_report_progress kind=question and end your turn.",
  ].join("\n\n");
}

export function changesPrompt(round: number, max: number, summary: string, findings: readonly string[], reviewers = 1) {
  return [
    `${tag} The ${reviewers > 1 ? `review panel (${reviewers} reviewers)` : "reviewer"} requested changes (review round ${round} of ${max}):`,
    summary,
    ...findings.map((f) => `- ${f}`),
    reviewers > 1
      ? "This is every problem the panel confirmed: fix all of them before you deliver, check each one against its finding, rerun the checks, update the workpad and deliver again with flowly_update_status status=in_review."
      : "Fix them, rerun the checks, update the workpad and deliver again with flowly_update_status status=in_review.",
  ].join("\n");
}

/** One line per sub-card for the parent's wake-up message: where it is and what automation made of it. */
export type SubCardLine = { id: string; title: string; lane: string; job?: Pick<AutomationJob, "state" | "verdict" | "code">; branch?: string; directory?: string; evidence?: string; blockers?: string[] };

export function childrenPrompt(lines: readonly SubCardLine[]) {
  const describe = (l: SubCardLine) => {
    const auto = l.job ? `automation ${l.job.state}${l.job.verdict ? `, review ${l.job.verdict}` : ""}${l.job.code ? ` (${l.job.code})` : ""}` : "not run by automation";
    const where = `${l.branch ? `; branch ${l.branch}` : ""}${l.directory ? `; directory ${l.directory}` : ""}`;
    return `- ${l.title} (${l.id}): ${l.lane}; ${auto}${where}${l.blockers?.length ? `; held by ${l.blockers.join(", ")}` : ""}${l.evidence ? `\n  Delivery evidence (card data): ${l.evidence}` : ""}`;
  };
  return [
    `${tag} Your sub-cards changed and none of them is still moving:`,
    ...lines.map(describe),
    "Inspect the delivery evidence below and each workspace's files and branch. Accept a delivered sub-card with flowly_update_card action=accept only after checking it and bringing its changes where later cards and this card need them. Start only newly parked sub-cards you deliberately deferred; never restart failed, stopped or human-parked jobs. Those need a person's Run again. For changes to a delivered sub-card use action=start with a concrete note; after two such restarts of one sub-card a person must act (NEEDS_PERSON), so ask one. Ask a person about failed jobs or unavailable blockers. Directory workspaces share the project root: do not assume an isolated branch. When this card's goal is met, deliver it with flowly_update_status status=in_review. If you dispatch sub-cards, end your turn without reporting a question or blocker unless you actually need a person; Flowly wakes only the supervised parent when they settle.",
  ].join("\n");
}
