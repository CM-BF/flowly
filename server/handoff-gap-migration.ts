import { createHash } from "node:crypto";
import type { HandoffGap } from "../shared/handoff";
import { locatedGapKinds } from "./handoff-capture";
import { handoffSource } from "./handoff-source";

/**
 * The one-time migration of the capture gaps older builds (684a8fd, 786d9cd) wrote once per occurrence (SESSION-HANDOFF-SPEC
 * §21.17). Capture rules v2 are today's: metadata records are no gap, gaps are grouped per session, kind and type hint, and a
 * script call is background work only with evidence of it. Pure: the store applies the plan in one transaction.
 */
export const gapRules = "capture rules v2";
export const gapMigration = { version: 1, operationId: "capture-rules-v2:legacy-gaps", marker: ".gap-migration.json" } as const;

/**
 * What the older builds raised as a gap and capture rules v2 read as metadata, per gap kind and provider: exactly the record,
 * event and timeline types they flagged that the current capture skips without a gap (a contract test runs each through it).
 * Types whose content is captured now (a /goal objective, a sub-agent's answer, a queued delivery, a linked pull request) are
 * not here: the older build lost that content, so the gap stays.
 */
export const gapMetadataV2 = {
  unknown_record_type: {
    codex: new Set(["token_usage_record", "world_state", "inter_agent_communication_metadata"]),
    claude: new Set(["file-history-delta", "agent-name", "atis-latch", "cost-state", "mode", "permission-mode", "api-request", "api-request-blob", "api-request-shape"]),
  },
  unknown_event_type: { codex: new Set(["thread_settings_applied"]) },
  unknown_timeline_type: { timeline: new Set(["todo", "compaction"]) },
} as const satisfies Record<string, Record<string, ReadonlySet<string>>>;

const legacyText = /^Capture gap \(([a-z_]{1,60})\)(?: in bytes (\d+)–(\d+))?(?:: ([\s\S]*?))?\. This content was not preserved\.$/;
export type LegacyGap = { kind: string; hint?: string; located: boolean; provider?: string };
/**
 * A gap an older build wrote: Flowly's, no count, its source the capture gap id and the hash of its text (hashed whole when
 * long), and its text in the old template. Today's located gaps say where the raw history holds the content and today's
 * grouped gaps carry a count, so neither matches.
 */
export function legacyGap(gap: HandoffGap): LegacyGap | null {
  if (gap.by.kind !== "flowly" || gap.kind !== "flowly" || gap.count !== undefined || !gap.sourceId || !/^(?:capture-gap:|sha256:)/.test(gap.sourceId)) return null;
  const match = legacyText.exec(gap.text);
  if (!match) return null;
  const provider = /^capture-gap:[a-z-]+:[^:]+:(codex|claude|timeline):/.exec(gap.sourceId)?.[1];
  return { kind: match[1], ...(match[4] ? { hint: match[4] } : {}), located: locatedGapKinds.has(match[1]) || match[2] !== undefined, ...(provider ? { provider } : {}) };
}

export type GapGroupDraft = { id: string; sourceId: string; agentId: string; text: string; count: number; firstAt?: string; lastAt?: string };
export type GapMigrationPlan = {
  close: { id: string; note: string }[];
  groups: GapGroupDraft[];
  /** Closed as metadata, per type hint; opaque script gaps replaced; identical gaps grouped (and into how many); open gaps left as they were. */
  counts: { metadata: Record<string, number>; opaque: number; opaqueGroups: number; duplicates: number; duplicateGroups: number; kept: number };
  note?: string;
};
type Sessions = ReadonlyMap<string, { n: number; provider: string }>;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Of the open gaps only: metadata is closed with the reason; a session's opaque_tool_background gaps become one open gap that
 * counts them; two or more open gaps of one session, kind and type hint that say nothing about where they are become one
 * open gap like today's grouped ones; everything else (located ones, real Flowly gaps, the agents' own) is not touched.
 */
