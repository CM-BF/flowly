import type { Project, Task } from "../shared/model";
import { automationOf, isLive, type AutomationCode, type AutomationJob } from "../shared/automation";
import type { BlockerInfo } from "../shared/card-tree";
import type { Tone } from "./ui";
import { localizedLabels, msg, t } from "../shared/i18n";

/** Queue / stop a card's automation (client/task-automation.tsx `useAutomationActions`). */
export type AutomationActions = { pending: boolean; queue(taskId: string): Promise<void>; stop(taskId: string): Promise<void> };

const reasons: Record<AutomationCode, string> = localizedLabels({
  question: msg("The agent asked a question"),
  blocked: msg("The agent reported a blocker"),
  permission: msg("The agent is waiting for a permission"),
  interrupted: msg("The turn was interrupted"),
  stopped: msg("Stopped by you"),
  card_moved: msg("The card was moved"),
  card_finished: msg("The card was finished"),
  no_delivery: msg("The agent kept ending turns without a delivery"),
  failed: msg("Turns kept failing"),
  start_failed: msg("The agent session could not be started"),
  session_unavailable: msg("The agent's session is no longer available"),
  workspace_unavailable: msg("The card's workspace is no longer available"),
  taken_over: msg("Another session took over the card"),
  ancestor_finished: msg("An ancestor card was cancelled, archived or removed"),
  review_rounds: msg("All review rounds were used"),
  review_incomplete: msg("The reviewer gave no verdict"),
  cooldown: msg("Provider limit reached; retrying later"),
  sub_cards: msg("It handed its work to sub-cards and waits for them"),
});

/**
 * Codes whose plain label describes the end state, worded for the state the job is in now:
 * a retry still to come (retry_wait) or a wait for a person (needs_human).
 */
const stateReasons: Partial<Record<AutomationJob["state"], Partial<Record<AutomationCode, string>>>> = {
  retry_wait: localizedLabels({
    failed: msg("The last turn failed; retrying"),
    start_failed: msg("The agent session could not be started; retrying"),
  }),
  needs_human: localizedLabels({
    cooldown: msg("The provider limit kept recurring; reply in the session, or Stop and Run again"),
  }),
};

/** The drawer's reason line for a job, or null when the status line already says it. */
export function automationReason(job: Pick<AutomationJob, "state" | "code"> | undefined): string | null {
  if (!job?.code) return null;
  if (job.state === "needs_human" && job.code === "permission") return null;
  return stateReasons[job.state]?.[job.code] ?? reasons[job.code];
}

/** A cached list cannot prove a newer card's workspace is missing. */
export const workspaceKnownMissing = (known: ReadonlySet<string> | null | undefined, workspaceId: string, snapshot?: { cardCreatedAt: string; fetchedAt: number }) =>
  !!known && (!snapshot || Date.parse(snapshot.cardCreatedAt) <= snapshot.fetchedAt) && !known.has(workspaceId);

const isFinished = (task: Pick<Task, "status">) => task.status === "done" || task.status === "cancelled";

/** The card's menu entries: Run with agent while the project has automation on, Stop while a job is live. */
export function automationMenu(project: Project | undefined, task: Task, job: AutomationJob | undefined, locked: boolean, actions: AutomationActions, runUnavailable = false) {
  if (isLive(job)) return [{ id: "automation-stop", label: t("Stop automation"), icon: "CircleStop", disabled: actions.pending, onPress: () => void actions.stop(task.id) }];
  if (!automationOf(project) || isFinished(task)) return [];
  return [{ id: "automation-run", label: t("Run with agent"), icon: "Bot", disabled: locked || runUnavailable || actions.pending, onPress: () => void actions.queue(task.id) }];
}

/** How a job reads on the card (AUTOMATION-SPEC §6.1). */
export type AutomationSignal = { text: string; icon?: string; tone: Tone | "active" };

/**
 * The card's automation in a few words; null when the lane already says it (stopped, delivered without a review, or the card is finished)
 * or when a Cancelled or archived blocker holds the queued card (its Held signal says so). `blockers`: the card's entry of `blockerIndex`.
 */
export function automationSignal(job: AutomationJob | undefined, task: Pick<Task, "status">, blockers?: Pick<BlockerInfo, "open" | "held"> | null): AutomationSignal | null {
  if (!job || (isFinished(task) && !isLive(job))) return null;
  switch (job.state) {
    case "queued":
      // Split by what it waits for (CARD-TREE-SPEC §2.5): Held shows its own signal instead.
      if (blockers?.held) return null;
      if (blockers?.open) return { text: t("Queued after blockers"), icon: "Hourglass", tone: "info" };
      return { text: t("Queued for agent"), icon: "Clock", tone: "info" };
    case "starting":
      return { text: t("Starting agent…"), tone: "active" };
    case "working":
      return { text: t("Agent working"), tone: "active" };
    case "reviewing":
      return { text: t("Agent reviewing"), tone: "active" };
    case "retry_wait":
      return { text: t("Agent retrying"), icon: "RotateCw", tone: "warning" };
    case "needs_human":
      return { text: job.code === "permission" ? t("Agent needs permission") : t("Agent waiting for you"), icon: "Hand", tone: "warning" };
    case "waiting":
      return { text: t("Waiting on sub-cards"), icon: "ListTree", tone: "info" };
    case "delivered":
      if (task.status !== "in_review") return null;
      if (job.verdict === "approved") return { text: t("Agent review passed"), icon: "BadgeCheck", tone: "success" };
      return job.verdict ? { text: t("Review needs you"), icon: "TriangleAlert", tone: "warning" } : null;
    case "failed":
      return { text: t("Automation stopped"), icon: "OctagonX", tone: "danger" };
    case "stopped":
      return null;
  }
}
