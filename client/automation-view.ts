import { classificationHash, type LevelBoard, type LevelCard } from "../shared/review-levels";
import type { Project, Task } from "../shared/model";
import {
  automationOf,
  isLive,
  panelDefaults,
  panelOutOfReach,
  risksEarlier,
  type AutomationCode,
  type AutomationJob,
  type AutomationSettings,
  type LevelReason,
  type ReviewLevel,
  type ReviewPlan,
} from "../shared/automation";
import type { BlockerInfo } from "../shared/card-tree";
import type { Tone } from "./ui";
import { localizedLabels, msg, t, tn } from "../shared/i18n";

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

/** Review levels (AUTOMATION-SPEC §5.2) as people read them; Auto is a card without a level. */
export const reviewLevelLabels: Record<ReviewLevel | "auto", string> = localizedLabels({
  auto: msg("Auto"),
  light: msg("Light"),
  standard: msg("Standard"),
  deep: msg("Deep"),
});

/** Why a card has its level, for the card editor and the drawer. */
export function levelReasonText(reason: LevelReason): string {
  switch (reason.kind) {
    case "card":
      return t("set on the card");
    case "tag":
      return t("the card has the tag {tag}", { tag: reason.tag });
    case "ancestor_tag":
      return t("the card above it, {title}, has the tag {tag}", { title: reason.title, tag: reason.tag });
    case "keyword":
      return reason.field === "title"
        ? t("its title mentions {keyword}", { keyword: reason.keyword })
        : reason.field === "description"
          ? t("its description mentions {keyword}", { keyword: reason.keyword })
          : t("its acceptance criteria mention {keyword}", { keyword: reason.keyword });
    case "light_tag":
      return t("the card has the tag {tag}", { tag: "light-review" });
    case "classifier":
      return t("{reason} (classified by {model})", { reason: reason.text, model: reason.model });
    case "default":
      return t("nothing calls for a deeper or lighter review");
  }
}

/**
 * The drawer's level lines (§5.2.5): the level of the round the job recorded, said as that round's ("This review
 * round: Deep (…)" while it runs, else "Last review round: …"), and the next round's when the card resolves to another
 * level now (a person changed it in Edit task). `current`: the card's resolution now, null when no round will follow.
 */
export function levelLines(job: Pick<AutomationJob, "state" | "role" | "review" | "reviewRounds">, current: { level: ReviewLevel; reason: LevelReason } | null): string[] {
  const plan = job.review;
  if (!plan || !job.reviewRounds) return [];
  const values = (p: { level: ReviewLevel; reason: LevelReason }) => ({ level: reviewLevelLabels[p.level], why: levelReasonText(p.reason) });
  return [
    (job.state === "reviewing" || (job.role === "reviewer" && ["needs_human", "retry_wait"].includes(job.state))) ? t("This review round: {level} ({why})", values(plan)) : t("Last review round: {level} ({why})", values(plan)),
    ...(current && current.level !== plan.level ? [t("Next review round: {level} ({why})", values(current))] : []),
  ];
}

/** The heading of the drawer's risk list; risks of an earlier delivery say which round reported them (§5.2.4). */
export const risksHeading = (job: Pick<AutomationJob, "risks" | "risksFrom" | "latestDelivery" | "deliveryEvent">) =>
  risksEarlier(job)
    ? t("Risks noted beyond the acceptance criteria in review round {n}, on an earlier delivery", { n: job.risksFrom!.round })
    : t("Risks the reviewer noted beyond the acceptance criteria");

/**
 * Which panel fields Edit project shows (§5.1, §5.2.5): the panel model whenever there is a reviewer, since Deep cards
 * run their panels on it even when Standard cards never reach one; the panel size only when they do.
 */
export function panelFields(settings: AutomationSettings) {
  const after = settings.panelAfter === undefined ? panelDefaults.after : settings.panelAfter;
  const reach = after !== null && !panelOutOfReach(settings);
  return { panelReviewer: !!settings.reviewer, panelSize: reach, outOfReach: after !== null && !reach };
}
/** The Deep panel reviewer's "none": the model Deep cards then use, the panel reviewer when one is set. */
export const deepPanelNone = (settings: Pick<AutomationSettings, "panelReviewer">) => (settings.panelReviewer ? t("Same as panel reviewer") : t("Same as reviewer"));

