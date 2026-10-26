import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { sessionHistoryEntrySchema, sessionHistoryLimits as limits, sessionHistoryPageSchema, sessionHistoryQuerySchema, type SessionHistoryEntry, type SessionHistoryPage, type SessionHistoryQuery } from "../shared/session-history";
import { lineHint } from "./handoff-capture-records";
import { locateProviderHistory, type HistoryAgent, type NativeHistoryFile } from "./provider-history";
import { HistoryRecords } from "./session-history-records";
import { redactHistory, unescapeLayers } from "./session-history-text";
import { ToolError } from "./tool-error";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const stamp = (s: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number }) => `${s.dev}:${s.ino}:${s.birthtimeMs}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
type Source = { path: string; ref: string; stamp: string; bytes: number };
/**
 * Format 2 indexes tool outputs and full arguments (SESSION-HANDOFF-SPEC §21.13); format 3 checks every entry against the
 * schema before publishing and indexes Claude's mid-turn deliveries (§21.15). An older index is rebuilt once.
 */
const version = 3;
type Manifest = { version: typeof version; agentId: string; provider: string; sessionId: string; snapshot: string; previous?: string; bodyHash: string; bodyBytes: number; builtAt: string; sources: Source[]; directories: { path: string; stamp: string | null }[]; coverage: NonNullable<SessionHistoryPage["coverage"]>; gaps: SessionHistoryPage["gaps"]; growth: NonNullable<SessionHistoryPage["growth"]> };
type Options = { codexHome?: string; claudeHome?: string; /** Small limits are injectable for synthetic fault tests only. */ maxSourceBytes?: number; maxSkeletonBytes?: number; now?: () => number };
const cursorSchema = z.object({ v: z.literal(1), agentId: z.string().max(240), snapshot: z.string().regex(/^[a-f0-9]{64}$/), query: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(0).max(limits.entries) }).strict();
const manifestSchema = z.object({ version: z.literal(version), agentId: z.string().max(240), provider: z.enum(["codex", "claude"]), sessionId: z.string().max(240), snapshot: z.string().regex(/^[a-f0-9]{64}$/), previous: z.string().regex(/^[a-f0-9]{64}$/).optional(), bodyHash: z.string().regex(/^[a-f0-9]{64}$/), bodyBytes: z.number().int().min(0).max(limits.skeletonBytes), builtAt: z.string(), sources: z.array(z.object({ path: z.string().min(1).max(4096), ref: z.string().max(100), stamp: z.string().max(300), bytes: z.number().nonnegative() })).min(1).max(limits.subagents + 1), directories: z.array(z.object({ path: z.string().max(4096), stamp: z.string().max(300).nullable() })).max(2), coverage: sessionHistoryPageSchema.shape.coverage.unwrap(), gaps: sessionHistoryPageSchema.shape.gaps, growth: sessionHistoryPageSchema.shape.growth.unwrap() });
const message = "Redacted excerpts, not a transcript: messages, tool arguments and tool outputs keep a head and tail (the newest widest); an entry's middle gives the omitted part's source bytes. Images, reasoning and oversized records are left out. Search covers stored excerpts, decoded where escaped, within the indexed range; coverage and gaps say what is missing.";
/** Shrinks an entry's text to fit a page, keeping the query's first match in view. */
function shrink(text: string, needle: string | undefined) {
  const length = Math.floor(text.length * 0.75), lower = needle ? text.toLocaleLowerCase() : "", at = needle && lower.length === text.length ? lower.indexOf(needle) : -1;
  if (at < 0) return text.slice(0, length);
  const start = Math.max(0, Math.min(at - Math.floor((length - needle!.length) / 2), text.length - length)), end = Math.min(text.length, start + length);
  return `${start > 0 ? "…" : ""}${text.slice(start + (start > 0 ? 1 : 0), end - (end < text.length ? 1 : 0))}${end < text.length ? "…" : ""}`;
}

/**
 * Escaped text is stored as written (its characters map onto the source), so a phrase with a quote, an escaped newline
 * or `\u`-escaped CJK is also matched against its decoded, redacted view, which the page then shows (`decoded`).
 */
function decodedMatch(entry: SessionHistoryEntry, needle: string): SessionHistoryEntry[] {
  if (!entry.text.includes("\\") || !unescapeLayers(entry.text).toLocaleLowerCase().includes(needle)) return [];
  const view = redactHistory(unescapeLayers(entry.text));
  return view.toLocaleLowerCase().includes(needle) ? [{ ...entry, text: view, decoded: true }] : [];
}

/** Only receives an already-authorized ledger identity. Never calls a Paseo API or edits native history. */
export class SessionHistory {
  private queued: (HistoryAgent & { id: string })[] = [];
  private jobs = new Set<string>();
  private failures = new Map<string, SessionHistoryPage>();
  private cleaned = new Map<string, string>();
  private active?: Promise<void>;
  private controller = new AbortController();
  constructor(readonly directory: string, private options: Options = {}) {}
  private paths(agentId: string) { const folder = join(this.directory, "session-history", digest(agentId)); return { folder, manifest: join(folder, "current.json") }; }
  private empty(agentId: string, status: SessionHistoryPage["status"], kind: string, detail: string): SessionHistoryPage { return { session: agentId, status, message: detail, entries: [], omitted: 0, gaps: [{ kind, count: 1 }] }; }
  private async manifest(agentId: string): Promise<Manifest | null> {
    const path = this.paths(agentId).manifest;
    const info = await lstat(path).catch(() => null); if (!info) return null;
    if (!info.isFile() || info.size > 32 * 1024) throw new Error("Invalid derived-history manifest");
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    // An index of an older format covers less; it is replaced on this read, not served.
    if (data && typeof data === "object" && typeof (data as { version?: unknown }).version === "number" && (data as { version: number }).version < version) return null;
    const manifest = manifestSchema.parse(data);
    if (manifest.agentId !== agentId) throw new Error("Invalid derived-history manifest");
    return manifest;
  }
  private enqueue(agent: HistoryAgent & { id: string }) {
    if (this.jobs.has(agent.id)) return;
    if (this.queued.length >= limits.queue || this.controller.signal.aborted) throw new ToolError("HISTORY_UNAVAILABLE", "The history builder is unavailable or its bounded queue is full; try later.");
    this.jobs.add(agent.id); this.queued.push({ ...agent, persistence: agent.persistence && { ...agent.persistence } });
    this.start();
  }
  private start() {
    if (!this.active) {
      // The requesting call returns 'building' without opening or parsing a native file.
      this.active = yieldLoop().then(async () => {
        while (this.queued.length && !this.controller.signal.aborted) {
          const next = this.queued.shift()!;
          try { await this.build(next); }
          catch { this.cleaned.delete(next.id); this.failures.set(next.id, this.empty(next.id, "unavailable", this.controller.signal.aborted ? "aborted" : "build_failed", "The derived skeleton could not be built; native files were left unchanged. Retry with rebuild=true.")); if (this.failures.size > 64) this.failures.delete(this.failures.keys().next().value!); }
          finally { this.jobs.delete(next.id); }
        }
      }).finally(() => { this.active = undefined; if (this.queued.length && !this.controller.signal.aborted) this.start(); });
    }
  }
  async read(agent: HistoryAgent & { id: string }, raw: SessionHistoryQuery): Promise<SessionHistoryPage> {
    const query = sessionHistoryQuerySchema.parse(raw);
    if (query.rebuild && query.cursor) throw new ToolError("HISTORY_CURSOR_INVALID", "A rebuild starts a new view; omit the old cursor.");
    const queryHash = digest(JSON.stringify({ session: query.session, query: query.query, around: query.around, roles: query.roles, limit: query.limit }));
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor) {
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))); }
      catch { throw new ToolError("HISTORY_CURSOR_INVALID", "This history cursor is malformed. Start a new query without it."); }
      if (cursor.agentId !== agent.id || cursor.query !== queryHash) throw new ToolError("HISTORY_CURSOR_INVALID", "This history cursor belongs to a different session or query.");
    }
    if (this.controller.signal.aborted) return this.empty(agent.id, "unavailable", "stopped", "The history reader stopped; native history is unchanged.");
    if (this.jobs.has(agent.id)) return this.empty(agent.id, "building", "building", "Skeleton not ready (building); try again in a minute.");
    let manifest: Manifest | null;
    try { manifest = await this.manifest(agent.id); }
    catch { if (!query.rebuild) return this.empty(agent.id, "unavailable", "skeleton_invalid", "The derived skeleton is invalid; use rebuild=true. Native history was not changed."); manifest = null; }
    const cleanupFailed = !manifest || query.rebuild || this.cleaned.get(agent.id) !== manifest.snapshot ? !await this.retire(agent.id, manifest) : false;
    if (cleanupFailed && (query.rebuild || !manifest)) return this.empty(agent.id, "unavailable", "cleanup_pending", "Older derived snapshots could not be retired. Retry cleanup before rebuilding; current and previous evidence are preserved.");
    if (!manifest || query.rebuild) {
      const failure = this.failures.get(agent.id); if (failure && !query.rebuild) return failure;
      const location = await locateProviderHistory(agent, { ...this.options, signal: this.controller.signal });
      if (!location.file) return this.empty(agent.id, location.reason === "unsupported_provider" ? "unsupported" : "unavailable", location.reason ?? "source_missing", "Provider history is missing, unsupported or outside the locator budget; no Paseo history was loaded.");
      this.failures.delete(agent.id); this.enqueue(agent); return this.empty(agent.id, "building", "building", "Skeleton not ready (building); try again in a minute.");
    }
    const nativeSessionId = agent.persistence?.metadata?.threadId ?? agent.persistence?.nativeHandle ?? agent.persistence?.sessionId;
    const providers = [agent.provider, agent.persistence?.provider, agent.persistence?.metadata?.provider];
    const changed = nativeSessionId !== manifest.sessionId || !providers.includes(manifest.provider) || (await Promise.all(manifest.sources.map(async (source) => { const current = await lstat(source.path).catch(() => null); return !current?.isFile() || stamp(current) !== source.stamp; }))).some(Boolean) || (await Promise.all(manifest.directories.map(async (directory) => { const current = await lstat(directory.path).catch(() => null); return (current ? stamp(current) : null) !== directory.stamp; }))).some(Boolean);
    if (changed || cursor && cursor.snapshot !== manifest.snapshot) return { ...this.empty(agent.id, "changed", "source_changed", "This snapshot is stale. The source changed; start a new query with rebuild=true to build once from current evidence."), viewChanged: true, snapshot: manifest.snapshot, evidenceRef: `session-history/${digest(agent.id)}/${manifest.snapshot}.jsonl`, coverage: manifest.coverage };
    const path = join(this.paths(agent.id).folder, `${manifest.snapshot}.jsonl`), info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.size !== manifest.bodyBytes || info.size > limits.skeletonBytes) return this.empty(agent.id, "unavailable", "skeleton_invalid", "The derived evidence is missing or invalid; rebuild explicitly. Native history is unchanged.");
    const body = await readFile(path);
    if (digest(body) !== manifest.bodyHash) return this.empty(agent.id, "unavailable", "skeleton_invalid", "The derived evidence checksum failed; rebuild explicitly. Native history is unchanged.");
    let entries: SessionHistoryEntry[];
    try { entries = body.toString("utf8").split("\n").filter(Boolean).map((line) => sessionHistoryEntrySchema.parse(JSON.parse(line))); }
    catch { return this.empty(agent.id, "unavailable", "skeleton_invalid", "The derived evidence cannot be decoded; rebuild explicitly. Native history is unchanged."); }
    const needle = query.query?.toLocaleLowerCase(), roles = query.roles && new Set(query.roles);
    const matched = entries.flatMap((entry) => roles && !roles.has(entry.role) ? [] : !needle || `${entry.text}\n${entry.tool?.name ?? ""}\n${entry.tool?.outcome ?? ""}\n${entry.paths.join("\n")}`.toLocaleLowerCase().includes(needle) ? [entry] : decodedMatch(entry, needle));
    if (cursor && cursor.offset > matched.length) throw new ToolError("HISTORY_CURSOR_INVALID", "This history cursor is beyond its indexed view. Start the query again.");
    const nearby = query.around === undefined ? 0 : matched.findIndex((entry) => entry.ordinal >= query.around!);
    const start = cursor?.offset ?? (query.around !== undefined ? Math.max(0, (nearby < 0 ? matched.length : nearby) - Math.floor(query.limit / 2)) : 0);
    const gaps = cleanupFailed ? [...manifest.gaps.slice(0, 19), { kind: "cleanup_pending", count: 1 }] : manifest.gaps;
    const page: SessionHistoryPage = { session: agent.id, status: "ready", message, snapshot: manifest.snapshot, builtAt: manifest.builtAt, evidenceRef: `session-history/${digest(agent.id)}/${manifest.snapshot}.jsonl`, entries: [], matches: matched.length, omitted: matched.length - Math.min(start, matched.length) + manifest.coverage.omittedEntries, coverage: manifest.coverage, gaps, growth: manifest.growth };
    let offset = start;
    const nextCursor = (position: number) => Buffer.from(JSON.stringify({ v: 1, agentId: agent.id, snapshot: manifest!.snapshot, query: queryHash, offset: position })).toString("base64url");
    while (offset < matched.length && page.entries.length < query.limit) {
      let entry = matched[offset];
      const fits = () => jsonBytes({ ...page, entries: [...page.entries, entry], nextCursor: nextCursor(offset + 1) }) <= limits.pageBytes;
      if (!fits() && page.entries.length) break;
      // One non-ASCII excerpt must still make progress inside the hard response budget.
      while (!fits() && entry.text.length) entry = { ...entry, text: shrink(entry.text, needle), truncated: true };
      if (!fits()) { delete page.growth; if (!fits()) throw new ToolError("HISTORY_UNAVAILABLE", "History metadata exceeds the response budget."); }
      page.entries.push(entry); offset++;
    }
    page.omitted = matched.length - offset + manifest.coverage.omittedEntries;
    if (offset < matched.length) page.nextCursor = nextCursor(offset);
    return page;
  }
  private async atomic(path: string, value: string) {
    if (this.controller.signal.aborted) throw new Error("Stopped");
    const temporary = `${path}.${randomUUID()}.tmp`; const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(value); await file.sync(); await file.close();
      if (this.controller.signal.aborted) throw new Error("Stopped");
      await rename(temporary, path); const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
  }
  /** The durable pointer protects current + one predecessor before any disposable cache is removed. */
  private async retire(agentId: string, manifest: Manifest | null): Promise<boolean> {
    const keep = new Set(manifest ? [`${manifest.snapshot}.jsonl`, ...(manifest.previous ? [`${manifest.previous}.jsonl`] : [])] : []);
    const ordinary = /^[a-f0-9]{64}\.jsonl$/, temporary = /^(?:[a-f0-9]{64}\.jsonl|current\.json)\.[a-f0-9-]{36}\.tmp$/;
    try {
      const folder = this.paths(agentId).folder;
      const entries = await opendir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }); if (!entries) return true;
      let count = 0;
      for await (const entry of entries) {
        if (++count > 1000 || this.controller.signal.aborted) return false;
        if (keep.has(entry.name) || !ordinary.test(entry.name) && !temporary.test(entry.name)) continue;
        if (!entry.isFile()) return false;
        await unlink(join(folder, entry.name));
      }
      const directory = await open(folder, "r"); try { await directory.sync(); } finally { await directory.close(); }
      if (manifest) this.cleaned.set(agentId, manifest.snapshot); if (this.cleaned.size > 64) this.cleaned.delete(this.cleaned.keys().next().value!);
      return true;
    } catch { return false; }
  }
  private async build(agent: HistoryAgent & { id: string }) {
    const location = await locateProviderHistory(agent, { ...this.options, signal: this.controller.signal });
    if (!location.file) throw new Error("Source unavailable");
    const records = new HistoryRecords(location.file.sessionId, this.options.maxSkeletonBytes);
    const sources: Source[] = [], directories: Manifest["directories"] = [];
    const main = await this.scan(location.file, "main", records, false); sources.push(main);
    if (location.file.provider === "claude" && !this.controller.signal.aborted) {
      const sessionDirectory = join(dirname(location.file.path), location.file.sessionId), folder = join(sessionDirectory, "subagents");
      for (const path of [sessionDirectory, folder]) { const info = await lstat(path).catch(() => null); directories.push({ path, stamp: info ? stamp(info) : null }); }
      if ((await lstat(sessionDirectory).catch(() => null))?.isDirectory() && (await lstat(folder).catch(() => null))?.isDirectory()) {
        const entries = await opendir(folder); let count = 0;
        for await (const item of entries) {
          if (++count > limits.subagents) { records.gap("subagent_count_budget"); break; }
          if (!item.isFile() || !item.name.endsWith(".jsonl")) { records.gap("subagent_unsupported_entry"); continue; }
          const path = join(folder, item.name), info = await lstat(path);
          if (info.size > limits.subagentBytes) { sources.push({ path, ref: `subagent:${digest(item.name).slice(0, 24)}`, stamp: stamp(info), bytes: info.size }); records.coverage.sourceBytes += info.size; records.gap("subagent_size_budget", info.size); continue; }
          sources.push(await this.scan({ ...location.file, path }, `subagent:${digest(item.name).slice(0, 24)}`, records, true));
        }
      }
    }
    if (this.controller.signal.aborted) throw new Error("Stopped");
    const unstable = (await Promise.all(sources.map(async (source) => stamp(await lstat(source.path)) !== source.stamp))).some(Boolean) || (await Promise.all(directories.map(async (directory) => { const current = await lstat(directory.path).catch(() => null); return (current ? stamp(current) : null) !== directory.stamp; }))).some(Boolean);
    if (unstable) throw new Error("Source changed during build");
    const body = records.body(), bodyHash = digest(body), builtAt = new Date((this.options.now ?? Date.now)()).toISOString();
    const snapshot = digest(JSON.stringify({ sources, directories, bodyHash, builtAt }));
    const prior = await this.manifest(agent.id).catch(() => null), previous = prior?.snapshot === snapshot ? prior.previous : prior?.snapshot;
    const manifest: Manifest = { version, agentId: agent.id, provider: location.file.provider, sessionId: location.file.sessionId, sources, directories, snapshot, ...(previous ? { previous } : {}), bodyHash, bodyBytes: Buffer.byteLength(body), builtAt, ...records.metadata() };
    const paths = this.paths(agent.id); await mkdir(paths.folder, { recursive: true, mode: 0o700 });
    await this.atomic(join(paths.folder, `${snapshot}.jsonl`), body); await this.atomic(paths.manifest, JSON.stringify(manifest));
    await this.retire(agent.id, manifest);
  }
  private async scan(file: NativeHistoryFile, ref: string, records: HistoryRecords, textOnly: boolean): Promise<Source> {
    const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const initial = await handle.stat(); if (!initial.isFile()) throw new Error("Source not a file");
      const source: Source = { path: file.path, ref, stamp: stamp(initial), bytes: initial.size };
      records.coverage.sourceBytes += initial.size;
      const budget = Math.min(this.options.maxSourceBytes ?? limits.sourceBytes, limits.sourceBytes);
      let position = 0, start = 0, parts: Buffer[] = [], length = 0, skipping = false, prefix = Buffer.alloc(0);
      const finish = (end: number, terminated: boolean) => {
        const hint = lineHint(prefix.subarray(0, 512));
        if (skipping) { records.gap("long_line", end - start); records.coverage.skippedLines++; records.coverage.skippedBytes += end - start; }
        else if (!terminated) records.gap("partial_line", end - start);
        else records.line(Buffer.concat(parts, length), file.provider, ref, start, end, textOnly);
        records.grow(hint.type, end - start); records.coverage.totalRecords++; records.coverage.through += end - start;
        start = end; parts = []; length = 0; skipping = false; prefix = Buffer.alloc(0);
      };
      while (position < initial.size && records.coverage.readBytes < budget && records.coverage.totalRecords < limits.records) {
        if (this.controller.signal.aborted) throw new Error("Stopped");
        const buffer = Buffer.alloc(Math.min(limits.chunkBytes, initial.size - position, budget - records.coverage.readBytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break;
        records.coverage.readBytes += bytesRead;
        let offset = 0;
        while (offset < bytesRead && records.coverage.totalRecords < limits.records) {
          const newline = buffer.indexOf(10, offset), end = newline < 0 || newline >= bytesRead ? bytesRead : newline + 1, fragment = buffer.subarray(offset, end);
          if (prefix.length < 512) prefix = Buffer.concat([prefix, fragment.subarray(0, 512 - prefix.length)]);
          if (!skipping && length + fragment.length <= limits.lineBytes) { parts.push(fragment); length += fragment.length; }
          else { skipping = true; parts = []; length = 0; }
          if (newline >= 0 && newline < bytesRead) finish(position + end, true);
          offset = end;
        }
        position += offset; await yieldLoop();
        if (offset < bytesRead) break;
      }
      if (start < position) finish(position, false);
      if (position < initial.size) { records.gap("source_budget", initial.size - position); records.coverage.complete = false; }
      if (stamp(await handle.stat()) !== source.stamp) throw new Error("Source changed during build");
      return source;
    } finally { await handle.close(); }
  }
  async stop() {
    this.controller.abort(); this.queued = []; this.jobs.clear();
    if (!this.active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.active, new Promise<void>((resolve) => { timer = setTimeout(resolve, 900); })]);
    if (timer) clearTimeout(timer);
  }
}
