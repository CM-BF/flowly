import { createHash } from "node:crypto";
import type { HandoffGap } from "../shared/handoff";
import { locatedGapKinds } from "./handoff-capture";
import type { LegacyLongLine } from "./handoff-gap-migration-history";
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
/**
 * Where a long-line gap of `agentId` on `file` (a cursor identity, `dev:ino:birthtime:epoch`) starts, from its source: an
 * older build's (`capture-gap:long:<agent>:<file>:<start>:<text hash>`) or today's (`capture-gap:<agent>:long:<agent>:<file>:<start>`).
 */
const longSource = /^capture-gap:(?:[^:]+:)?long:([^:]+):(\d+:\d+:[\d.]+:\d+):(\d+)(?::[0-9a-f]{64})?$/;
export function longLineStart(sourceId: string, agentId: string, file: string) {
  const match = longSource.exec(sourceId);
  return match && match[1] === agentId && match[2] === file ? Number(match[3]) : undefined;
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

export type GapGroupDraft = { id: string; sourceId: string; agentId: string; text: string; count: number; firstAt?: string; lastAt?: string };
/**
 * How many occurrences a group states. `recorded`: the entries are every occurrence (no pass of that session hit the older
 * build's 100-gap cap); `history`: counted in the session's provider history over the bytes the older build read; `atLeast`:
 * a pass hit the cap and the history could not be counted, so the entries are a lower bound.
 */
export type GapMeasure = { count: number; basis: "recorded" | "history" | "atLeast" };
/** The open legacy gaps one group would replace: of one session, kind and type hint. */
export type GapBucket = { key: string; agentId: string; kind: string; hint?: string; gaps: HandoffGap[] };
/**
 * A session one of whose older-build passes hit the 100-gap cap (§21.19): the identity of the file its cursor names, whether
 * its provider history could be read up to that build's last cursor, and the lines over 256 KiB that build skipped that no
 * gap of an older build or of today's capture lists (none when not read).
 */
export type CappedSession = { agentId: string; file: string; read: boolean; lines: readonly LegacyLongLine[] };
export type GapInspection = { measures: ReadonlyMap<string, GapMeasure>; capped: readonly CappedSession[] };
export type GapMigrationPlan = {
  close: { id: string; note: string }[];
  groups: GapGroupDraft[];
  /** New open gaps for the long lines capped passes skipped without listing them. */
  added: GapGroupDraft[];
  /**
   * Closed as metadata, per type hint; opaque script gaps replaced; identical gaps grouped (and into how many); single gaps a
   * capped session's history showed to stand for more; long lines now listed; skipped compaction records; open gaps left as they were.
   */
  counts: { metadata: Record<string, number>; opaque: number; opaqueGroups: number; duplicates: number; duplicateGroups: number; singles: number; lines: number; compactions: number; kept: number };
  note?: string;
};
type Sessions = ReadonlyMap<string, { n: number; provider: string }>;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const bucketKey = (agentId: string, kind: string, hint?: string) => `${agentId}\0${kind}\0${hint ?? ""}`;
const draftId = (sourceId: string) => `g:${createHash("sha256").update(sourceId).digest("hex").slice(0, 32)}`;
const sessionLabel = (agentId: string, sessions: Sessions) => { const known = sessions.get(agentId); return known ? `#${known.n} (${agentId.slice(0, 8)})` : agentId ? `(${agentId.slice(0, 8)})` : "(unknown)"; };
/** "session #1 (…)", "sessions #1 (…) and #2 (…)". */
const sessionList = (agentIds: readonly string[], sessions: Sessions) => {
  const labels = agentIds.map((agentId) => sessionLabel(agentId, sessions));
  return `${labels.length === 1 ? "session" : "sessions"} ${labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0]}`;
};

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
  return { close, metadata, buckets: [...buckets.values()], kept };
}
/** Every bucket a migration may group, singles included, to measure before planning (GapMeasure). */
export const gapBuckets = (gaps: readonly HandoffGap[], sessions: Sessions) => sortGaps(gaps, sessions).buckets;
/**
 * Whether a bucket becomes one grouped gap. A script gap is replaced even alone, because the text says why it is there; two or
 * more identical gaps are grouped; one gap of another kind is already in today's grouped form, unless a capped session's
 * history shows it stood for more occurrences (§21.19).
 */
