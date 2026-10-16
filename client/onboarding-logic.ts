/** Pure decisions for first-run guidance (ONBOARDING-SPEC). No React, no storage. */

export const welcomePageCount = 4;

/** Page index after a Back/Next step, kept inside the tour. */
export function stepPage(page: number, direction: 1 | -1): number {
  return Math.max(0, Math.min(welcomePageCount - 1, page + direction));
}

export type WelcomeDecision = "wait" | "show" | "mark-seen" | "none";

/**
 * What to do with the welcome tour once settings and the board are known.
 * Unknown state never shows it; a user who already has a project is marked
 * as seen without being interrupted; only an empty board gets the tour.
 */
export function welcomeDecision(input: {
  settingsStatus: string;
  welcomeSeen: boolean;
  boardLoaded: boolean;
  projectCount: number;
  /** Another dialog or an open card is in the way. */
  blocked: boolean;
}): WelcomeDecision {
  if (input.settingsStatus !== "ready" || !input.boardLoaded) return "wait";
  if (input.welcomeSeen) return "none";
  if (input.projectCount > 0) return "mark-seen";
  return input.blocked ? "wait" : "show";
}

export const tipIds = ["first-card", "needs-you", "first-idea", "first-done"] as const;
export type TipId = (typeof tipIds)[number];

export interface TipFacts {
  /** The current project has at least one card. */
  hasCard: boolean;
  /** Some card is waiting for the user (question, approval or error). */
  needsYou: boolean;
  /** The Ideas inbox has an open item and the feature is on. */
  openIdea: boolean;
  /** The user just moved a card into Done or Cancelled. */
  movedToFinished: boolean;
}

const tipFact: Record<TipId, keyof TipFacts> = {
  "first-card": "hasCard",
  "needs-you": "needsYou",
  "first-idea": "openIdea",
  "first-done": "movedToFinished",
};

/** The one tip to show now: first in priority order whose fact holds and that was not shown before. */
export function nextTip(input: { tipsSeen: readonly string[]; facts: TipFacts; blocked: boolean }): TipId | null {
  if (input.blocked) return null;
  // Waiting for the user outranks introductions.
  const order: TipId[] = ["needs-you", "first-done", "first-idea", "first-card"];
  return order.find((id) => input.facts[tipFact[id]] && !input.tipsSeen.includes(id)) ?? null;
}

/** Stored tips with `id` added once (bounded like the setting). */
export function withTipSeen(tipsSeen: readonly string[], id: string): string[] {
  return tipsSeen.includes(id) ? [...tipsSeen] : [...tipsSeen, id].slice(-20);
}
