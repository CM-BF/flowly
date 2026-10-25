import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { HandoffSession } from "../shared/handoff";
import type { SessionPolicyFacts } from "../shared/session-measurement";
import { claudeSidecarBytes, locateProviderHistory, nativeHistoryIdentity, type HistoryAgent, type NativeHistoryFile } from "./provider-history";

export const usageReadLimits = { bytes: 16 * 2 ** 20, chunk: 2 ** 20, line: 256 * 2 ** 10, records: 100_000 } as const;
type UsageAgent = HistoryAgent & { id: string; model?: string | null; lastUsage?: { contextWindowUsedTokens?: number; contextWindowMaxTokens?: number }; activeTurn?: { startedAt?: string | null } | null };
type Meta = { usageAt?: string; ttl?: number; lastTurn?: string; lastRequest?: string; activeMs?: number };
export type ProviderUsageOptions = { now?: () => number; signal?: AbortSignal; codexHome?: string; claudeHome?: string };
type TailFacts = Partial<Pick<SessionPolicyFacts, "C" | "W" | "C0" | "K" | "peakC" | "completedTurns" | "lastTurnEndAt" | "lastRequestAt" | "ttlSeconds" | "usageAt">> & { readBytes: number; complete: boolean; unknown: string[] };
const tails = new Map<string, { key: string; value: TailFacts }>();
const number = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
const positive = (n: unknown) => { const value = number(n); return value !== undefined && value > 0 ? value : undefined; };
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
const maxTime = (...values: (number | undefined)[]) => { const known = values.filter((value): value is number => value !== undefined); return known.length ? Math.max(...known) : undefined; };

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const record = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
type Row = { C?: number; W?: number; ttl?: number; at?: number; compact?: boolean; ended?: boolean; messageId?: string };
function usageRow(entry: RecordValue, file: NativeHistoryFile): Row | undefined {
  const type = entry.type, at = timestamp(entry.timestamp);
  if (file.provider === "claude") {
    if (entry.isSidechain === true) return;
    if (type === "system" && entry.subtype === "compact_boundary") return { at, compact: true };
    if (type !== "assistant") return;
    const message = object(entry.message), usage = object(message.usage);
    const parts = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].map((key) => number(usage[key]));
    if (parts.every((part) => part === undefined)) return;
    const cache = object(usage.cache_creation), ttl = (number(cache.ephemeral_1h_input_tokens) ?? 0) > 0 ? 3300 : (number(cache.ephemeral_5m_input_tokens) ?? 0) > 0 ? 240 : undefined;
    return { C: parts.reduce<number>((sum, part) => sum + (part ?? 0), 0), at, ttl, messageId: typeof message.id === "string" ? message.id : undefined };
  }
  const payload = object(entry.payload);
  if (type === "compacted" && (record(payload.latest_token_usage_record) || record(entry.latest_token_usage_record))) return { at, compact: true };
  if (type !== "event_msg") return;
  const event = payload.type;
  if (event === "task_complete" || event === "turn_aborted") return { at, ended: true };
  if (event !== "token_count") return;
  const info = object(payload.info), last = object(info.last_token_usage);
  return { C: number(last.total_tokens), W: positive(info.model_context_window) ?? positive(payload.model_context_window), at };
}

