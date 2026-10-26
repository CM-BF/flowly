import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { locateProviderHistory, type HistoryAgent, type NativeHistoryFile } from "./provider-history";
import { CaptureRecords, lineHint, captureLimits, type PendingCaptureCall, type ScriptPool } from "./handoff-capture-records";

export { captureLimits };
export type CaptureSource = { agentId: string; provider: string; fileId?: string; sessionId?: string; offset?: number; end?: number; messageId?: string };
/** `unlinked`: Codex's own copy of a message (item_completed UserMessage), without Paseo's message id; the observer dedupes it by text against what the card already holds. */
export type CaptureMessage = { id: string; source: CaptureSource; text: string; at: string; atSource: "provider" | "captured"; messageId?: string; via: "session" | "agent"; senderId?: string; senderTitle?: string; redacted?: boolean; status: "open" | "received"; unlinked?: true };
export type CaptureNarration = Omit<CaptureMessage, "via" | "status"> & { truncated?: boolean };
/**
 * `closeOnly`: a completion that may close an item already recorded (by id, call id or handle) but never creates one.
 * `late`: a completion whose start was never itemized; when no item matches its handle it settles the oldest evidence-free placeholder of its kind.
 * `note`: what the completion said (status, summary, output file, result, recovery); always written as a card note. `metadataOnly`: rebuilt from
 *   a timeline row without the notice's own text; it never replaces a note from that text, and that text replaces it.
 * `reopen`: new work for an item that had ended (a follow-up task to a sub-agent): it opens a closed item again.
 * `keepLabel`: evidence that something runs, not what it is: an existing item keeps its label.
 * `inFlight`: a start call whose result has not been read yet: a placeholder without evidence, until its result arrives.
 * `event`: the latest progress a running task reported (a Claude Monitor event): kept on its item, never a note or an end.
 */
export type CaptureBackground = { id: string; source: CaptureSource; kind: "async_shell" | "exec" | "browser" | "terminal" | "workspace_script" | "agent" | "schedule" | "heartbeat"; handle?: string; callId?: string; status: "open" | "closed" | "unknown"; label?: string; outcome?: string; at: string; closeOnly?: boolean; /** A script pool's tally no longer needs this placeholder while members still run: it ends one in observation state only. */ withdraw?: true; late?: boolean; reopen?: boolean; keepLabel?: boolean; inFlight?: true; event?: string; note?: { id: string; text: string; kind: "background" | "hazard"; metadataOnly?: true } };
/**
 * One gap per kind and type hint in a batch: `id`/`source`/`from` are its first occurrence, `count` all of them, `at`/`lastAt` the first and last time.
 * Location-bearing kinds (`locatedGapKinds`) are never merged: each keeps its byte range and message id. `occurrences`: stable identities of timeline rows (bounded).
 */
