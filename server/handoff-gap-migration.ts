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
/** Where an older build's gap came from, as its source names it: `capture-gap:<prefix>:<agent>:<provider>:<session>:<file>:<epoch>:<offset>:<text hash>`. */
const legacySourceId = /^capture-gap:([a-z]+):([^:]+):(codex|claude):([^:]*):(\d+:\d+:[\d.]+:\d+):(\d+):([0-9a-f]{64})$/;
export type LegacySource = { prefix: string; agentId: string; provider: "codex" | "claude"; file: string; offset: number; textHash: string };
export function legacySource(sourceId: string | undefined): LegacySource | null {
  const match = legacySourceId.exec(sourceId ?? "");
  return match ? { prefix: match[1], agentId: match[2], provider: match[3] as "codex" | "claude", file: match[5], offset: Number(match[6]), textHash: match[7] } : null;
}
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
/** The text an older build gave a gap of this kind and hint (no location), whose hash its source carries. */
export const legacyGapText = (kind: string, hint?: string) => `Capture gap (${kind})${hint ? `: ${hint}` : ""}. This content was not preserved.`;
/** The source prefix those builds gave a kind (`opaque:`, `type:`, `event:`, `response:`). */
export const legacyPrefixes: Readonly<Record<string, string>> = { opaque_tool_background: "opaque", unknown_record_type: "type", unknown_event_type: "event", unknown_response_type: "response" };

export type GapGroupDraft = { id: string; sourceId: string; agentId: string; text: string; count: number };
/**
 * How many occurrences a group states. `recorded`: the entries are every occurrence (no pass of that session hit the older
 * build's 100-gap cap); `history`: counted in the session's provider history over the bytes the older build read; `atLeast`:
 * a pass hit the cap and the history could not be counted, so the entries are a lower bound.
 */
export type GapMeasure = { count: number; basis: "recorded" | "history" | "atLeast" };
/** The open legacy gaps one group would replace: of one session, kind and type hint. */
export type GapBucket = { key: string; agentId: string; kind: string; hint?: string; gaps: HandoffGap[] };
export type GapMigrationPlan = {
  close: { id: string; note: string }[];
  groups: GapGroupDraft[];
  /** Closed as metadata, per type hint; opaque script gaps replaced; identical gaps grouped (and into how many); open gaps left as they were. */
  counts: { metadata: Record<string, number>; opaque: number; opaqueGroups: number; duplicates: number; duplicateGroups: number; kept: number };
  note?: string;
};
type Sessions = ReadonlyMap<string, { n: number; provider: string }>;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const bucketKey = (agentId: string, kind: string, hint?: string) => `${agentId}\0${kind}\0${hint ?? ""}`;

/**
 * Sorts the open gaps: metadata is closed with the reason; a session's opaque_tool_background gaps go into one bucket; open
 * gaps of one session, kind and type hint that say nothing about where they are go into one bucket each; everything else
 * (located ones, real Flowly gaps, the agents' own, and legacy gaps an agent or person annotated) is kept as it is.
 */
function sortGaps(gaps: readonly HandoffGap[], sessions: Sessions) {
  const close: GapMigrationPlan["close"] = [], metadata: Record<string, number> = {}, buckets = new Map<string, GapBucket>();
  let kept = 0;
  for (const gap of gaps) {
    if (gap.status !== "open" || gap.unconfirmed) continue;
    const legacy = legacyGap(gap);
    // An agent's or person's note on a legacy gap it kept open is their own record: never superseded or grouped away.
    if (!legacy || gap.resolution && gap.resolution.by.kind !== "flowly") { kept++; continue; }
    const provider = legacy.provider ?? (legacy.kind === "unknown_timeline_type" ? "timeline" : sessions.get(gap.agentId ?? "")?.provider);
    const table = (gapMetadataV2 as Record<string, Record<string, ReadonlySet<string>>>)[legacy.kind]?.[provider ?? ""];
    if (legacy.hint && table?.has(legacy.hint)) {
      // Short on purpose: every closed version is an item of the full read; the gap's own text names the record type.
      close.push({ id: gap.id, note: "classified as metadata by capture rules v2" });
      metadata[legacy.hint] = (metadata[legacy.hint] ?? 0) + 1;
      continue;
    }
    if (legacy.kind !== "opaque_tool_background" && legacy.located) { kept++; continue; }
    const key = bucketKey(gap.agentId ?? "", legacy.kind, legacy.hint);
    const bucket = buckets.get(key) ?? { key, agentId: gap.agentId ?? "", kind: legacy.kind, ...(legacy.hint ? { hint: legacy.hint } : {}), gaps: [] };
    bucket.gaps.push(gap); buckets.set(key, bucket);
  }
  // One gap of a kind that today's capture would also keep as one is already in the grouped form; a script gap is
  // replaced even alone, because the text says why it is there.
  const groups = [...buckets.values()].filter((bucket) => bucket.kind === "opaque_tool_background" || bucket.gaps.length >= 2);
  kept += [...buckets.values()].filter((bucket) => !groups.includes(bucket)).reduce((sum, bucket) => sum + bucket.gaps.length, 0);
  return { close, metadata, groups, kept };
}
/** The buckets a migration would group, to measure before planning (GapMeasure). */
export const gapBuckets = (gaps: readonly HandoffGap[], sessions: Sessions) => sortGaps(gaps, sessions).groups;