/** Reverse streaming tail: at most 16 MiB read, 1 MiB block, 256 KiB retained per line. No capture cursor writes. */
export async function readProviderUsageTail(file: NativeHistoryFile, signal?: AbortSignal): Promise<TailFacts> {
  const result: TailFacts = { readBytes: 0, complete: false, unknown: [] };
  if (signal?.aborted) return { ...result, unknown: ["tail aborted"] };
  const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) return { ...result, unknown: ["usage source unreadable"] };
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ...result, unknown: ["usage source is not a regular file"] };
    const key = `${file.provider}:${file.sessionId}:${info.dev}:${info.ino}:${info.birthtimeMs}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const hit = tails.get(file.path); if (hit?.key === key) return structuredClone(hit.value);
    let position = info.size, pending = Buffer.alloc(0), pendingBytes = 0, trailing = true, first = true, lines = 0, compactions = 0, turns = 0, oldestUsage: number | undefined, peak: number | undefined;
    const seenMessages = new Set<string>(); let truncated = false, identityMismatch = false;
    const consume = (segment: Buffer, boundary: boolean) => {
      pendingBytes += segment.length;
      if (pendingBytes <= usageReadLimits.line) pending = Buffer.concat([segment, pending]);
      else pending = Buffer.alloc(0);
      if (!boundary) return;
      if (trailing) { if (pendingBytes) { result.unknown.push("unfinished final line"); truncated = true; } trailing = false; }
      else if (pendingBytes > usageReadLimits.line) { result.unknown.push("usage tail long line skipped"); truncated = true; }
      else if (pendingBytes) {
        // The byte cap is enforced before parsing: malformed complete lines cannot certify metadata.
        let entry: RecordValue = {};
        try { entry = object(JSON.parse(pending.toString("utf8"))); }
        catch { result.unknown.push("usage tail malformed JSON record"); truncated = true; }
        const type = entry.type, nativeId = type === "session_meta" ? object(entry.payload).id : undefined;
        if (entry.sessionId != null && entry.sessionId !== file.sessionId || file.provider === "codex" && nativeId != null && nativeId !== file.sessionId) {
          identityMismatch = true; result.unknown.push("usage source native identity mismatch");
        }
        const supported = file.provider === "codex" ? ["session_meta", "turn_context", "event_msg", "response_item", "compacted"] : ["user", "assistant", "system", "progress", "file-history-snapshot", "queue-operation", "summary", "custom-title", "ai-title", "last-prompt"];
        if (typeof type !== "string" || !supported.includes(type)) { result.unknown.push("usage tail unknown record format"); truncated = true; }
        const row = identityMismatch ? undefined : usageRow(entry, file);
        if (row?.compact) compactions++;
        if (row?.ended) { turns++; result.lastTurnEndAt = maxTime(result.lastTurnEndAt, row.at); }
        if (row?.C !== undefined && (!row.messageId || !seenMessages.has(row.messageId))) {
          if (row.messageId) seenMessages.add(row.messageId);
          if (result.C === undefined) { result.C = row.C; result.W = row.W; result.usageAt = row.at; }
          if (result.W === undefined && row.W !== undefined) result.W = row.W;
          if (result.ttlSeconds === undefined && row.ttl !== undefined) result.ttlSeconds = row.ttl;
          result.lastRequestAt = maxTime(result.lastRequestAt, row.at); oldestUsage = row.C; peak = Math.max(peak ?? 0, row.C);
        }
      }
      pending = Buffer.alloc(0); pendingBytes = 0;
    };
    while (position > 0 && result.readBytes < usageReadLimits.bytes && lines < usageReadLimits.records && !signal?.aborted) {
      const size = Math.min(usageReadLimits.chunk, position, usageReadLimits.bytes - result.readBytes), start = position - size;
      const block = Buffer.allocUnsafe(size), { bytesRead } = await handle.read(block, 0, size, start);
      if (bytesRead !== size) { result.unknown.push("usage source changed during read"); break; }
      result.readBytes += bytesRead; position = start;
      if (first) { first = false; trailing = block[bytesRead - 1] !== 10; }
      let end = bytesRead;
      while (end > 0 && lines < usageReadLimits.records) {
        const newline = block.lastIndexOf(10, end - 1);
        if (newline < 0) break;
        consume(block.subarray(newline + 1, end), true); lines++; end = newline;
      }
      if (end) consume(block.subarray(0, end), false);
    }
    if (position === 0 && lines < usageReadLimits.records && !signal?.aborted) { consume(Buffer.alloc(0), true); result.complete = true; }
    else result.unknown.push(signal?.aborted ? "tail aborted" : "usage tail budget exhausted");
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) { result.complete = false; result.unknown.push("usage source changed during read"); }
    if (identityMismatch) return { readBytes: result.readBytes, complete: false, unknown: [...new Set(result.unknown)] };
    result.complete = result.complete && !truncated;
    if (result.complete) { result.C0 = oldestUsage; result.K = compactions; if (file.provider === "codex") result.completedTurns = turns; }
    result.peakC = peak;
    result.unknown = [...new Set(result.unknown)];
    if (!signal?.aborted && after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs) { if (tails.size >= 128) tails.delete(tails.keys().next().value!); tails.set(file.path, { key, value: structuredClone(result) }); }
    return result;
  } catch { return { ...result, complete: false, unknown: [...result.unknown, "usage tail read failed"] }; }
  finally { await handle.close(); }
}

/** Snapshot first; durable fallback is legal only for this exact agent. Tail reads fill missing facts, never capture gaps. */
export async function measureSessionPolicyFacts(agent: UsageAgent, ledger?: HandoffSession, options: ProviderUsageOptions = {}): Promise<SessionPolicyFacts> {
  const at = (options.now ?? Date.now)(), identity = nativeHistoryIdentity(agent);
  const priorIdentity = ledger?.through?.resume as { sessionId?: string; provider?: string; epoch?: number; firstUsageAvailable?: boolean } | undefined;
  const replaced = !!(identity.sessionId && priorIdentity?.sessionId && identity.sessionId !== priorIdentity.sessionId);
  const same = ledger?.agentId === agent.id && !replaced ? ledger : undefined;
  const meta = (same?.through?.resume as { observer?: Meta } | undefined)?.observer;
  const provider = identity.provider ?? agent.provider ?? same?.provider ?? "unknown";
  const facts: SessionPolicyFacts = { agentId: agent.id, provider, at, unknown: [] };
  const measured = same?.measured;
  facts.C = number(agent.lastUsage?.contextWindowUsedTokens) ?? number(measured?.C);
  facts.W = positive(agent.lastUsage?.contextWindowMaxTokens) ?? positive(measured?.W);
  facts.usageSource = number(agent.lastUsage?.contextWindowUsedTokens) !== undefined ? "snapshot" : facts.C !== undefined ? "ledger" : undefined;
  facts.usageAt = facts.usageSource === "snapshot" ? at : timestamp(meta?.usageAt);
  facts.C0 = number(measured?.C0); facts.K = number(measured?.K); facts.peakC = maxTime(number(measured?.peakC), facts.C);
  facts.completedTurns = number(measured?.turns); facts.activeMs = number(meta?.activeMs);
  facts.lastTurnEndAt = maxTime(timestamp(meta?.lastTurn), ...same?.turns.map((turn) => timestamp(turn.endedAt)) ?? []);
  // A capture observation time (or a snapshot refresh) is not evidence that a model request just ran.
  facts.lastRequestAt = maxTime(timestamp(meta?.lastRequest), timestamp(agent.activeTurn?.startedAt));
  facts.ttlSeconds = positive(meta?.ttl);
  facts.ttlKind = provider === "codex" ? "codex" : facts.ttlSeconds === 3300 ? "claude-1h" : facts.ttlSeconds === 240 ? "claude-5m" : "unknown";
  const through = ledger?.agentId === agent.id ? ledger?.through : undefined;
  facts.coverage = through ? { gaps: through.gaps, lagBytes: through.lagBytes } : {};
  if (!through) facts.unknown!.push("native capture coverage unavailable");
  if (ledger && ledger.agentId !== agent.id) facts.unknown!.push("foreign ledger ignored");
  if (replaced) facts.unknown!.push("native identity changed; previous measurements ignored");
  const location = await locateProviderHistory(agent, options);
  if (location.file) {
    facts.B = (await stat(location.file.path).catch(() => null))?.size;
    if (provider === "claude") { const sidecars = await claudeSidecarBytes(location.file, at, options.signal); facts.S = sidecars.bytes; if (!sidecars.complete) facts.unknown!.push(sidecars.limited ? "sidecar stat budget exceeded; warning lower bound" : "sidecar size incomplete"); }
    if (facts.C === undefined || facts.W === undefined) {
      const tail = await readProviderUsageTail(location.file, options.signal);
      if (facts.C === undefined && tail.C !== undefined) { facts.C = tail.C; facts.usageSource = "tail"; facts.usageAt = tail.usageAt; }
      facts.W ??= tail.W;
      const initialAvailable = replaced || priorIdentity?.firstUsageAvailable !== false && !(priorIdentity?.epoch && priorIdentity.epoch > 0);
      if (initialAvailable) facts.C0 ??= tail.C0;
      else if (facts.C0 === undefined) facts.unknown!.push("initial context unproven after capture discontinuity");
      facts.K ??= tail.K; facts.completedTurns ??= tail.completedTurns;
      facts.peakC = maxTime(facts.peakC, tail.peakC, facts.C); facts.lastRequestAt = maxTime(facts.lastRequestAt, tail.lastRequestAt); facts.lastTurnEndAt = maxTime(facts.lastTurnEndAt, tail.lastTurnEndAt);
      facts.ttlSeconds ??= tail.ttlSeconds; facts.coverage.tailBytes = tail.readBytes; facts.coverage.tailComplete = tail.complete; facts.unknown!.push(...tail.unknown);
    }
  } else facts.unknown!.push(`native history ${location.reason ?? "unavailable"}`);
  if (provider === "claude" && facts.W === undefined) { if (/^claude-opus-5-5(?:-|$)/.test(agent.model ?? "")) facts.W = 1_000_000; else if (/^claude-haiku-4-5(?:-|$)/.test(agent.model ?? "")) facts.W = 200_000; }
  facts.ttlKind = provider === "codex" ? "codex" : facts.ttlSeconds === 3300 ? "claude-1h" : facts.ttlSeconds === 240 ? "claude-5m" : "unknown";
  for (const name of ["C", "W", "C0", "B", "K", "completedTurns", "lastTurnEndAt", "lastRequestAt"] as const) if (facts[name] === undefined) facts.unknown!.push(`${name} unknown`);
  facts.unknown = [...new Set(facts.unknown)];
  return facts;
}