export function planGapMigration(gaps: readonly HandoffGap[], sessions: Sessions): GapMigrationPlan {
  const plan: GapMigrationPlan = { close: [], groups: [], counts: { metadata: {}, opaque: 0, opaqueGroups: 0, duplicates: 0, duplicateGroups: 0, kept: 0 } };
  const buckets = new Map<string, { agentId: string; kind: string; hint?: string; gaps: HandoffGap[] }>();
  for (const gap of gaps) {
    if (gap.status !== "open" || gap.unconfirmed) continue;
    const legacy = legacyGap(gap);
    if (!legacy) { plan.counts.kept++; continue; }
    const provider = legacy.provider ?? (legacy.kind === "unknown_timeline_type" ? "timeline" : sessions.get(gap.agentId ?? "")?.provider);
    const metadata = (gapMetadataV2 as Record<string, Record<string, ReadonlySet<string>>>)[legacy.kind]?.[provider ?? ""];
    if (legacy.hint && metadata?.has(legacy.hint)) {
      // Short on purpose: every closed version is an item of the full read; the gap's own text names the record type.
      plan.close.push({ id: gap.id, note: "classified as metadata by capture rules v2" });
      plan.counts.metadata[legacy.hint] = (plan.counts.metadata[legacy.hint] ?? 0) + 1;
      continue;
    }
    if (legacy.kind !== "opaque_tool_background" && legacy.located) { plan.counts.kept++; continue; }
    const key = `${gap.agentId ?? ""}\0${legacy.kind}\0${legacy.hint ?? ""}`;
    const bucket = buckets.get(key) ?? { agentId: gap.agentId ?? "", kind: legacy.kind, ...(legacy.hint ? { hint: legacy.hint } : {}), gaps: [] };
    bucket.gaps.push(gap); buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    const opaque = bucket.kind === "opaque_tool_background", count = bucket.gaps.length;
    // One gap of a kind that today's capture would also keep as one is already in the grouped form; a script gap is
    // replaced even alone, because the text says why it is there.
    if (!opaque && count < 2) { plan.counts.kept += count; continue; }
    const known = sessions.get(bucket.agentId), label = known ? `#${known.n} (${bucket.agentId.slice(0, 8)})` : bucket.agentId ? `(${bucket.agentId.slice(0, 8)})` : "(unknown)";
    // Not the live capture's group of the same session, kind and hint: its counts are its own, so later occurrences reopen it.
    const sourceId = handoffSource(`legacy-gaps:${bucket.agentId}:${bucket.kind}\0${bucket.hint ?? ""}`), id = `g:${createHash("sha256").update(sourceId).digest("hex").slice(0, 32)}`;
    const times = bucket.gaps.map((gap) => gap.firstAt ?? gap.at).filter(Boolean).sort();
    const text = opaque
      ? `Capture gap (opaque_tool_background): ${plural(count, "script or workflow call")} of session ${label} predate Flowly's background detection (an older build wrote one gap per call). Not checked for work left running: verify running processes or search flowly_session_history before relying on it.`
      : `Capture gap (${bucket.kind})${bucket.hint ? `: ${bucket.hint}` : ""}: ${count} occurrences in session ${label}, written one by one by an older build and grouped here. This content was not preserved; that session's raw history holds it.`;
    plan.groups.push({ id, sourceId, agentId: bucket.agentId, text: text.slice(0, 300), count, ...(times.length ? { firstAt: times[0], lastAt: times.at(-1) } : {}) });
    const note = `grouped by capture rules v2 into ${id}`;
    for (const gap of bucket.gaps) plan.close.push({ id: gap.id, note });
    if (opaque) { plan.counts.opaque += count; plan.counts.opaqueGroups++; } else { plan.counts.duplicates += count; plan.counts.duplicateGroups++; }
  }
  if (!plan.close.length) return plan;
  const metadata = Object.entries(plan.counts.metadata).sort((a, b) => b[1] - a[1]), closed = metadata.reduce((sum, [, count]) => sum + count, 0);
  const parts = [
    closed ? `closed ${closed} metadata record${closed === 1 ? "" : "s"} (${metadata.map(([hint, count]) => `${hint} ${count}`).join(", ")})` : "",
    plan.counts.opaque ? `replaced ${plural(plan.counts.opaque, "per-call opaque_tool_background gap")} with ${plural(plan.counts.opaqueGroups, "grouped gap")}, one per session, to acknowledge once` : "",
    plan.counts.duplicates ? `grouped ${plan.counts.duplicates} identical gaps into ${plan.counts.duplicateGroups}` : "",
  ].filter(Boolean);
  plan.note = `Capture rules v2 (a one-time migration of the gaps older builds wrote once per occurrence): ${parts.join("; ")}. ${plural(plan.counts.kept, "other open gap")} unchanged. Each closed gap keeps its text and the reason in the archive.`.slice(0, 2000);
  return plan;
}