const groupsBucket = (bucket: GapBucket, measure: GapMeasure) => bucket.kind === "opaque_tool_background" || bucket.gaps.length >= 2 || measure.basis === "history" && measure.count > bucket.gaps.length;

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
/** Today's located long-line gap (HandoffObserver.captureGaps); the hint and message id give way so it ends whole in 300 characters. */
function lineText(line: LegacyLongLine) {
  const head = `Capture gap (long_line) in bytes ${line.start}–${line.end}: `, tail = `, ${line.end - line.start} bytes. This content was not preserved; that range of the session's raw history holds it.`;
  return head + `${line.hint}${line.messageId ? `, message ${line.messageId}` : ""}`.slice(0, 300 - head.length - tail.length) + tail;
}
/** The long lines past the own gaps of one session: counted, with where the first ones are (at most 300 characters). */
function moreText(lines: readonly LegacyLongLine[], label: string) {
  const ranges = lines.slice(0, 3).map((line) => `${line.start}–${line.end}`).join(", ");
  return lines.length === 1
    ? `Capture gap (long_line): 1 more line over 256 KiB in session ${label} that an older build skipped and never listed, in bytes ${ranges}. This content was not preserved; that session's raw history holds it.`
    : `Capture gap (long_line): ${lines.length} more lines over 256 KiB in session ${label} that an older build skipped and never listed, the first in bytes ${ranges}. This content was not preserved; that session's raw history holds them.`;
}
/** Own gaps per session for the long lines a capped pass did not list, like today's own located gaps per kind (captureLimits.hints); the rest are one counted gap. */
const ownLines = 8;
/**
 * The gaps for the long lines capped passes skipped without listing them, by today's rules: a Codex `compacted` record is a
 * compaction, not a gap (CaptureRecords.longLine); every other line is a gap in today's located form, the first `ownLines` of
 * a session each its own, the rest one counted gap. Their times are the lines' own.
 */
function lineDrafts(session: CappedSession, sessions: Sessions) {
  const lines = session.lines.filter((line) => !line.hint.startsWith("compacted")), drafts: GapGroupDraft[] = [];
  const times = (list: readonly LegacyLongLine[]) => { const at = list.flatMap((line) => line.at ? [line.at] : []).sort(); return at.length ? { firstAt: at[0], lastAt: at.at(-1)! } : {}; };
  for (const line of lines.slice(0, ownLines)) {
    const sourceId = handoffSource(`legacy-long:${session.agentId}:${session.file}:${line.start}`);
    drafts.push({ id: draftId(sourceId), sourceId, agentId: session.agentId, text: lineText(line), count: 1, ...times([line]) });
  }
  const rest = lines.slice(ownLines);
  if (rest.length) {
    const sourceId = handoffSource(`legacy-long:${session.agentId}:${session.file}:more`);
    drafts.push({ id: draftId(sourceId), sourceId, agentId: session.agentId, text: moreText(rest, sessionLabel(session.agentId, sessions)), count: rest.length, ...times(rest) });
  }
  return { drafts, lines: lines.length, compactions: session.lines.length - lines.length };
}
/**
 * What the note says about the capped sessions (§21.19): where the history was read, what was counted again and listed, and
 * that the kinds it cannot recognize may be missing; where it could not be read, that the groups are a lower bound and
 * skipped lines and other kinds may be missing.
 */
function capParts(capped: readonly CappedSession[], sessions: Sessions, lines: number, compactions: number) {
  const read = capped.filter((session) => session.read).map((session) => session.agentId), unread = capped.filter((session) => !session.read).map((session) => session.agentId);
  const parts: string[] = [];
  if (read.length) parts.push(`an older build stopped recording after 100 gaps per capture pass in ${sessionList(read, sessions)}: script calls and unknown record, event and response types there are counted in ${read.length === 1 ? "the session's" : "each session's"} provider history up to where that build read`
    + (lines ? `, and ${plural(lines, "line")} over 256 KiB that it skipped and never listed ${lines === 1 ? "is now a gap" : "are now gaps"}` : "")
    + (compactions ? ` (${plural(compactions, "skipped compaction record")} ${compactions === 1 ? "is" : "are"} not a gap under capture rules v2)` : "")
    + "; other kinds it raised past that cap (unparsable lines, images, system notices, tool-call problems) are not counted again and may be missing");
  if (unread.length) parts.push(`${read.length ? "in" : "an older build stopped recording after 100 gaps per capture pass in"} ${sessionList(unread, sessions)}${read.length ? " it also stopped recording after 100 gaps per pass" : ""} and ${unread.length === 1 ? "that session's provider history" : "their provider histories"} could not be read: ${unread.length === 1 ? "its" : "their"} groups say "at least", and lines over 256 KiB it skipped and other kinds past that cap may be missing`);
  return parts;
}

