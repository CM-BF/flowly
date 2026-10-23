import type { Board, Project, Task } from "./model";
import { childrenOf, linksOf, parentOf } from "./links";
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

/** Every dispatcher, recovery and side effect uses the same current ownership gate. */
export function automationAllowed(board: Pick<Board, "tasks" | "projects" | "links">, job: AutomationJob): boolean {
  const task = board.tasks.find((t) => t.id === job.taskId && t.projectId === job.projectId);
  const project = board.projects.find((p) => p.id === job.projectId);
  if (!task || task.archivedAt || ["done", "cancelled"].includes(task.status) || !project || project.archivedAt || !automationOf(project)) return false;
  const seen = new Set<string>();
  for (let id = parentOf(board.links, task.id); id && !seen.has(id); id = parentOf(board.links, id)) {
    seen.add(id);
    const parent = board.tasks.find((t) => t.id === id);
    if (!parent || parent.archivedAt || parent.status === "cancelled") return false;
  }
  return true;
}

/** The session the job supervises right now. */
export const activeAgent = (job: Pick<AutomationJob, "role" | "implementerId" | "reviewerId">) =>
  job.role === "reviewer" ? job.reviewerId : job.implementerId;

/**
 * The job this session is the reviewer of, while that job runs or its delivery waits for the user.
 * The reviewer's turns are not work on the card, in its round or outside it (a person asking it about
 * its verdict): rule A1 must not pull the card out of In review, and the job is not taken over.
 */
export const reviewerJob = (board: Pick<Board, "automation">, agentId: string) =>
  // Older jobs could carry one session in both roles; that session is the implementer.
  board.automation.find((j) => j.reviewerId === agentId && j.reviewerId !== j.implementerId && (isLive(j) || j.state === "delivered"));

/** The delivery the job's latest verdict was given on (jobs recorded before `reviewedEvent` existed: a verdict judged `deliveryEvent`). */
export const judgedDelivery = (job: Pick<AutomationJob, "reviewedEvent" | "deliveryEvent" | "verdict">) =>
  job.reviewedEvent ?? (job.verdict ? job.deliveryEvent : undefined);

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

/** Only explicit provider failure messages, never completed assistant prose. */
export const providerLimited = (message: string) => /\b429\b|rate[ -]?limit|quota (?:exceeded|exhausted|reached)|usage limit|overloaded|insufficient_quota/i.test(message);
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
/** Whether the project's next card would start on a cooling provider. `fallbackProvider`: the global default model's. */
export function providerCooling(board: Pick<Board, "automation" | "projects">, project: Project, now: number, fallbackProvider?: string) {
  const scope = { projectId: project.id };
  const provider = project.automation?.implementer?.provider ?? project.agentModel?.provider ?? fallbackProvider;
  return coolingProvider(board, provider, now, scope) || (!!project.automation?.reviewer && coolingProvider(board, project.automation.reviewer.provider, now, scope));
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
  /** The implementer delivered `delivery` (its status event): start the next review round on it. */
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
  | { kind: "await_children"; signature: string };

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
 * Whether the agent itself set the card to Blocked during its latest turn. A card that is
 * Blocked for another reason (rule A1r restoring it after a silent turn, automation having
 * given up earlier) is not the agent asking for a person.
 */
export const blockedThisTurn = (board: Pick<Board, "events">, taskId: string, agentId: string) =>
  thisTurn(board, taskId, agentId).some((e) => e.actor === "agent" && (e.action === "status_changed" || e.action === "status_confirmed") && e.to === "blocked");

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
      const delivery = [...board.events].reverse().find((e) => e.taskId === task.id && e.agentId === agentId && e.actor === "agent" && e.to === "in_review");
      // Nothing new since the latest verdict (a casual answer): the verdict still stands.
      if (delivery && delivery.id === judgedDelivery(job)) return { kind: "deliver" };
      if (!settings.reviewer) return { kind: "deliver", unreviewed: true };
      // Feedback after a delivery (or during its review) starts a new cycle: its rounds count from zero (§4.2).
      const rounds = job.reopened ? 0 : job.reviewRounds;
      return rounds < settings.maxReviewRounds ? { kind: "review", ...(delivery ? { delivery: delivery.id } : {}) } : { kind: "deliver", code: "review_rounds" };
    }
    if (task.status === "blocked" && blockedThisTurn(board, task.id, agentId)) return { kind: "wait", code: "blocked" };
    if (askedThisTurn(board, task.id, agentId)) return { kind: "wait", code: "question" };
    if (childrenOf(board.links, task.id).some((id) => subCardActive(board, id))) return { kind: "await_children", signature: subCardSignature(board, task.id) };
  }
  if (job.nudges < settings.nudgeLimit) return { kind: "nudge", count: job.nudges + 1 };
  return reviewer ? { kind: "give_up", code: "review_incomplete", blockCard: false } : { kind: "give_up", code: "no_delivery", blockCard: true };
}

