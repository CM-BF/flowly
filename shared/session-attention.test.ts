import { expect, test } from "vitest";
import { manualUnreadToken, sessionAttention, type AttentionAgent } from "./session-attention";

const agent: AttentionAgent = { id: "a", workspaceId: "w", status: "idle", requiresAttention: false };
const record = (token: string) => ({ taskId: "t", workspaceId: "w", agentId: "a", token, readAt: "2026-10-15T00:00:00.000Z" });

test("a manual unread mark keeps a session unread without native attention", () => {
  expect(sessionAttention(agent, "t").unread).toBe(false);
  const marked = sessionAttention(agent, "t", [record(manualUnreadToken)]);
  expect(marked).toMatchObject({ unread: true, manualUnread: true, needsAttention: true });
  expect(sessionAttention({ ...agent, archivedAt: "2026-10-15T00:00:00Z" }, "t", [record(manualUnreadToken)]).unread).toBe(false);
});

test("native attention is unread until its token is acknowledged", () => {
  const finished: AttentionAgent = { ...agent, requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-10-15T01:00:00.000Z" };
  const token = JSON.stringify(["a", "finished", "2026-10-15T01:00:00.000Z"]);
  expect(sessionAttention(finished, "t").unread).toBe(true);
  expect(sessionAttention(finished, "t", [record(token)]).unread).toBe(false);
  expect(sessionAttention(finished, "t", [record(manualUnreadToken)]).unread).toBe(true);
});
