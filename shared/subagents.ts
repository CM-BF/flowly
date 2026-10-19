/**
 * A session's Paseo-native child agents (SUBAGENTS-SPEC). Pure: no React, no SDK calls.
 */

/** Paseo's `PARENT_AGENT_ID_LABEL` (@getpaseo/protocol agent-labels). */
export const parentAgentLabel = "paseo.parent-agent-id";

export type SubagentBucket = "running" | "needs_input" | "failed" | "attention" | "done";

/** Buckets shown as chip segments, in Paseo's order; `done` is never a segment. */
export const segmentBuckets = ["running", "needs_input", "failed", "attention"] as const satisfies readonly SubagentBucket[];

export interface SubagentSource {
  id: string;
  createdAt: string;
  status: string;
  labels?: Record<string, string> | null;
  archivedAt?: string | null;
  pendingPermissions?: readonly unknown[] | null;
  requiresAttention?: boolean | null;
  attentionReason?: string | null;
}

export const parentOf = (agent: Pick<SubagentSource, "labels">): string | null => {
  const id = agent.labels?.[parentAgentLabel];
  return typeof id === "string" && id.trim() ? id.trim() : null;
};

/** Live children of `parentId`, oldest first (Paseo's order). */
export function childAgents<T extends SubagentSource>(agents: readonly T[], parentId: string): T[] {
  return agents
    .filter((a) => a.id !== parentId && !a.archivedAt && parentOf(a) === parentId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

export function subagentBucket(agent: SubagentSource): SubagentBucket {
  if (agent.pendingPermissions?.length || agent.attentionReason === "permission") return "needs_input";
  if (agent.status === "error" || agent.attentionReason === "error") return "failed";
  if (agent.status === "running" || agent.status === "initializing") return "running";
  if (agent.requiresAttention && agent.attentionReason === "finished") return "attention";
  return "done";
}

export type SubagentCounts = Record<SubagentBucket, number>;

export function subagentCounts(agents: readonly SubagentSource[]): SubagentCounts {
  const counts: SubagentCounts = { running: 0, needs_input: 0, failed: 0, attention: 0, done: 0 };
  for (const agent of agents) counts[subagentBucket(agent)]++;
  return counts;
}

/** The chip's segments: non-empty buckets in order; empty means "N subagents". */
export const chipSegments = (counts: SubagentCounts) =>
  segmentBuckets.filter((b) => counts[b] > 0).map((bucket) => ({ bucket, count: counts[bucket] }));

export interface SessionNode<T> {
  agent: T;
  /** Descendants started from this session, oldest first (grandchildren are flattened in). */
  children: T[];
}

/**
 * A card's sessions as main sessions with their subagents (DRAWER-SPEC, Main and sub sessions).
 * A session whose parent (or any ancestor) is also in the list goes under its top-most
 * such ancestor; everything else is a main session, in the given order. Cycles and
 * missing parents fall back to main sessions, so no session is ever hidden.
 */
export function sessionTree<T extends SubagentSource>(agents: readonly T[]): SessionNode<T>[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const rootOf = (agent: T): T => {
    let current = agent;
    const seen = new Set([agent.id]);
    for (;;) {
      const parent = parentOf(current);
      const next = parent ? byId.get(parent) : undefined;
      if (!next) return current;
      // A parent loop has no top: keep the session itself as a main session.
      if (seen.has(next.id)) return agent;
      seen.add(next.id);
      current = next;
    }
  };
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const agent of agents) {
    const root = rootOf(agent);
    if (root.id === agent.id) roots.push(agent);
    else children.set(root.id, [...(children.get(root.id) || []), agent]);
  }
  const oldestFirst = (a: T, b: T) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);
  return roots.map((agent) => ({ agent, children: (children.get(agent.id) || []).sort(oldestFirst) }));
}
