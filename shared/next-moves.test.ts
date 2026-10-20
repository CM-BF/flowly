import { expect, test } from "vitest";
import type { BoardEvent } from "./model";
import { hasOpenNextMoves, isNoMoves, needsNextMoves, nextMoveDraft, openNextMoves, shownMoves } from "./next-moves";

const ev = (id: string, action: string, agentId = "a", extra: Partial<BoardEvent> = {}): BoardEvent => ({
  id, taskId: "t", actor: action.startsWith("agent.") ? "system" : "agent", action, agentId,
  at: `2026-10-19T00:00:0${id}Z`, ...extra,
});
const moves = (label: string) => ({ moves: [{ label, prompt: `${label}, please` }] });

test("a session's suggestions last until its next turn starts; the latest set wins", () => {
  const turn = [ev("1", "agent.turn_started"), ev("2", "next_moves_suggested", "a", moves("Verify")), ev("3", "agent.turn_ended")];
  expect(openNextMoves(turn, "a")?.moves[0].label).toBe("Verify");
  expect(openNextMoves([...turn, ev("4", "next_moves_suggested", "a", moves("Commit"))], "a")?.moves[0].label).toBe("Commit");
  expect(openNextMoves([...turn, ev("4", "agent.turn_started")], "a")).toBeNull();
  // Other sessions' turns and reports do not touch it.
  expect(openNextMoves([...turn, ev("4", "agent.turn_started", "b"), ev("5", "progress_reported")], "a")?.id).toBe("2");
  expect(openNextMoves(turn, "b")).toBeNull();
  expect(openNextMoves([ev("1", "next_moves_suggested", "a", { moves: [] })], "a")).toBeNull();
});

test("the card has open suggestions while any session does", () => {
  const events = [ev("1", "next_moves_suggested", "a", moves("A")), ev("2", "next_moves_suggested", "b", moves("B")), ev("3", "agent.turn_started", "a")];
  expect(hasOpenNextMoves(events)).toBe(true);
  expect(hasOpenNextMoves([...events, ev("4", "agent.turn_started", "b")])).toBe(false);
  expect(hasOpenNextMoves([])).toBe(false);
});

test("picking a move fills an empty composer and never overwrites typed text", () => {
  expect(nextMoveDraft("Commit and push.", "")).toBe("Commit and push.");
  expect(nextMoveDraft("Commit and push.", "  \n")).toBe("Commit and push.");
  expect(nextMoveDraft("Commit and push.", "Also update the docs.\n")).toBe("Also update the docs.\n\nCommit and push.");
});

test("action moves go once the card is finished; message moves stay", () => {
  const list = [{ label: "Commit", prompt: "Commit." }, { label: "Move to Done", moveTo: "done" as const }];
  expect(shownMoves(list, false)).toEqual(list);
  expect(shownMoves(list, true)).toEqual([list[0]]);
  expect(shownMoves([list[1]], true)).toEqual([]);
});

test("an empty suggestion after a non-empty one leaves nothing open; isNoMoves tells it apart (NEXT-MOVES-SPEC §8)", () => {
  const none = ev("3", "next_moves_suggested", "a", { moves: [] });
  const turn = [ev("1", "agent.turn_started"), ev("2", "next_moves_suggested", "a", moves("Verify")), none];
  expect(openNextMoves(turn, "a")).toBeNull();
  expect(hasOpenNextMoves(turn)).toBe(false);
  // A later non-empty set brings chips back.
  expect(openNextMoves([...turn, ev("4", "next_moves_suggested", "a", moves("Commit"))], "a")?.moves[0].label).toBe("Commit");
  // Only an explicit none: not a suggestion, not another action, not an event that has no list at all.
  expect(isNoMoves(none)).toBe(true);
  expect(isNoMoves(turn[1])).toBe(false);
  expect(isNoMoves(ev("5", "progress_reported", "a", { moves: [] }))).toBe(false);
  expect(isNoMoves(ev("6", "next_moves_suggested", "a"))).toBe(false);
});

test("a session still owes next moves until it suggests some, or none, in its current turn on this card (NEXT-MOVES-SPEC §9.3)", () => {
  const turn = [ev("1", "agent.turn_started"), ev("2", "progress_reported")];
  expect(needsNextMoves(turn, "t", "a")).toBe(true);
  expect(needsNextMoves([...turn, ev("3", "next_moves_suggested", "a", moves("Verify"))], "t", "a")).toBe(false);
  // An explicit none is a decision too.
  expect(needsNextMoves([...turn, ev("3", "next_moves_suggested", "a", { moves: [] })], "t", "a")).toBe(false);
  // A new turn of this session starts over; another session's turn or suggestion does not.
  const done = [...turn, ev("3", "next_moves_suggested", "a", moves("Verify"))];
  expect(needsNextMoves([...done, ev("4", "agent.turn_started")], "t", "a")).toBe(true);
  expect(needsNextMoves([...done, ev("4", "agent.turn_started", "b")], "t", "a")).toBe(false);
  expect(needsNextMoves(turn, "t", "b")).toBe(true);
  expect(needsNextMoves([...turn, ev("3", "next_moves_suggested", "b", moves("Verify"))], "t", "a")).toBe(true);
  // The board holds every card's events: another card's suggestion or turn start is not this card's.
  expect(needsNextMoves([...turn, ev("3", "next_moves_suggested", "a", { ...moves("Verify"), taskId: "other" })], "t", "a")).toBe(true);
  expect(needsNextMoves([...done, ev("4", "agent.turn_started", "a", { taskId: "other" })], "t", "a")).toBe(false);
  // No turn start retained (lifecycle events missing): the history is one turn, which only silences a reminder.
  expect(needsNextMoves([ev("1", "next_moves_suggested", "a", moves("Verify"))], "t", "a")).toBe(false);
  expect(needsNextMoves([], "t", "a")).toBe(true);
});
