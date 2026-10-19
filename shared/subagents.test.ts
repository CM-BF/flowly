import { describe, expect, it } from "vitest";
import { chipSegments, childAgents, parentAgentLabel, sessionTree, subagentBucket, subagentCounts, type SubagentSource } from "./subagents";

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

describe("sessionTree", () => {
  const agent = (id: string, createdAt: string, parent?: string): SubagentSource => ({
    id,
    createdAt,
    status: "idle",
    labels: parent ? { [parentAgentLabel]: parent } : {},
  });

  it("nests children under their parent, oldest first, and keeps main sessions in order", () => {
    const list = [agent("main-b", "2026-10-19T03:00:00Z"), agent("c2", "2026-10-19T02:30:00Z", "main-a"), agent("main-a", "2026-10-19T01:00:00Z"), agent("c1", "2026-10-19T02:00:00Z", "main-a")];
    expect(sessionTree(list).map((n) => [n.agent.id, n.children.map((c) => c.id)])).toEqual([
      ["main-b", []],
      ["main-a", ["c1", "c2"]],
    ]);
  });

  it("a grandchild goes under the top-most ancestor on the card", () => {
    const list = [agent("main", "1"), agent("child", "2", "main"), agent("grandchild", "3", "child")];
    expect(sessionTree(list)).toEqual([{ agent: list[0], children: [list[1], list[2]] }]);
  });

  it("a child whose parent is not on the card, and a cycle, stay main sessions", () => {
    const orphan = agent("orphan", "1", "elsewhere");
    const a = agent("a", "2", "b");
    const b = agent("b", "3", "a");
    expect(sessionTree([orphan]).map((n) => n.agent.id)).toEqual(["orphan"]);
    const tree = sessionTree([a, b]);
    expect(tree.map((n) => [n.agent.id, n.children.length])).toEqual([["a", 0], ["b", 0]]);
  });
});
