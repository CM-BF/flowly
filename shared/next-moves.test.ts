import { expect, test } from "vitest";
import type { BoardEvent } from "./model";
import { hasOpenNextMoves, nextMoveDraft, openNextMoves, shownMoves } from "./next-moves";

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
