import type { Board, Project, Task } from "./model";
import { linksOf } from "./links";
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
export const liveStates: readonly AutomationState[] = ["queued", "starting", "working", "needs_human", "retry_wait", "reviewing"];
/** States that hold one of the project's running slots (Hermes counts claimed tasks the same way). */
export const slotStates: readonly AutomationState[] = ["starting", "working", "retry_wait", "reviewing"];
export const isLive = (job: Pick<AutomationJob, "state"> | undefined) => !!job && liveStates.includes(job.state);

/** The session the job supervises right now. */
export const activeAgent = (job: Pick<AutomationJob, "role" | "implementerId" | "reviewerId">) =>
  job.role === "reviewer" ? job.reviewerId : job.implementerId;

/**
 * The job reviewing with this session. Its turns are not work on the card:
 * rule A1 must not pull the card out of In review when the reviewer starts.
 */
export const reviewingJob = (board: Pick<Board, "automation">, agentId: string) =>
  board.automation.find((j) => j.role === "reviewer" && j.reviewerId === agentId && isLive(j));

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

const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

/**
 * One dispatcher pass (Hermes `dispatch`): per project with automation on, the
 * retries that are due and the queued cards that fit in the free slots, highest
 * priority and longest waiting first. Projects with automation off do nothing.
 */
export function dispatchPlan(board: Pick<Board, "projects" | "tasks" | "links" | "automation">, now: number) {
  const start: AutomationJob[] = [],
    retry: AutomationJob[] = [];
  for (const project of board.projects) {
    const settings = automationOf(project);
    if (!settings || project.archivedAt) continue;
    const jobs = board.automation.filter((j) => j.projectId === project.id);
    retry.push(...jobs.filter((j) => j.state === "retry_wait" && (!j.retryAt || Date.parse(j.retryAt) <= now)));
    let free = settings.maxRunning - jobs.filter((j) => slotStates.includes(j.state)).length;
    const task = (j: AutomationJob) => board.tasks.find((t) => t.id === j.taskId);
    const candidates = jobs
      .filter((j) => j.state === "queued" && readiness(board, j.taskId).ready)
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
  /** The implementer delivered: start the next review round. */
  | { kind: "review" }
  /** The implementer delivered and no (further) review runs: the user takes over. */
  | { kind: "deliver"; code?: AutomationCode }
  /** The session waits for a person; its next turn resumes supervision. */
  | { kind: "wait"; code: AutomationCode }
  | { kind: "stop"; code: AutomationCode }
  | { kind: "nudge"; count: number }
  | { kind: "retry"; count: number; at: string }
  /** Limits exhausted. `blockCard`: the card moves to Blocked so it stops looking active. */
  | { kind: "give_up"; code: AutomationCode; blockCard: boolean };

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
  thisTurn(board, taskId, agentId).some((e) => e.actor === "agent" && e.action === "status_changed" && e.to === "blocked");

/**
 * What a supervised session's turn end means (Hermes worker protocol): a
 * delivery hands over to review or to the user, a question or blocker waits for
 * a person, a silent end is nudged a bounded number of times, a failed turn is
 * retried with backoff, and exhausted limits give up. Turn ends of other
 * sessions are ignored.
 */
export function turnDecision(
  board: Pick<Board, "tasks" | "events">,
  job: AutomationJob,
  agentId: string,
  outcome: TurnOutcome,
  settings: AutomationSettings,
  now: number,
): TurnDecision {
  if (!["starting", "working", "reviewing", "needs_human"].includes(job.state) || activeAgent(job) !== agentId) return { kind: "ignore" };
  const task = board.tasks.find((t) => t.id === job.taskId);
  if (!task) return { kind: "ignore" };
  if (task.archivedAt || task.status === "done" || task.status === "cancelled") return { kind: "stop", code: "card_finished" };
  const reviewer = job.role === "reviewer";
  if (outcome.kind === "failed") {
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
      if (!settings.reviewer) return { kind: "deliver" };
      return job.reviewRounds < settings.maxReviewRounds ? { kind: "review" } : { kind: "deliver", code: "review_rounds" };
    }
    if (task.status === "blocked" && blockedThisTurn(board, task.id, agentId)) return { kind: "wait", code: "blocked" };
    if (askedThisTurn(board, task.id, agentId)) return { kind: "wait", code: "question" };
  }
  if (job.nudges < settings.nudgeLimit) return { kind: "nudge", count: job.nudges + 1 };
  return reviewer ? { kind: "give_up", code: "review_incomplete", blockCard: false } : { kind: "give_up", code: "no_delivery", blockCard: true };
}

/** Provider modes that never stop for approval; unattended sessions use them when full access is on. */
export const unattendedModes: Readonly<Record<string, string>> = { claude: "bypassPermissions", codex: "full-access" };

// Messages the daemon sends to sessions. Agent-facing text stays English (I18N-SPEC).
const tag = "[Flowly automation]";
const lifecycle =
  "Follow the Flowly skill: read flowly_get_task, fix setup.missing, set the stage that matches the work, keep the workpad current. End by delivering with flowly_update_status status=in_review and a note on what changed, how you verified it and what you did not run. If you cannot continue without a person (a decision, credentials, access), ask with flowly_report_progress kind=question or set status=blocked with the reason, then end your turn: nobody is watching this session live, so do not wait and do not guess.";

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

export function nudgePrompt(count: number, limit: number) {
  return `${tag} Your turn ended without a delivery, a question or a blocker (reminder ${count} of ${limit}). If the card is finished, deliver it now with flowly_update_status status=in_review. If work remains, continue it. If you need a person, ask with flowly_report_progress kind=question or set status=blocked with the reason. If you are the reviewer, submit your verdict with flowly_submit_review. Without one of these after the last reminder, automation stops.`;
}

export function retryPrompt(count: number, limit: number, error: string) {
  return `${tag} The last turn failed: ${error.slice(0, 300) || "unknown error"}. Continue from the current state of the workspace; do not repeat work that is already done (attempt ${count + 1} of ${limit}).`;
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
