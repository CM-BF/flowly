import { describe, expect, it } from "vitest";
import { chipSegments, childAgents, subagentBucket, subagentCounts, type SubagentSource } from "./subagents";

const agent = (over: Partial<SubagentSource> & { id: string }): SubagentSource => ({
  createdAt: "2026-10-19T08:00:00.000Z",
  status: "idle",
  labels: {},
  ...over,
});
const child = (id: string, parent: string, over: Partial<SubagentSource> = {}) =>
  agent({ id, labels: { "paseo.parent-agent-id": parent }, ...over });

describe("childAgents", () => {
  it("lists live children of the parent only, oldest first", () => {
    const list = [
      child("b", "p", { createdAt: "2026-10-19T08:02:00.000Z" }),
      child("a", "p", { createdAt: "2026-10-19T08:01:00.000Z" }),
      child("x", "other"),
      child("gone", "p", { archivedAt: "2026-10-19T09:00:00.000Z" }),
      agent({ id: "p" }),
      agent({ id: "plain" }),
    ];
    expect(childAgents(list, "p").map((a) => a.id)).toEqual(["a", "b"]);
  });
  it("ignores a self-reference and blank labels", () => {
    expect(childAgents([child("p", "p"), child("y", " ")], "p")).toEqual([]);
  });
});

describe("subagentBucket", () => {
  it("puts waiting before failure and failure before running", () => {
    expect(subagentBucket(agent({ id: "1", status: "running", pendingPermissions: [{}] }))).toBe("needs_input");
    expect(subagentBucket(agent({ id: "2", status: "idle", attentionReason: "permission" }))).toBe("needs_input");
    expect(subagentBucket(agent({ id: "3", status: "error" }))).toBe("failed");
    expect(subagentBucket(agent({ id: "4", status: "idle", attentionReason: "error" }))).toBe("failed");
    expect(subagentBucket(agent({ id: "5", status: "initializing" }))).toBe("running");
    expect(subagentBucket(agent({ id: "6", requiresAttention: true, attentionReason: "finished" }))).toBe("attention");
    expect(subagentBucket(agent({ id: "7", requiresAttention: false, attentionReason: "finished" }))).toBe("done");
    expect(subagentBucket(agent({ id: "8", status: "closed" }))).toBe("done");
  });
});

describe("chipSegments", () => {
  it("shows non-empty buckets in Paseo's order and never done", () => {
    const counts = subagentCounts([
      agent({ id: "1", status: "error" }),
      agent({ id: "2", status: "running" }),
      agent({ id: "3", status: "running" }),
      agent({ id: "4" }),
    ]);
    expect(chipSegments(counts)).toEqual([
      { bucket: "running", count: 2 },
      { bucket: "failed", count: 1 },
    ]);
  });
  it("is empty when every child is done", () => {
    expect(chipSegments(subagentCounts([agent({ id: "1" })]))).toEqual([]);
  });
});