/**
 * Of the open gaps only: metadata is closed with the reason; each bucket that groups (groupsBucket) becomes one open gap
 * that states its measured count (the entries themselves when not measured); the long lines capped sessions skipped without
 * listing them become gaps (lineDrafts); everything else is not touched.
 */
export function planGapMigration(gaps: readonly HandoffGap[], sessions: Sessions, inspection: GapInspection = { measures: new Map(), capped: [] }): GapMigrationPlan {
  const sorted = sortGaps(gaps, sessions);
  const plan: GapMigrationPlan = { close: sorted.close, groups: [], added: [], counts: { metadata: sorted.metadata, opaque: 0, opaqueGroups: 0, duplicates: 0, duplicateGroups: 0, singles: 0, lines: 0, compactions: 0, kept: sorted.kept } };
  for (const bucket of sorted.buckets) {
    const opaque = bucket.kind === "opaque_tool_background", entries = bucket.gaps.length;
    const measure = inspection.measures.get(bucket.key) ?? { count: entries, basis: "recorded" as const };
    if (!groupsBucket(bucket, measure)) { plan.counts.kept += entries; continue; }
    // Not the live capture's group of the same session, kind and hint: its counts are its own, so later occurrences reopen it.
    // No firstAt/lastAt: the entries' times are when Flowly wrote them, not when the calls ran.
    const sourceId = handoffSource(`legacy-gaps:${bucket.agentId}:${bucket.kind}\0${bucket.hint ?? ""}`), id = draftId(sourceId);
    plan.groups.push({ id, sourceId, agentId: bucket.agentId, text: groupText(bucket, measure, sessionLabel(bucket.agentId, sessions)).slice(0, 300), count: Math.max(1, measure.count) });
    const note = `grouped by capture rules v2 into ${id}`;
    for (const gap of bucket.gaps) plan.close.push({ id: gap.id, note });
    if (opaque) { plan.counts.opaque += entries; plan.counts.opaqueGroups++; } else if (entries === 1) plan.counts.singles++; else { plan.counts.duplicates += entries; plan.counts.duplicateGroups++; }
  }
  for (const session of inspection.capped) {
    const listed = lineDrafts(session, sessions);
    plan.added.push(...listed.drafts); plan.counts.lines += listed.lines; plan.counts.compactions += listed.compactions;
  }
  if (!plan.close.length && !plan.added.length) return plan;
  const metadata = Object.entries(plan.counts.metadata).sort((a, b) => b[1] - a[1]), closed = metadata.reduce((sum, [, count]) => sum + count, 0);
  const parts = [
    closed ? `closed ${closed} metadata record${closed === 1 ? "" : "s"} (${metadata.map(([hint, count]) => `${hint} ${count}`).join(", ")})` : "",
    plan.counts.opaque ? `replaced ${plural(plan.counts.opaque, "per-call opaque_tool_background gap")} with ${plural(plan.counts.opaqueGroups, "grouped gap")}, one per session, to acknowledge once` : "",
    plan.counts.duplicates ? `grouped ${plan.counts.duplicates} identical gaps into ${plan.counts.duplicateGroups}` : "",
    plan.counts.singles ? `replaced ${plural(plan.counts.singles, "single gap")} that stood for more occurrences with ${plural(plan.counts.singles, "counted group")}` : "",
    ...capParts(inspection.capped, sessions, plan.counts.lines, plan.counts.compactions),
  ].filter(Boolean);
  plan.note = `Capture rules v2 (a one-time migration of the gaps older builds wrote once per occurrence): ${parts.join("; ")}. ${plural(plan.counts.kept, "other open gap")} unchanged. Each closed gap keeps its text and the reason in the archive.`.slice(0, 2000);
  return plan;
}
