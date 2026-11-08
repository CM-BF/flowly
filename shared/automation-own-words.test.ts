import { expect, test } from "vitest";
import type { Board } from "./model";
import { startedByUser, userTexts } from "./agent-habits";
import { isAutomationMessage, withoutAdaptiveOpening } from "./automation";
import { judgePrompt } from "../server/tournament";
import { checkFailedPrompt, reminderPrompt, thinPrompt } from "./adaptive";

// Flowly's own prompts are never the user's words: agent habits, rework quotes and memory clues skip them.
test("every Flowly-tagged prompt the fork sends to a card session is Flowly's, not the user's", () => {
  const prompts = [
    "[Flowly automation] Continue.",
    reminderPrompt("Your context is 80% full."),
    checkFailedPrompt("npm test", 1, "FAIL", 1, 2),
    "[Flowly acceptance] You write the independent acceptance tests.",
    "  [Flowly tournament] Your turn ended without a judgement.",
  ];
  for (const text of prompts) expect(isAutomationMessage(text), text).toBe(true);
  expect(startedByUser(prompts.map((text) => ({ type: "user_message", text })))).toBe(false);
  for (const text of ["Fix the login bug", "[Flowly auto review · rework 1/2]", "Flowly is great"]) expect(isAutomationMessage(text), text).toBe(false);
});

test("the tournament judge's prompt is Flowly's", () => {
  const text = judgePrompt({ title: "Add a CSV export", description: "" }, [], { workspace: "/w", candidates: [{ id: "c1", dir: "/c1" }, { id: "c2", dir: "/c2" }], failed: [] });
  expect(isAutomationMessage(text)).toBe(true);
});

test("an adaptive session's first turn drops the untagged opening prompt; later turns keep what the user said", () => {
  const opening = thinPrompt({ title: "Add a CSV export", description: "Export the table.", comments: [] });
  const turn = [{ type: "user_message", text: opening }, { type: "assistant_message", text: "Done." }];
  const board = (turns: number) => ({ events: Array.from({ length: turns }, () => ({ agentId: "s", action: "agent.turn_started" })) }) as unknown as Board;
  const first = withoutAdaptiveOpening(board(1), "s", turn);
  expect(userTexts(first)).toEqual([]);
  expect(startedByUser(first)).toBe(false);
  expect(first).toEqual([{ type: "assistant_message", text: "Done." }]);
  const later = [{ type: "user_message", text: "Also add a header row" }];
  expect(userTexts(withoutAdaptiveOpening(board(2), "s", later))).toEqual(["Also add a header row"]);
});
