import { expect, test, vi } from "vitest";
import {
  sessionState,
  openNativeSession,
  recentSessionOutput,
  groupTranscript,
  activitySummary,
} from "./session-state";
import type { BoardEvent } from "../shared/model";

const actor = {
  id: "a",
  status: "idle",
  pendingPermissions: [],
  lastUserMessageAt: null,
} as Parameters<typeof sessionState>[0];
const event = (action: string, at: string): BoardEvent => ({
  id: at,
  taskId: "t",
  actor: "system",
  agentId: "a",
  action,
  at,
});
test("session state distinguishes actual work, permission, error and archive", () => {
  expect(sessionState(actor).label).toBe("Ready");
  expect(sessionState({ ...actor, status: "initializing" }).label).toBe(
    "Starting",
  );
  expect(sessionState({ ...actor, status: "running" }).label).toBe("Running");
  expect(
    sessionState({ ...actor, status: "running", attentionReason: "permission" })
      .label,
  ).toBe("Waiting for approval");
  expect(sessionState({ ...actor, status: "error" }).label).toBe("Error");
  expect(sessionState({ ...actor, status: "closed" }).label).toBe("Closed");
  expect(sessionState({ ...actor, archivedAt: "now" }).label).toBe("Archived");
});
test("finished and ended signals never replace a newer turn or user message", () => {
  expect(sessionState({ ...actor, attentionReason: "finished" }).label).toBe(
    "Finished turn",
  );
  const ended = event("agent.turn_ended", "2026-10-14T00:10:00Z");
  expect(sessionState(actor, [ended]).label).toBe("Turn ended");
  expect(
    sessionState({ ...actor, lastUserMessageAt: "2026-10-14T00:11:00Z" }, [
      ended,
    ]).label,
  ).toBe("Idle");
  expect(
    sessionState(actor, [
      ended,
      event("agent.turn_started", "2026-10-14T00:12:00Z"),
    ]).label,
  ).toBe("Ready");
  expect(
    sessionState({ ...actor, status: "running", attentionReason: "finished" }, [
      ended,
    ]).label,
  ).toBe("Running");
});
test("native opening targets the exact session and host, and tolerates absent navigation", () => {
  const openAgent = vi.fn();
  expect(
    openNativeSession({ openAgent, openWorkspace: vi.fn() }, "a", "host"),
  ).toBe(true);
  expect(openAgent).toHaveBeenCalledWith({ agentId: "a", serverId: "host" });
  expect(openNativeSession(undefined, "a", "host")).toBe(false);
});
test("preview extracts only recent text with reader-facing author labels", () => {
  const output = recentSessionOutput([
    { item: { type: "tool_call" } },
    { item: { type: "assistant_message", text: "Done" } },
    { item: { type: "user_message", text: "Next" } },
  ]);
  expect(output.map((x) => [x.author, x.text])).toEqual([
    ["Agent", "Done"],
    ["You", "Next"],
  ]);
  expect(
    recentSessionOutput(
      Array.from({ length: 30 }, (_, n) => ({
        item: { type: "assistant_message", text: String(n) },
      })),
    ),
  ).toHaveLength(18);
});

test("consecutive thinking and tool calls merge into one activity block", () => {
  const entry = (key: string, author: string) => ({ key, author, text: key, kind: author, messageId: undefined });
  const blocks = groupTranscript([
    entry("u", "You"),
    entry("t1", "Thinking"),
    entry("c1", "Tool"),
    entry("c2", "Tool"),
    entry("a", "Agent"),
    entry("c3", "Tool"),
  ]);
  expect(blocks.map((b) => b.kind)).toEqual(["entry", "activity", "entry", "activity"]);
  const first = blocks[1] as Extract<(typeof blocks)[number], { kind: "activity" }>;
  expect(first.key).toBe("activity-t1");
  expect(first.items.map((i) => i.key)).toEqual(["t1", "c1", "c2"]);
  expect(activitySummary(first)).toBe("Thought · 2 tool calls");
  expect(activitySummary({ thoughts: 0, tools: 1 })).toBe("1 tool call");
});