/** The card editor's hint under Auto: what Auto resolves to with the form's current text and tags, and why. */
export const autoLevelHint = (resolved: { level: ReviewLevel; reason: LevelReason }) =>
  resolved.reason.kind === "classifier"
    ? t("Auto: {level} — {reason} ({model})", { level: reviewLevelLabels[resolved.level], reason: resolved.reason.text, model: resolved.reason.model })
    : resolved.reason.kind === "keyword" || resolved.reason.kind === "default"
      ? t("Auto: {level} (keyword fallback), because {why}.", { level: reviewLevelLabels[resolved.level], why: levelReasonText(resolved.reason) })
      : t("Auto: {level}, because {why}.", { level: reviewLevelLabels[resolved.level], why: levelReasonText(resolved.reason) });

/** Draft edits never start helpers. Cache matching and pending state use the same inputs as the daemon. */
export function autoLevelStatus(board: LevelBoard, card: LevelCard, resolved: { level: ReviewLevel; reason: LevelReason }) {
  if (!["default", "keyword", "classifier"].includes(resolved.reason.kind)) return autoLevelHint(resolved);
  const saved = board.tasks.find((task) => task.id === card.id);
  const currentHash = classificationHash(board, card);
  if (saved ? currentHash !== classificationHash(board, saved)
    : card.reviewClassification && card.reviewClassification.inputHash !== currentHash)
    return t("Save changes to classify this card.");
  if (card.reviewClassification?.status === "pending") return t("Classifying…");
  return autoLevelHint(resolved);
}

/** What the card editor sends for the Review level choice: nothing unless it changed; Auto clears the card's level. */
export function levelEdit(stored: ReviewLevel | undefined, chosen: ReviewLevel | "auto"): { reviewLevel?: ReviewLevel | null } {
  if (chosen === (stored ?? "auto")) return {};
  return { reviewLevel: chosen === "auto" ? null : chosen };
}

/** A review round with its level (§5.2.5): "Deep review round 1 of 3 (panel of 3 reviewers)". */
export function reviewRoundText(round: number, plan: Pick<ReviewPlan, "level" | "max" | "size">): string {
  const values = { n: round, max: plan.max, k: plan.size };
  if (plan.level === "light") return t("Light review round {n} of {max}", values);
  if (plan.level === "deep") return t("Deep review round {n} of {max} (panel of {k} reviewers)", values);
  return plan.size > 1 ? t("Standard review round {n} of {max} (panel of {k} reviewers)", values) : t("Standard review round {n} of {max}", values);
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
      // Jobs recorded before review levels have no plan (§5.2.6).
      return { text: job.review ? reviewRoundText(job.reviewRounds, job.review) : t("Agent reviewing"), tone: "active" };
    case "retry_wait":
      return { text: t("Agent retrying"), icon: "RotateCw", tone: "warning" };
    case "needs_human":
      return { text: job.code === "permission" ? t("Agent needs permission") : t("Agent waiting for you"), icon: "Hand", tone: "warning" };
    case "waiting":
      return { text: t("Waiting on sub-cards"), icon: "ListTree", tone: "info" };
    case "delivered": {
      if (task.status !== "in_review") return null;
      // Risks beyond the criteria never block approval, so the card says they are there (§5.2.4).
      const risks = job.risks?.length ?? 0;
      if (job.verdict === "approved")
        return risks
          ? { text: tn(risks, "Agent review passed · {n} risk", "Agent review passed · {n} risks"), icon: "ShieldAlert", tone: "warning" }
          : { text: t("Agent review passed"), icon: "BadgeCheck", tone: "success" };
      if (!job.verdict) return null;
      // Risks kept from an earlier delivery (its reviewer gave up, or the rounds ran out) say so (§5.2.4).
      const text = !risks
        ? t("Review needs you")
        : risksEarlier(job)
          ? tn(risks, "Review needs you · {n} earlier risk", "Review needs you · {n} earlier risks")
          : tn(risks, "Review needs you · {n} risk", "Review needs you · {n} risks");
      return { text, icon: "TriangleAlert", tone: "warning" };
    }
    case "failed":
      return { text: t("Automation stopped"), icon: "OctagonX", tone: "danger" };
    case "stopped":
      return null;
  }
}