export type CaptureGap = { id: string; kind: string; source?: CaptureSource; from?: number; to?: number; bytes?: number; count?: number; typeHint?: string; at?: string; lastAt?: string; occurrences?: string[]; /** Byte ranges of the first occurrences of a counted located group (bounded). */ ranges?: string[] };
/** Gaps that say where skipped content is in the raw history (a long human paste, an unparsable line, a replaced file). */
export const locatedGapKinds: ReadonlySet<string> = new Set(["long_line", "long_line_partial", "parse_failed", "file_truncated", "file_replaced", "file_moved"]);
export type CaptureUsage = { id: string; source: CaptureSource; at: string; atSource?: "provider" | "captured"; contextTokens: number; windowTokens?: number; initialContextTokens?: number; cacheTtlSeconds?: number; messageId?: string };
/** A card note from what reached the session (`kind` defaults to other): warnings, plugin transfers, an async shell's failure or update. */
export type CaptureNotice = { id: string; text: string; at: string; kind?: "background" | "hazard" | "other" };
/** `notices`: host messages worth a card note. `anchors`: external identifiers (a linked pull request). `scriptCalls`: script/workflow calls seen in this batch or timeline. */
export type CaptureSemantics = { inputs: CaptureMessage[]; live: CaptureNarration[]; background: CaptureBackground[]; usage: CaptureUsage[]; compactions: { id: string; source: CaptureSource; at: string; preTokens?: number; captured?: boolean }[]; gaps: CaptureGap[]; notices: CaptureNotice[]; anchors: string[]; omittedGaps: number; narrationOmitted: number; narrationTrimmedChars: number; scriptCalls: number };
export type CaptureCursor = { version: 1; provider: "codex" | "claude"; sessionId: string; fileId: string; path: string; epoch: number; offset: number; prefix?: { length: number; hash: string }; anchor?: { offset: number; length: number; hash: string }; skipping?: { start: number; bytes: number; typeHint: string; at?: string; messageId?: string; result?: { callId: string; exit: string } }; calls?: PendingCaptureCall[]; closed?: string[]; sessions?: string[]; compaction?: { signal: "record" | "item"; at: string }; scripts?: ScriptPool; sawUsage?: boolean; firstUsageAvailable?: boolean };
export type CaptureBatch = CaptureSemantics & { provider?: string; source?: NativeHistoryFile; cursor?: CaptureCursor; growth: Record<string, { bytes: number; lines: number }>; coverage: { at: string; from: number; through: number; fileBytes?: number; readBytes: number; backlogBytes: number; partialBytes: number; skippedBytes: number; complete: boolean; aborted: boolean } };
export type CaptureOptions = { signal?: AbortSignal; now?: () => number; codexHome?: string; claudeHome?: string; maxBytes?: number; maxLineBytes?: number; maxRecords?: number; /** Already recorded Flowly sends; the body must not be compared by text. */ sentMessageIds?: readonly string[]; automationTextHashes?: readonly string[] };
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const identity = (s: { dev: number; ino: number; birthtimeMs: number }) => `${s.dev}:${s.ino}:${s.birthtimeMs}`;
const bounded = (value: number | undefined, max: number, min = 1) => Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value!))) : max;
function validCursor(cursor: CaptureCursor) {
  const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (cursor.version !== 1 || !integer(cursor.offset) || !integer(cursor.epoch)) return false;
  if (cursor.prefix && (!integer(cursor.prefix.length) || cursor.prefix.length > 128)) return false;
  if (cursor.anchor && (!integer(cursor.anchor.length) || cursor.anchor.length > 128 || !integer(cursor.anchor.offset) || cursor.anchor.offset + cursor.anchor.length !== cursor.offset)) return false;
  if (cursor.skipping && (!integer(cursor.skipping.start) || !integer(cursor.skipping.bytes) || cursor.skipping.start + cursor.skipping.bytes !== cursor.offset)) return false;
  for (const list of [cursor.closed, cursor.sessions]) if (list && (!Array.isArray(list) || list.length > captureLimits.closed || list.some((value) => typeof value !== "string"))) return false;
  if (cursor.compaction && (!["record", "item"].includes(cursor.compaction.signal) || !Number.isFinite(Date.parse(cursor.compaction.at)))) return false;
  if (cursor.scripts && (typeof cursor.scripts.id !== "string" || !Array.isArray(cursor.scripts.open) || cursor.scripts.open.length > captureLimits.calls + 1 || !cursor.scripts.done || !cursor.scripts.seen || !cursor.scripts.placed)) return false;
  return !cursor.calls || Array.isArray(cursor.calls) && cursor.calls.length <= captureLimits.calls;
}


