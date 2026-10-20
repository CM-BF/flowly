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

test("a subagent's unseen finished turn is not unread; its approvals and errors still need attention", async () => {
  const { sessionAttention } = await import("./session-attention");
  const base = { id: "child", workspaceId: "w", status: "idle" as const, requiresAttention: true, attentionReason: "finished" as const, labels: { "paseo.parent-agent-id": "main" } };
  expect(sessionAttention(base, "t").unread).toBe(false);
  expect(sessionAttention(base, "t").needsAttention).toBe(false);
  expect(sessionAttention({ ...base, labels: {} }, "t").unread).toBe(true);
  expect(sessionAttention({ ...base, attentionReason: "permission" as const, pendingPermissions: [{}] }, "t").needsAttention).toBe(true);
  expect(sessionAttention({ ...base, status: "error" as const }, "t").needsAttention).toBe(true);
  const marked = [{ taskId: "t", workspaceId: "w", agentId: "child", token: "manual-unread" }];
  expect(sessionAttention(base, "t", marked as never).unread).toBe(true);
});
