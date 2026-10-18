import { describe, expect, test } from "vitest";
import {
  nativeAttentionToken,
  sessionAttention,
  sessionAttentionSummary,
} from "../../../../shared/session-attention";

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "workspace-a",
  status: "idle" as const,
  archivedAt: null,
  requiresAttention: true,
  attentionReason: "finished" as const,
  attentionTimestamp: "2026-10-14T01:00:00.000Z",
  pendingPermissions: [],
  lastUserMessageAt: null,
  ...extra,
});

describe("session attention pure contract", () => {
  test("uses exact native generation and native false as authoritative read state", () => {
    const current = agent("a");
    const token = nativeAttentionToken(current);
    expect(token).toBe(JSON.stringify(["a", "finished", "2026-10-14T01:00:00.000Z"]));
    expect(sessionAttention(current, "task", [{
      taskId: "task", workspaceId: "workspace-a", agentId: "a", token: token!, readAt: "2026-10-14T01:01:00.000Z",
    }]).unread).toBe(false);
    expect(sessionAttention(agent("a", { attentionTimestamp: "2026-10-14T02:00:00.000Z" }), "task", [{
      taskId: "task", workspaceId: "workspace-a", agentId: "a", token: token!, readAt: "2026-10-14T01:01:00.000Z",
    }]).unread).toBe(true);
    expect(sessionAttention(agent("a", { requiresAttention: false }), "task").unread).toBe(false);
  });

  test("keeps missing and invalid timestamp unread without inventing an acknowledgeable token", () => {
    for (const timestamp of [null, "not-a-date"]) {
      const value = agent("a", { attentionTimestamp: timestamp });
      expect(nativeAttentionToken(value)).toBeNull();
      expect(sessionAttention(value, "task").unread).toBe(true);
    }
    expect(sessionAttention(agent("a", { requiresAttention: undefined }), "task")).toMatchObject({ unread: false, readKnown: false });
  });

  test("aggregates mixed states once, excluding archived sessions and other workspaces", () => {
    const active = [
      agent("running", { status: "running", attentionReason: "permission", pendingPermissions: [{}] }),
      agent("starting", { status: "initializing" }),
      agent("ended", { attentionReason: null, attentionTimestamp: null }),
      agent("error", { status: "error", attentionReason: "error" }),
      agent("archived", { archivedAt: "2026-10-14T00:00:00Z" }),
      agent("elsewhere", { workspaceId: "workspace-b" }),
    ];
    const events = [
      { id: "e1", taskId: "task", agentId: "ended", action: "agent.turn_ended", at: "2026-10-14T01:30:00Z" },
      { id: "e2", taskId: "task", agentId: "ended", action: "agent.turn_started", at: "2026-10-14T01:40:00Z" },
    ] as any;
    expect(sessionAttentionSummary(active, { id: "task", workspaceId: "workspace-a" }, [], events)).toEqual({
      total: 4, running: 1, starting: 1, finished: 0, unread: 4, attention: 4,
      permissions: 1, questions: 0, errors: 1, unknownRead: 0,
    });
  });

  test("a turn-ended event is finished only until a newer prompt, start, or error", () => {
    const ended = { id: "e", taskId: "task", agentId: "a", action: "agent.turn_ended", at: "2026-10-14T01:00:00Z" } as any;
    expect(sessionAttention(agent("a", { attentionReason: null, attentionTimestamp: null }), "task", [], [ended]).finished).toBe(true);
    expect(sessionAttention(agent("a", { attentionReason: null, attentionTimestamp: null, lastUserMessageAt: "2026-10-14T02:00:00Z" }), "task", [], [ended]).finished).toBe(false);
    expect(sessionAttention(agent("a", { status: "error", attentionReason: "error" }), "task", [], [ended]).finished).toBe(false);
    const startedLater = { id: "s", taskId: "task", agentId: "a", action: "agent.turn_started", at: "2026-10-14T02:00:00Z" } as any;
    expect(sessionAttention(agent("a", { attentionTimestamp: "2026-10-14T01:00:00.000Z" }), "task", [], [startedLater]).finished).toBe(false);
    expect(typeof sessionAttention(agent("a"), "task").finished).toBe("boolean");
  });

  test("reading does not resolve an error or permission attention union", () => {
    const permission = agent("p", { attentionReason: "permission", pendingPermissions: [{}] });
    const token = nativeAttentionToken(permission)!;
    const state = sessionAttention(permission, "task", [{ taskId: "task", workspaceId: "workspace-a", agentId: "p", token, readAt: "2026-10-14T01:01:00Z" }]);
    expect(state).toMatchObject({ unread: false, permission: true, needsAttention: true });
    const failed = agent("e", { status: "error", attentionReason: "error" });
    const errorToken = nativeAttentionToken(failed)!;
    expect(sessionAttention(failed, "task", [{ taskId: "task", workspaceId: "workspace-a", agentId: "e", token: errorToken, readAt: "2026-10-14T01:01:00Z" }])).toMatchObject({ unread: false, error: true, needsAttention: true });
  });
});
