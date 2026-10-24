import type { AgentModel } from "./agent-defaults";
import { parentOf } from "./links";
import type { Board, Task } from "./model";
import type { AutomationJob, AutomationSettings, LevelReason, LevelSettings, ReviewLevel, ReviewPlan } from "./automation-schema";

/**
 * Review levels (AUTOMATION-SPEC §5.2): how hard agent automation reviews a card. Runtime-neutral and small, so the
 * card editor shows the same Auto resolution the daemon records when a review round starts.
 */

/** Panel review (§5.1) when a project never chose: from the third round of a cycle, three reviewers. */
export const panelDefaults = { after: 2, size: 3 } as const;
/** How many reviewers check review round `round` of a Standard cycle: 1 for a serial round, the panel size for a panel round. */
export function reviewersFor(settings: AutomationSettings, round: number) {
  const after = settings.panelAfter === undefined ? panelDefaults.after : settings.panelAfter;
  return after !== null && round > after ? (settings.panelSize ?? panelDefaults.size) : 1;
}

/** Tags that make a card Deep (on the card or any ancestor) or Light (on the card itself). */
export const levelTags = { deep: ["deep-review", "foundation"], light: "light-review" } as const;

export type LevelBoard = Pick<Board, "tasks" | "links"> & { workpads?: Board["workpads"] };
/** The card as resolution reads it; the card editor passes its draft title, description and tags. */
export type LevelCard = Pick<Task, "id" | "title" | "description" | "reviewLevel" | "reviewClassification"> & { tags?: readonly ({ tag: string } | string)[] };

const tagValue = (tag: { tag: string } | string) => (typeof tag === "string" ? tag : tag.tag).trim().toLocaleLowerCase("en").replace(/^#+/, "").replace(/[\s_]+/g, "-");
const deepTagOf = (tags: readonly string[]) => tags.find((tag) => (levelTags.deep as readonly string[]).includes(tag));
/** How far up the sub-card links resolution looks for a deep tag. */
const ancestorLimit = 20;

/** All classifier inputs; parent context is a title only, never inherited instructions. */
export function classificationInput(board: LevelBoard, card: LevelCard) {
  return {
    policy: 1,
    title: card.title,
    description: card.description,
    acceptance: board.workpads?.find((w) => w.taskId === card.id)?.acceptance.map((item) => item.text) ?? [],
    tags: (card.tags ?? []).map(tagValue).sort(),
    parentTitle: board.tasks.find((t) => t.id === parentOf(board.links, card.id))?.title ?? "",
  };
}
/** Non-security 128-bit content fingerprint, over every input. Shared so draft hints reject stale cached results. */
export function classificationHash(board: LevelBoard, card: LevelCard): string {
  const text = JSON.stringify(classificationInput(board, card));
  let a = 1779033703, b = 3144134277, c = 1013904242, d = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    a = b ^ Math.imul(a ^ k, 597399067); b = c ^ Math.imul(b ^ k, 2869860233);
    c = d ^ Math.imul(c ^ k, 951274213); d = a ^ Math.imul(d ^ k, 2716044179);
  }
  return [a, b, c, d].map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}

/**
 * The card's review level and why (§5.2.2): its own level; else Deep for a deep-review or foundation tag on it or an
 * ancestor; else its own light-review tag; else a current cached classifier verdict or keyword fallback. The
 * fallback table and model calls live on the server; the client only reads matching saved results.
 */
export function resolveReviewLevel(board: LevelBoard, card: LevelCard): { level: ReviewLevel; reason: LevelReason } {
  if (card.reviewLevel) return { level: card.reviewLevel, reason: { kind: "card" } };
  const own = (card.tags ?? []).map(tagValue);
  const tag = deepTagOf(own);
  if (tag) return { level: "deep", reason: { kind: "tag", tag } };
  const seen = new Set([card.id]);
  for (let id = parentOf(board.links, card.id); id && !seen.has(id) && seen.size <= ancestorLimit; id = parentOf(board.links, id)) {
    seen.add(id);
    const parent = board.tasks.find((t) => t.id === id);
    if (!parent) break;
    const inherited = deepTagOf((parent.tags ?? []).map(tagValue));
    if (inherited) return { level: "deep", reason: { kind: "ancestor_tag", tag: inherited, cardId: parent.id, title: parent.title.slice(0, 200) } };
  }
  if (own.includes(levelTags.light)) return { level: "light", reason: { kind: "light_tag" } };
  const cached = card.reviewClassification;
  if (cached?.inputHash === classificationHash(board, card)) {
    if (cached.verdict) return { level: cached.verdict.level, reason: { kind: "classifier", model: cached.verdict.model, text: cached.verdict.reason } };
    return cached.fallback;
  }
  return { level: "standard", reason: { kind: "default" } };

}

/** Deep panels when the project never chose a size. */
export const deepDefaults = { size: 3 } as const;
/** A cycle's round cap at `level`: Light defaults to min(2, Review rounds), Deep to Review rounds. */
export function levelRounds(settings: AutomationSettings, level: ReviewLevel) {
  if (level === "light") return settings.levels?.light?.maxReviewRounds ?? Math.min(2, settings.maxReviewRounds);
  if (level === "deep") return settings.levels?.deep?.maxReviewRounds ?? settings.maxReviewRounds;
  return settings.maxReviewRounds;
}
export const deepPanelSize = (settings: AutomationSettings) => settings.levels?.deep?.panelSize ?? deepDefaults.size;

