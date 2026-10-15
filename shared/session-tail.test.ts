import { expect, test } from "vitest";
import { TAIL_REASONING_MAX, TAIL_TEXT_MAX, slimTimeline } from "./session-tail";

test("tail keeps what the UI reads and drops tool payloads", () => {
  const entries = slimTimeline([
    {
      seqStart: 7,
      timestamp: "2026-10-15T10:00:00Z",
      item: {
        type: "tool_call",
        name: "edit",
        status: "completed",
        callId: "c1",
        detail: { unifiedDiff: "x".repeat(100_000), content: "y".repeat(100_000) },
      },
    },
    { seqStart: 8, item: { type: "assistant_message", text: "Done", messageId: "m1" } },
    { item: { type: "user_message", text: "", clientMessageId: "u1" } },
    { item: null },
    { item: { text: "no type" } },
  ]);
  expect(entries).toEqual([
    { seqStart: 7, timestamp: "2026-10-15T10:00:00Z", item: { type: "tool_call", name: "edit", status: "completed", callId: "c1" } },
    { seqStart: 8, item: { type: "assistant_message", text: "Done", messageId: "m1" } },
    { item: { type: "user_message", text: "", clientMessageId: "u1" } },
  ]);
  expect(JSON.stringify(entries).length).toBeLessThan(400);
});

test("tail clips long messages and reasoning", () => {
  const [message, reasoning] = slimTimeline([
    { item: { type: "assistant_message", text: "a".repeat(TAIL_TEXT_MAX + 50) } },
    { item: { type: "reasoning", text: "r".repeat(TAIL_REASONING_MAX + 50) } },
  ]);
  expect(message.item.text).toHaveLength(TAIL_TEXT_MAX);
  expect(message.item.text!.endsWith("…")).toBe(true);
  expect(reasoning.item.text).toHaveLength(TAIL_REASONING_MAX);
});
