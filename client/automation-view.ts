import type { Project, Task } from "../shared/model";
import { automationOf, isLive, type AutomationCode, type AutomationJob } from "../shared/automation";
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

/** True only when the workspace list is loaded (`known`) and lacks the card's workspace; never while loading. */
export const workspaceKnownMissing = (known: ReadonlySet<string> | null | undefined, workspaceId: string) => !!known && !known.has(workspaceId);

const isFinished = (task: Pick<Task, "status">) => task.status === "done" || task.status === "cancelled";

/** The card's menu entries: Run with agent while the project has automation on, Stop while a job is live. */
export function automationMenu(project: Project | undefined, task: Task, job: AutomationJob | undefined, locked: boolean, actions: AutomationActions, runUnavailable = false) {
  if (isLive(job)) return [{ id: "automation-stop", label: t("Stop automation"), icon: "CircleStop", disabled: actions.pending, onPress: () => void actions.stop(task.id) }];
  if (!automationOf(project) || isFinished(task)) return [];
  return [{ id: "automation-run", label: t("Run with agent"), icon: "Bot", disabled: locked || runUnavailable || actions.pending, onPress: () => void actions.queue(task.id) }];
}