const capNote = "; it stopped recording after 100 gaps per capture pass";
/** At most 300 characters for any count below 100,000 and session label up to "#99 (xxxxxxxx)" (a test holds it). */
function groupText(bucket: GapBucket, measure: GapMeasure, label: string) {
  const count = measure.count, atLeast = measure.basis === "atLeast", amount = `${atLeast ? "at least " : ""}${count}`;
  if (bucket.kind === "opaque_tool_background") {
    const calls = `${amount} script or workflow call${count === 1 ? "" : "s"} of session ${label} ${count === 1 && !atLeast ? "was" : "were"} captured by an older build`;
    return atLeast
      ? `Capture gap (opaque_tool_background): ${calls} without background detection; it stopped recording after 100 gaps per pass. Not checked for work left running: verify processes or search flowly_session_history.`
      : `Capture gap (opaque_tool_background): ${calls}, before Flowly's background detection. Not checked for work left running: verify running processes or search flowly_session_history before relying on it.`;
  }
  return `Capture gap (${bucket.kind})${bucket.hint ? `: ${bucket.hint}` : ""}: ${amount} occurrence${count === 1 ? "" : "s"} in session ${label} that an older build did not preserve${atLeast ? capNote : ""}. That session's raw history holds ${count === 1 && !atLeast ? "it" : "them"}.`;
}

/**
 * Of the open gaps only: metadata is closed with the reason; each bucket (gapBuckets) becomes one open gap that states its
 * `measures` count (the entries themselves when not measured); everything else is not touched.
 */
export function planGapMigration(gaps: readonly HandoffGap[], sessions: Sessions, measures: ReadonlyMap<string, GapMeasure> = new Map()): GapMigrationPlan {
  const sorted = sortGaps(gaps, sessions);
  const plan: GapMigrationPlan = { close: sorted.close, groups: [], counts: { metadata: sorted.metadata, opaque: 0, opaqueGroups: 0, duplicates: 0, duplicateGroups: 0, kept: sorted.kept } };
  let counted = false, bounded = false;
  for (const bucket of sorted.groups) {
    const opaque = bucket.kind === "opaque_tool_background", entries = bucket.gaps.length;
    const measure = measures.get(bucket.key) ?? { count: entries, basis: "recorded" as const };
    counted ||= measure.basis === "history"; bounded ||= measure.basis === "atLeast";
    const known = sessions.get(bucket.agentId), label = known ? `#${known.n} (${bucket.agentId.slice(0, 8)})` : bucket.agentId ? `(${bucket.agentId.slice(0, 8)})` : "(unknown)";
    // Not the live capture's group of the same session, kind and hint: its counts are its own, so later occurrences reopen it.
    // No firstAt/lastAt: the entries' times are when Flowly wrote them, not when the calls ran.
    const sourceId = handoffSource(`legacy-gaps:${bucket.agentId}:${bucket.kind}\0${bucket.hint ?? ""}`), id = `g:${createHash("sha256").update(sourceId).digest("hex").slice(0, 32)}`;
    plan.groups.push({ id, sourceId, agentId: bucket.agentId, text: groupText(bucket, measure, label).slice(0, 300), count: Math.max(1, measure.count) });
    const note = `grouped by capture rules v2 into ${id}`;
    for (const gap of bucket.gaps) plan.close.push({ id: gap.id, note });
    if (opaque) { plan.counts.opaque += entries; plan.counts.opaqueGroups++; } else { plan.counts.duplicates += entries; plan.counts.duplicateGroups++; }
  }
  if (!plan.close.length) return plan;
  const metadata = Object.entries(plan.counts.metadata).sort((a, b) => b[1] - a[1]), closed = metadata.reduce((sum, [, count]) => sum + count, 0);
  const parts = [
    closed ? `closed ${closed} metadata record${closed === 1 ? "" : "s"} (${metadata.map(([hint, count]) => `${hint} ${count}`).join(", ")})` : "",
    plan.counts.opaque ? `replaced ${plural(plan.counts.opaque, "per-call opaque_tool_background gap")} with ${plural(plan.counts.opaqueGroups, "grouped gap")}, one per session, to acknowledge once` : "",
    plan.counts.duplicates ? `grouped ${plan.counts.duplicates} identical gaps into ${plan.counts.duplicateGroups}` : "",
    counted ? "where an older build stopped recording after 100 gaps per capture pass, a group's count is what that build read, counted in the session's provider history" : "",
    bounded ? "where that history could not be counted, a group says \"at least\"" : "",
  ].filter(Boolean);
  plan.note = `Capture rules v2 (a one-time migration of the gaps older builds wrote once per occurrence): ${parts.join("; ")}. ${plural(plan.counts.kept, "other open gap")} unchanged. Each closed gap keeps its text and the reason in the archive.`.slice(0, 2000);
  return plan;
}