/** Review round `round` of the card: its level and why, the cycle's cap and how many reviewers check it (§5.2.3). */
export function reviewPlan(settings: AutomationSettings, board: LevelBoard, card: LevelCard, round: number): ReviewPlan {
  const { level, reason } = resolveReviewLevel(board, card);
  const size = level === "light" ? 1 : level === "deep" ? deepPanelSize(settings) : reviewersFor(settings, round);
  return { level, reason, max: levelRounds(settings, level), size };
}

/** Which configured model a reviewer session runs on: the panel model (§5.1) or a level's own (§5.2.3); none: the reviewer's. */
export type ReviewSeat = "panel" | "light" | "deep" | undefined;
export function roundSeat(settings: AutomationSettings, plan: Pick<ReviewPlan, "level" | "size">): ReviewSeat {
  if (plan.level === "light") return settings.levels?.light?.reviewer ? "light" : undefined;
  if (plan.level === "deep") return settings.levels?.deep?.panelReviewer ? "deep" : settings.panelReviewer ? "panel" : undefined;
  return plan.size > 1 && settings.panelReviewer ? "panel" : undefined;
}
export const seatOf = (job: Pick<AutomationJob, "seat" | "panel">): ReviewSeat => job.seat ?? (job.panel ? "panel" : undefined);
export function seatModel(settings: AutomationSettings, seat: ReviewSeat): AgentModel | undefined {
  switch (seat) {
    case "light":
      return settings.levels?.light?.reviewer ?? settings.reviewer;
    case "deep":
      return settings.levels?.deep?.panelReviewer ?? settings.panelReviewer ?? settings.reviewer;
    case "panel":
      return settings.panelReviewer ?? settings.reviewer;
    default:
      return settings.reviewer;
  }
}

/** Why a card has its level, for agent prompts and activity notes (daemon English). */
export function reasonText(reason: LevelReason): string {
  switch (reason.kind) {
    case "card":
      return "it is set on the card";
    case "tag":
      return `the card has the tag ${reason.tag}`;
    case "ancestor_tag":
      return `its ancestor card "${reason.title}" has the tag ${reason.tag}`;
    case "keyword":
      return "keyword fallback: " + (reason.field === "acceptance" ? `its acceptance criteria mention "${reason.keyword}"` : `its ${reason.field} mentions "${reason.keyword}"`);
    case "light_tag":
      return `the card has the tag ${levelTags.light}`;
    case "classifier":
      return `classifier ${reason.model}: ${reason.text}`;
    case "default":
      return "keyword fallback: no tag or keyword calls for a deep or light review";
  }
}

const levelNames: Record<ReviewLevel, string> = { light: "Light", standard: "Standard", deep: "Deep" };
/** The `review_level_set` note (daemon English): "Review level: Deep", or Auto when the card no longer has one. */
export const reviewLevelNote = (level: ReviewLevel | undefined) => `Review level: ${level ? levelNames[level] : "Auto"}`;
/**
 * The `automation_review_started` note: every round names its level and why (§5.2.5), "Deep review round 1 of 3
 * (panel of 3 reviewers); level deep: …", also a Standard round Auto chose because nothing called for another.
 */
export function reviewStartNote(round: number, plan: ReviewPlan) {
  const panel = plan.size > 1 ? ` (panel of ${plan.size} reviewers)` : "";
  return `${levelNames[plan.level]} review round ${round} of ${plan.max}${panel}; level ${plan.level}: ${reasonText(plan.reason)}`;
}

/**
 * Whether the job's risks were reported on an earlier delivery than its latest one (§5.2.4): the next round's reviewer
 * gave up, the rounds ran out, or a new run has not been reviewed yet. They stay until the next verdict, labelled.
 */
export const risksEarlier = (job: Pick<AutomationJob, "risks" | "risksFrom" | "latestDelivery" | "deliveryEvent">) =>
  !!job.risks?.length && !!job.risksFrom?.delivery && job.risksFrom.delivery !== (job.latestDelivery ?? job.deliveryEvent);
/** Where earlier risks came from, for the parent's wake-up line and get_task handoffs (agent English); else undefined. */
export const risksOrigin = (job: Pick<AutomationJob, "risks" | "risksFrom" | "latestDelivery" | "deliveryEvent">) =>
  risksEarlier(job) ? `reported in review round ${job.risksFrom!.round} on an earlier delivery; some may be fixed` : undefined;

type LevelKey = "reviewer" | "maxReviewRounds" | "panelReviewer" | "panelSize";
function levelDefault(settings: AutomationSettings, level: "light" | "deep", key: LevelKey): number | undefined {
  if (key === "maxReviewRounds") return level === "light" ? Math.min(2, settings.maxReviewRounds) : settings.maxReviewRounds;
  if (key === "panelSize") return deepDefaults.size;
  return undefined;
}
/**
 * The settings change for a review-level choice in Edit project, or null when it changes nothing (§5.2.6). Picking the
 * default (or no model) removes the key, and an empty level or `levels` goes with it, so boards stay readable by
 * builds without levels.
 */
export function levelChoice(
  settings: AutomationSettings,
  level: "light" | "deep",
  key: LevelKey,
  value: number | AgentModel | null,
): Pick<AutomationSettings, "levels"> | null {
  const current = { ...(settings.levels?.[level] ?? {}) } as Record<string, unknown>;
  const stored = current[key];
  const clear = value === null || value === levelDefault(settings, level, key);
  if (clear ? stored === undefined : JSON.stringify(stored) === JSON.stringify(value)) return null;
  if (clear) delete current[key];
  else current[key] = value;
  const levels: Record<string, unknown> = { ...(settings.levels ?? {}) };
  if (Object.keys(current).length) levels[level] = current;
  else delete levels[level];
  return { levels: Object.keys(levels).length ? (levels as LevelSettings) : undefined };
}