/** Caller authorizes a Flowly-managed session. Persist this batch BEFORE adopting cursor; replay ids stay stable. */
export async function captureHandoff(agent: HistoryAgent & { id: string }, previous?: CaptureCursor, options: CaptureOptions = {}): Promise<CaptureBatch> {
  const at = new Date((options.now ?? Date.now)()).toISOString();
  const records = new CaptureRecords(agent.id, at, options.sentMessageIds, options.automationTextHashes);
  const batch: CaptureBatch = { ...records.result, growth: {}, coverage: { at, from: previous?.offset ?? 0, through: previous?.offset ?? 0, readBytes: 0, backlogBytes: 0, partialBytes: 0, skippedBytes: 0, complete: false, aborted: !!options.signal?.aborted } };
  const location = await locateProviderHistory(agent, options);
  if (!location.file) { batch.coverage.aborted = !!options.signal?.aborted; records.gap({ id: `source:${agent.id}:${location.reason}`, kind: location.reason ?? "source_missing" }); return batch; }
  batch.provider = location.file.provider; batch.source = location.file;
  if (options.signal?.aborted) { records.gap({ id: `abort:${agent.id}:${previous?.offset ?? 0}`, kind: "aborted" }); return batch; }
  const file = await open(location.file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!file) { records.gap({ id: `source:${agent.id}:unreadable`, kind: "source_unreadable" }); return batch; }
  try {
    const initial = await file.stat();
    if (!initial.isFile()) { records.gap({ id: `source:${agent.id}:not_file`, kind: "source_unreadable" }); return batch; }
    const fileId = identity(initial), byteBudget = bounded(options.maxBytes, captureLimits.bytes, 1024), lineBudget = Math.min(bounded(options.maxLineBytes, captureLimits.line), byteBudget - 256), recordBudget = bounded(options.maxRecords, captureLimits.records);
    let cursor: CaptureCursor = { version: 1, provider: location.file.provider, sessionId: location.file.sessionId, fileId, path: location.file.path, epoch: 0, offset: 0, firstUsageAvailable: true };
    let reset = false;
    const read = async (position: number, length: number) => {
      const data = Buffer.alloc(Math.min(length, byteBudget - batch.coverage.readBytes));
      const { bytesRead } = await file.read(data, 0, data.length, position); batch.coverage.readBytes += bytesRead; return data.subarray(0, bytesRead);
    };
    if (previous) {
      reset = !validCursor(previous) || previous.fileId !== fileId || previous.sessionId !== cursor.sessionId || previous.provider !== cursor.provider || initial.size < previous.offset;
      if (!reset) for (const probe of [previous.prefix && { ...previous.prefix, offset: 0 }, previous.anchor]) {
        if (!probe) continue;
        const data = await read(probe.offset, probe.length);
        if (data.length !== probe.length || hash(data) !== probe.hash) { reset = true; break; }
      }
      if (reset) {
        cursor.epoch = previous.fileId === fileId ? (Number.isSafeInteger(previous.epoch) ? previous.epoch + 1 : 1) : 0;
        cursor.firstUsageAvailable = false;
        records.gap({ id: `reset:${agent.id}:${fileId}:${cursor.epoch}`, kind: initial.size < previous.offset ? "file_truncated" : "file_replaced", from: 0, to: previous.offset });
      } else {
        // No undefined-valued keys: the stored cursor is JSON, and a key it lacks must not look like a change on every idle poll.
        const { calls, closed, sessions, skipping, compaction, scripts, ...rest } = previous;
        cursor = { ...rest, ...(calls ? { calls: calls.map((call) => structuredClone(call)) } : {}), ...(closed ? { closed: [...closed] } : {}), ...(sessions ? { sessions: [...sessions] } : {}), ...(skipping ? { skipping: { ...skipping } } : {}), ...(compaction ? { compaction: { ...compaction } } : {}), ...(scripts ? { scripts: structuredClone(scripts) } : {}), path: location.file.path };
        if (previous.path !== cursor.path) records.gap({ id: `moved:${agent.id}:${fileId}:${cursor.epoch}`, kind: "file_moved", from: previous.offset, to: previous.offset });
      }
    }
    records.restore(cursor.calls ?? [], !!cursor.sawUsage, cursor.firstUsageAvailable !== false, cursor.closed ?? [], cursor.sessions ?? [], cursor.compaction, cursor.scripts);
    const sourceAt = (start: number, end: number): CaptureSource => ({ agentId: agent.id, provider: cursor.provider, sessionId: cursor.sessionId, fileId: `${cursor.fileId}:${cursor.epoch}`, offset: start, end });
    const growth = (type: string, bytes: number, lines: number) => {
      const key = Object.keys(batch.growth).length < 64 || batch.growth[type] ? type : "other";
      const entry = batch.growth[key] ??= { bytes: 0, lines: 0 }; entry.bytes += bytes; entry.lines += lines;
    };
    let position = cursor.offset, start = cursor.skipping?.start ?? position, parts: Buffer[] = [], length = 0, lineCount = 0, tail = Buffer.alloc(0), prefix = Buffer.alloc(0), stop = false;
    // The last bytes of the line being skipped (JSON writers put ids and small trailing fields after the long text); whole
    // unless the skip began in an earlier poll and this one read less than the window.
    let skipTail = Buffer.alloc(0), skipStartedHere = false;
    batch.coverage.from = position;
    const committed = (data: Buffer, end: number) => { tail = Buffer.concat([tail, data]).subarray(-128); cursor.offset = end; };
    const skip = (fragment: Buffer, end: number, ended: boolean) => {
      cursor.skipping!.bytes += fragment.length; committed(fragment, end); batch.coverage.skippedBytes += fragment.length;
      growth(cursor.skipping!.typeHint, fragment.length, ended ? 1 : 0);
      skipTail = Buffer.concat([skipTail, fragment]).subarray(-4096);
      if (ended) {
        const skipped = cursor.skipping!;
        if (!skipped.messageId) { const found = lineHint(skipTail.subarray(Math.max(0, skipTail.length - 2048))).messageId; if (found) skipped.messageId = found; }
        records.longLine({ id: `long:${agent.id}:${fileId}:${cursor.epoch}:${skipped.start}`, kind: "long_line", source: { ...sourceAt(skipped.start, end), ...(skipped.messageId ? { messageId: skipped.messageId } : {}) }, from: skipped.start, to: end, bytes: skipped.bytes, typeHint: skipped.typeHint, at: skipped.at }, skipTail, skipStartedHere || skipTail.length >= 4096, skipped.result);
        delete cursor.skipping; start = end; lineCount++; skipTail = Buffer.alloc(0); skipStartedHere = false;
      }
    };
    while (position < initial.size && batch.coverage.readBytes < byteBudget && lineCount < recordBudget && !stop) {
      if (options.signal?.aborted) break;
      const chunk = await read(position, Math.min(captureLimits.chunk, initial.size - position));
      if (!chunk.length) break;
      if (position === 0 && !cursor.prefix) prefix = chunk.subarray(0, 128);
      let part = 0;
      while (part < chunk.length) {
        if (options.signal?.aborted || lineCount >= recordBudget) { stop = true; break; }
        const newline = chunk.indexOf(10, part), end = newline < 0 ? chunk.length : newline + 1;
        const fragment = chunk.subarray(part, end), absolute = position + end;
        if (cursor.skipping) skip(fragment, absolute, newline >= 0);
        else if (length + fragment.length > lineBudget) {
          const buffered = Buffer.concat([...parts, fragment]);
          const hint = lineHint(buffered.subarray(0, 2048));
          cursor.skipping = { start, bytes: 0, typeHint: hint.type, ...(hint.at ? { at: hint.at } : {}), ...(hint.messageId ? { messageId: hint.messageId } : {}), ...(hint.result ? { result: hint.result } : {}) };
          parts = []; length = 0; records.firstUsageAvailable = false; skipStartedHere = true; skip(buffered, absolute, newline >= 0);
        } else {
          parts.push(fragment); length += fragment.length;
          if (newline >= 0) {
            const line = Buffer.concat(parts), source = sourceAt(start, absolute);
            growth(records.providerLine(cursor.provider, line, source), line.length, 1);
            committed(line, absolute); start = absolute; parts = []; length = 0; lineCount++;
          }
        }
        part = end;
      }
      position += chunk.length;
    }
    if (prefix.length) cursor.prefix = { length: prefix.length, hash: hash(prefix) };
    if (tail.length) cursor.anchor = { offset: cursor.offset - tail.length, length: tail.length, hash: hash(tail) };
    cursor.calls = records.pending(); cursor.sawUsage = records.sawUsage; cursor.firstUsageAvailable = records.firstUsageAvailable;
    const closed = records.closedSessions(); if (closed.length) cursor.closed = closed; else delete cursor.closed;
    const sessions = records.runningSessions(); if (sessions.length) cursor.sessions = sessions; else delete cursor.sessions;
    const compaction = records.pendingCompaction(); if (compaction) cursor.compaction = compaction; else delete cursor.compaction;
    const scripts = records.pendingScripts(); if (scripts) cursor.scripts = scripts; else delete cursor.scripts;
    batch.cursor = cursor;
    const final = await file.stat();
    batch.coverage.through = cursor.offset; batch.coverage.fileBytes = final.size; batch.coverage.backlogBytes = Math.max(0, final.size - cursor.offset);
    batch.coverage.partialBytes = length; batch.coverage.aborted = !!options.signal?.aborted;
    if (cursor.skipping) records.gap({ id: `long:${agent.id}:${fileId}:${cursor.epoch}:${cursor.skipping.start}`, kind: "long_line_partial", source: { ...sourceAt(cursor.skipping.start, cursor.offset), ...(cursor.skipping.messageId ? { messageId: cursor.skipping.messageId } : {}) }, from: cursor.skipping.start, to: cursor.offset, bytes: cursor.skipping.bytes, typeHint: cursor.skipping.typeHint });
    if (length) records.gap({ id: `partial:${agent.id}:${fileId}:${cursor.epoch}:${start}`, kind: "partial_line", source: sourceAt(start, start + length), from: start, to: start + length, bytes: length });
    if (batch.coverage.aborted) records.gap({ id: `abort:${agent.id}:${fileId}:${cursor.offset}`, kind: "aborted", from: cursor.offset, to: final.size });
    if (batch.coverage.backlogBytes > length && !batch.coverage.aborted) records.gap({ id: `backlog:${agent.id}:${fileId}:${cursor.offset}`, kind: lineCount >= recordBudget ? "record_budget" : "backlog", from: cursor.offset, to: final.size, bytes: batch.coverage.backlogBytes });
    const current = await stat(location.file.path).catch(() => null);
    const changed = !current || identity(current) !== fileId || final.size < initial.size;
    if (changed) records.gap({ id: `changed:${agent.id}:${fileId}:${cursor.offset}`, kind: "file_changed_during_read", from: cursor.offset, to: final.size });
    batch.coverage.complete = !changed && !batch.coverage.aborted && !cursor.skipping && !length && !records.identityMismatch && batch.coverage.backlogBytes === 0;
    if (records.identityMismatch) { delete batch.cursor; batch.coverage.through = previous?.offset ?? 0; batch.coverage.backlogBytes = Math.max(0, final.size - batch.coverage.through); }
    records.finish(); return Object.assign(batch, records.result);
  } catch {
    records.gap({ id: `read:${agent.id}:${previous?.offset ?? 0}`, kind: "read_failed" });
    // Without a complete batch the caller keeps the previous cursor; semantic ids can safely replay.
    delete batch.cursor; return batch;
  } finally { Object.assign(batch, records.result); await file.close(); }
}

/** Whole hook timelines may be replayed. Message ids win; id-less equal text keeps its occurrence number. */
export function captureTimeline(agentId: string, timeline: readonly unknown[], options: { now?: () => number; outcome?: "completed" | "failed" | "canceled"; received?: boolean; sentMessageIds?: readonly string[]; automationTextHashes?: readonly string[] } = {}): CaptureSemantics {
  const records = new CaptureRecords(agentId, new Date((options.now ?? Date.now)()).toISOString(), options.sentMessageIds, options.automationTextHashes);
  records.timeline(timeline, options.outcome === "completed" && options.received !== false);
  records.finish(); return records.result;
}