/**
 * Whether a sub-card is still moving without its parent (SUB-CARDS-SPEC §5): an agent
 * works on it, waits for a person (a question, a blocker, a permission: the person
 * answers it, not the parent), or is about to start. A queued card held by blockers
 * that are not Done moves only while one of them moves itself: a sibling delivered to
 * In review waits for this parent to accept it, and a blocker nobody runs (delivered,
 * failed, stopped, never run by automation) waits for a person. Either way the parent
 * is told. `seen` ends the walk on a dependency cycle.
 */
export function subCardActive(board: Pick<Board, "tasks" | "links" | "automation">, id: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const task = board.tasks.find((t) => t.id === id);
  if (!task || task.archivedAt || task.status === "done" || task.status === "cancelled") return false;
  const job = jobOf(board, id);
  if (!job || !isLive(job)) return false;
  if (job.state !== "queued") return true;
  const ready = readiness(board, id);
  if (ready.ready) return true;
  if (ready.reason !== "blockers" || ready.cancelled.length) return false;
  const parent = parentOf(board.links, id);
  const siblingDelivered = (blocker: Task) => !!parent && parentOf(board.links, blocker.id) === parent && blocker.status === "in_review";
  return ready.waiting.some((blocker) => !siblingDelivered(blocker) && subCardActive(board, blocker.id, new Set(seen)));
}

/**
 * The sub-cards' state as the parent last saw it; a different value wakes the parent. A queued
 * sub-card also records whether it moves, which its blockers decide (one outside the parent's
 * tree can be cancelled or archived while the sub-card itself does not change).
 */
export function subCardSignature(board: Pick<Board, "tasks" | "links" | "automation">, parentId: string) {
  return childrenOf(board.links, parentId)
    .map((id) => {
      const task = board.tasks.find((t) => t.id === id);
      const job = jobOf(board, id);
      const held = job?.state === "queued" ? (subCardActive(board, id) ? ":moving" : ":held") : "";
      return `${id}:${task?.archivedAt ? "archived" : (task?.status ?? "gone")}:${job?.state ?? ""}:${job?.verdict ?? ""}${held}`;
    })
    .join("|");
}

/** A waiting parent wakes when none of its sub-cards is moving and they changed since it last looked. */
export function parentShouldWake(board: Pick<Board, "tasks" | "links" | "automation" | "projects">, job: AutomationJob) {
  if (job.state !== "waiting") return false;
  if (!automationAllowed(board, job)) return false;
  const project = board.projects.find((p) => p.id === job.projectId);
  const settings = automationOf(project)!;
  if (board.automation.filter((j) => j.projectId === job.projectId && slotStates.includes(j.state)).length >= settings.maxRunning) return false;
  if (childrenOf(board.links, job.taskId).some((id) => subCardActive(board, id))) return false;
  return subCardSignature(board, job.taskId) !== job.subSeen;
}

/** Provider modes that never stop for approval; unattended sessions use them when full access is on. */
export const unattendedModes: Readonly<Record<string, string>> = { claude: "bypassPermissions", codex: "full-access" };

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

/** Hermes sdlc-review lenses: each round looks at the work differently. */
const lenses = [
  "Lens for this round: the artifact. Read the diff cold before the delivery note, form your own judgment, then compare it with the note and investigate every mismatch.",
  "Lens for this round: execution. Run the build, the tests and the reported behavior yourself; verify each claim of the delivery instead of re-reading it.",
  "Lens for this round: the contract. Re-read the original card and its acceptance criteria and audit the delivery strictly against them, including every change requested in earlier rounds.",
];

export function reviewPrompt(round: number, max: number) {
  return [
    `${tag} You are the reviewer of this card (review round ${round} of ${max}). The implementer delivered it to In review. Verify it independently; you review, you do not take over the implementation.`,
    "Read flowly_get_task: the card, its workpad (acceptance criteria and checks) and the delivery note in its activity. Inspect the actual changes in this workspace (git status, git diff, git log) and run the relevant checks.",
    lenses[Math.min(round, lenses.length) - 1],
    "Then call flowly_submit_review exactly once: verdict=approve when the acceptance criteria are met and the checks pass; verdict=changes with concrete findings the implementer can act on (file, problem, expected fix). Do not edit files, commit, push or change the card status. If only a person can decide something, ask with flowly_report_progress kind=question and end your turn.",
  ].join("\n\n");
}

export function changesPrompt(round: number, max: number, summary: string, findings: readonly string[]) {
  return [
    `${tag} The reviewer requested changes (review round ${round} of ${max}):`,
    summary,
    ...findings.map((f) => `- ${f}`),
    "Fix them, rerun the checks, update the workpad and deliver again with flowly_update_status status=in_review.",
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
    "Inspect the delivery evidence below and each workspace's files and branch. Accept a delivered sub-card with flowly_update_card action=accept only after checking it and bringing its changes where later cards and this card need them. Start only newly parked sub-cards you deliberately deferred; never restart failed, stopped or human-parked jobs. Those need a person's Run again. For changes to a delivered sub-card use action=start with a concrete note. Ask a person about failed jobs or unavailable blockers. Directory workspaces share the project root: do not assume an isolated branch. When this card's goal is met, deliver it with flowly_update_status status=in_review. If you dispatch sub-cards, end your turn without reporting a question or blocker unless you actually need a person; Flowly wakes only the supervised parent when they settle.",
  ].join("\n");
}
