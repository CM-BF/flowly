import type { BoardEvent, NextMove } from "./model";

/** The event an agent's flowly_suggest_next_moves records (NEXT-MOVES-SPEC §2). */
export const nextMovesAction = "next_moves_suggested";

/** The note stored with an empty suggestion, the agent's explicit "nothing for the user this turn" (NEXT-MOVES-SPEC §8.3). */
export const noMovesNote = "No next steps needed";

export type NextMovesEvent = BoardEvent & { moves: NextMove[] };

/** An explicit none (NEXT-MOVES-SPEC §8.5): a suggestion event whose list is empty, not one that has no list. */
export function isNoMoves(e: BoardEvent) {
  return e.action === nextMovesAction && Array.isArray(e.moves) && e.moves.length === 0;
}

/**
 * The session's suggested next messages for this turn (NEXT-MOVES-SPEC §3): its
 * latest suggestion, unless a turn of that session started after it.
 */
export function openNextMoves(events: readonly BoardEvent[], agentId: string): NextMovesEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.agentId !== agentId) continue;
    if (e.action === "agent.turn_started") return null;
    if (e.action === nextMovesAction) return e.moves?.length ? (e as NextMovesEvent) : null;
  }
  return null;
}

/** The moves to show: action moves (NEXT-MOVES-SPEC §7) go once the card is Done/Cancelled. */
export function shownMoves(moves: readonly NextMove[], cardFinished: boolean) {
  return cardFinished ? moves.filter((m) => !m.moveTo) : moves;
}

/** Composer text after picking a move: the prompt, after anything already typed (NEXT-MOVES-SPEC §4). */
export function nextMoveDraft(prompt: string, typed: string) {
  return typed.trim() ? `${typed.replace(/\s+$/, "")}\n\n${prompt}` : prompt;
}

/** Some session of the card has suggestions for this turn (the `next-move` tip, ONBOARDING-SPEC §5). */
export function hasOpenNextMoves(events: readonly BoardEvent[]) {
  const agents = new Set(events.filter((e) => e.action === nextMovesAction && e.agentId).map((e) => e.agentId!));
  return [...agents].some((agentId) => !!openNextMoves(events, agentId));
}
