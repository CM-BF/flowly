import { sessionHistoryEntrySchema, sessionHistoryExcerpts as excerpts, sessionHistoryLimits as limits, type SessionHistoryEntry, type SessionHistoryPage } from "../shared/session-history";
import { createHash } from "node:crypto";
import { claudeMetadataRecords, claudeRoutineAttachments } from "./handoff-capture-records";
import { excerpt, locateFields, redactHistory, safeArguments, sanitizeText, type Budget, type Field, type Variant } from "./session-history-text";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" ? value : "";
type Kind = "message" | "call" | "output";
const levels: Record<Kind, readonly Budget[]> = { message: excerpts.message, call: excerpts.arguments, output: excerpts.output };
/**
 * Entries by lane and age, newest first (SESSION-HANDOFF-SPEC §8.1): tool calls and outputs, assistant narration, and the
 * person's words (user messages and compaction summaries; the first prompt is pinned outside every lane). Each age region
 * holds a share of its lane's room at its level (outputs 0–3, arguments 0–2, narration 0–1, user messages 0). Past the
 * budget the oldest entry of the newest region over its share moves to the next region, and past the last it leaves.
 */
type Lane = "tool" | "narration" | "user";
const shares: Record<Lane, readonly number[]> = { tool: [0.5, 0.25, 0.15, 0.1], narration: [0.6, 0.4], user: [1] };
/**
 * Messages keep at most this share of a full index (bytes and entries), so tool entries always have the rest; within it
 * the person's words come first, and the newest narration keeps a floor of a tenth of it.
 */
const messageShare = 0.6, narrationFloor = 0.1;
const levelOf = (kind: Kind, region: number) => Math.min(region, levels[kind].length - 1);
/** Injected by Codex as a user message: host context, not the person's first prompt. */
const hostContext = /^\s*(?:<environment_context>|<user_instructions>|# AGENTS\.md instructions)/;
/** Excerpted on purpose, so they do not make the coverage incomplete; everything else does. */
const intentional = new Set(["image_omitted", "encrypted_reasoning_omitted", "thinking_omitted", "developer_instructions_omitted", "message_excerpt", "call_excerpt", "output_excerpt", "call_index_reduced", "output_index_reduced", "message_index_reduced"]);
/** Codex records with no conversation content in them (they still count in `growth`). */
const codexMetadata = new Set(["event_msg", "session_meta", "turn_context", "world_state", "token_usage_record"]);
/** A record type the index does not know, named in its gap so a real loss is not hidden among metadata. */
const unsupported = (...names: string[]) => `unsupported_record/${names.map((name) => redactHistory(name).replace(/[^\w.-]/g, "_").slice(0, 30) || "unknown").join("/")}`;

/**
 * Claude Code's stand-in for a tool result too large for the transcript: the path of the file that holds it (under the
 * session's tool-results/ folder) and its stated size.
 */
export function persistedStub(text: string): { path: string; bytes: number } | undefined {
  const match = /^<persisted-output>\r?\n[^\r\n]{0,200}?\((\d{1,9}(?:\.\d{1,3})?)\s?(B|KB|MB|GB)\)[^\r\n]{0,80}? saved to: ([^\r\n]{1,4096})\r?\n/.exec(text);
  if (!match) return undefined;
  const scale = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[match[2] as "B" | "KB" | "MB" | "GB"];
  return { path: match[3].trim(), bytes: Math.round(Number(match[1]) * scale) };
}
/** A persisted tool result as the builder read it: its source ref, size, and its text (absent when it was not read). */
export type PersistedOutput = { ref: string; bytes: number; fields?: Field[] };

type Slot = { kind: Kind; lane?: Lane; base: Omit<SessionHistoryEntry, "text" | "truncated" | "middle">; prefix: string; first: number; variants: Variant[]; size: number };
type Draft = { kind: Kind; role: SessionHistoryEntry["role"]; source: string; from: number; to: number; type: string; at?: string; tool?: SessionHistoryEntry["tool"]; prefix?: string; characters: number; decoded?: boolean; variants: Variant[]; paths: string[] };

/**
 * The derived index of one session (SESSION-HANDOFF-SPEC §8.1): messages, tool calls with their arguments and tool
 * outputs, each a redacted head and tail whose omitted middle is located in the source. Bounded by bytes and entries,
 * spent from the newest entry back: the newest calls, outputs and narration keep the widest level, older ones step down
 * by age and the oldest leave. Messages give way only past their share, narration before the person's words, and the
 * first prompt stays; no new entry is refused while an older one could leave. Every reduction is reported.
 */
export class HistoryRecords {
  readonly coverage: NonNullable<SessionHistoryPage["coverage"]> = { sourceBytes: 0, readBytes: 0, through: 0, totalRecords: 0, indexedEntries: 0, omittedEntries: 0, skippedLines: 0, skippedBytes: 0, complete: true };
  private gaps = new Map<string, { count: number; bytes: number }>();
  private growth = new Map<string, { bytes: number; lines: number }>();
  private slots: (Slot | null)[] = [];
  private bytes = 0;
  private messageBytes = 0;
  private messageCount = 0;
  private count = 0;
  private pinned = false;
  /** Bytes of each lane's entries in each age region. */
  private regionBytes = { tool: shares.tool.map(() => 0), narration: shares.narration.map(() => 0), user: shares.user.map(() => 0) };
  /** `edge[lane][r]`: every slot of the lane before this index is in region r or older; the last one is the eviction edge. */
  private edge = { tool: [0, ...shares.tool.map(() => 0)], narration: [0, ...shares.narration.map(() => 0)], user: [0, ...shares.user.map(() => 0)] };
  private evicted = { call: 0, output: 0, message: 0 };
  private ordinal = 0;
  private firstAt?: number;
  private calls = new Map<string, string>();
  /** Task notices already indexed: Claude writes one absorbed mid-turn as queue-operation records and may deliver it again. */
  private notices = new Set<string>();
  private identityMismatch = false;
  private readonly maxBytes: number;
  constructor(private sessionId: string, maxBytes: number = limits.skeletonBytes) { this.maxBytes = Math.min(maxBytes, limits.skeletonBytes); }
  gap(kind: string, bytes = 0) {
    if (this.gaps.size >= 19 && !this.gaps.has(kind)) kind = "other_gaps";
    const gap = this.gaps.get(kind) ?? { count: 0, bytes: 0 }; gap.count++; gap.bytes += bytes; this.gaps.set(kind, gap);
    if (!intentional.has(kind)) this.coverage.complete = false;
  }
  grow(type: string, bytes: number) { type = type.slice(0, 100); if (this.growth.size >= 15 && !this.growth.has(type)) type = "other"; const value = this.growth.get(type) ?? { bytes: 0, lines: 0 }; value.bytes += bytes; value.lines++; this.growth.set(type, value); }
  /**
   * The jsonl body, in source order. Every entry is checked against the entry schema first: read() refuses the whole
   * index over one entry that does not conform, and a rebuild would build the same body (SESSION-HANDOFF-SPEC §21.15).
   * A field past its bound is bounded (`entry_bounded`); an entry that still does not conform leaves (`entry_invalid`).
   */
  body() {
    return this.slots.flatMap((slot, index) => {
      if (!slot) return [];
      const entry = this.publishable(this.render(slot));
      if (!entry) { this.slots[index] = null; this.bytes -= slot.size; this.count--; this.gap("entry_invalid"); return []; }
      return [JSON.stringify(entry) + "\n"];
    }).join("");
  }
  private publishable(entry: SessionHistoryEntry): SessionHistoryEntry | undefined {
    if (sessionHistoryEntrySchema.safeParse(entry).success) return entry;
    this.gap("entry_bounded");
    const { at, relativeMs, tool, ...rest } = entry;
    const bounded: SessionHistoryEntry = { ...rest, text: entry.text.slice(0, limits.entryChars), paths: entry.paths.filter((path) => path.length <= 240).slice(0, 5), evidence: { ...entry.evidence, source: entry.evidence.source.slice(0, 100), type: entry.evidence.type.slice(0, 100) },
      ...(at !== undefined && at.length <= 80 ? { at, ...(relativeMs !== undefined ? { relativeMs } : {}) } : {}),
      ...(tool ? { tool: { name: tool.name.slice(0, 100), category: tool.category, ...(tool.kind ? { kind: tool.kind } : {}), ...(tool.outcome !== undefined ? { outcome: tool.outcome.slice(0, 300) } : {}) } } : {}) };
    return sessionHistoryEntrySchema.safeParse(bounded).success ? bounded : undefined;
  }
  metadata() {
    const width = (kind: Kind, level: number) => levels[kind][level].head + levels[kind][level].tail;
    // Only kinds the index keeps: a width for a kind with no entry would claim excerpts that do not exist.
    const narrowest: Partial<Record<Kind, number>> = {};
    for (const slot of this.slots) {
      if (!slot) continue;
      const variant = slot.variants[0];
      if (variant.middle) this.gap(`${slot.kind}_excerpt`, Math.max(0, variant.middle.to - variant.middle.from));
      if (slot.first > 0 && variant.truncated) this.gap(`${slot.kind}_index_reduced`);
      narrowest[slot.kind] = Math.min(narrowest[slot.kind] ?? Infinity, width(slot.kind, slot.first));
    }
    for (const kind of ["output", "call", "message"] as const) if (this.evicted[kind]) { this.gaps.set(`${kind}_index_budget`, { count: this.evicted[kind], bytes: 0 }); this.coverage.complete = false; }
    this.coverage.excerpts = { ...(narrowest.message !== undefined ? { message: narrowest.message } : {}), ...(narrowest.call !== undefined ? { arguments: narrowest.call } : {}), ...(narrowest.output !== undefined ? { output: narrowest.output } : {}) };
    this.coverage.indexedEntries = this.count;
    return { coverage: this.coverage, gaps: [...this.gaps].slice(0, 20).map(([kind, value]) => ({ kind, count: value.count, ...(value.bytes ? { bytes: value.bytes } : {}) })), growth: [...this.growth].map(([type, value]) => ({ type, ...value })) };
  }
  private render(slot: Slot): SessionHistoryEntry {
    const variant = slot.variants[0];
    return { ...slot.base, text: slot.prefix + variant.text, truncated: variant.truncated, ...(variant.middle ? { middle: variant.middle } : {}) };
  }
  private measure(slot: Slot) { return Buffer.byteLength(JSON.stringify(this.render(slot))) + 1; }
  /** Moves the oldest entry of a lane's age region `region` into the next one (a level down, or out of the index). */
  private demote(lane: Lane, region: number) {
    const edge = this.edge[lane], bytes = this.regionBytes[lane], end = region === 0 ? this.slots.length : edge[region];
    let index = edge[region + 1];
    while (index < end && this.slots[index]?.lane !== lane) index++;
    if (index >= end) return false;
    const slot = this.slots[index]!, message = slot.kind === "message";
    edge[region + 1] = index + 1; bytes[region] -= slot.size;
    if (region + 1 === shares[lane].length) {
      this.slots[index] = null; this.bytes -= slot.size; this.count--; this.evicted[slot.kind]++;
      if (message) { this.messageBytes -= slot.size; this.messageCount--; }
      return true;
    }
    const level = levelOf(slot.kind, region + 1);
    if (level !== slot.first) {
      slot.variants = slot.variants.slice(level - slot.first); slot.first = level;
      const size = this.measure(slot); this.bytes += size - slot.size; if (message) this.messageBytes += size - slot.size; slot.size = size;
    }
    bytes[region + 1] += slot.size;
    return true;
  }
  /** Steps down the newest region of a lane that holds more than its share of `room`. */
  private shed(lane: Lane, room: number) {
    const region = this.regionBytes[lane].findIndex((bytes, r) => bytes > Math.floor(shares[lane][r] * room));
    return region >= 0 && this.demote(lane, region);
  }
  /**
   * One step toward the byte budget. Messages past their share give way first: narration down to what the person's words
   * leave it (never below its floor), then the oldest of the person's words; otherwise tool entries, in what messages leave.
   */
  private reduce() {
    const sum = (lane: Lane) => this.regionBytes[lane].reduce((total, bytes) => total + bytes, 0);
    const room = Math.floor(messageShare * this.maxBytes);
    if (this.messageBytes > room) {
      const narration = sum("narration"), others = this.messageBytes - narration;
      if (this.shed("narration", Math.max(Math.floor(narrationFloor * room), room - others))) return true;
      if (this.shed("user", Math.max(0, room - (this.messageBytes - sum("user"))))) return true;
    }
    return this.shed("tool", Math.max(0, this.maxBytes - this.messageBytes));
  }
  /** The oldest entry of a lane leaves the index. */
  private evictOldest(lane: Lane) {
    const region = this.regionBytes[lane].findLastIndex((bytes) => bytes > 0);
    if (region < 0) return false;
    for (let r = region; r < shares[lane].length; r++) this.demote(lane, r);
    return true;
  }
  /** For the entry limit: a message leaves while messages hold more than their share of the entries, otherwise a tool entry. */
  private evictForCount() {
    const message = () => this.evictOldest("narration") || this.evictOldest("user");
    if (this.messageCount > messageShare * limits.entries && message()) return true;
    return this.evictOldest("tool") || message();
  }
  private add(draft: Draft) {
    // A source timestamp longer than the schema's bound (V8 parses long free-form dates) is written in ISO form.
    const ms = draft.at ? Date.parse(draft.at) : NaN, time = Number.isFinite(ms) ? draft.at!.length <= 80 ? draft.at : new Date(ms).toISOString() : undefined;
    if (time && this.firstAt === undefined) this.firstAt = ms;
    const base: Slot["base"] = { ordinal: this.ordinal++, role: draft.role, characters: draft.characters, ...(draft.decoded ? { decoded: true } : {}), paths: draft.paths, evidence: { source: draft.source, from: draft.from, to: draft.to, type: redactHistory(draft.type).slice(0, 100) }, ...(time ? { at: time, relativeMs: ms - this.firstAt! } : {}), ...(draft.tool ? { tool: draft.tool } : {}) };
    const message = draft.kind === "message";
    // The person's first prompt is pinned: never stepped down, never evicted.
    const pin = message && draft.role === "user" && !this.pinned && !hostContext.test(draft.variants[0]?.text ?? "");
    const lane: Lane | undefined = !message ? "tool" : pin ? undefined : draft.role === "assistant" && draft.type !== "claude/compact_summary" ? "narration" : "user";
    const slot: Slot = { kind: draft.kind, ...(lane ? { lane } : {}), base, prefix: draft.prefix ?? "", first: 0, variants: draft.variants, size: 0 };
    slot.size = this.measure(slot);
    if (this.count >= limits.entries && !this.evictForCount()) { this.coverage.omittedEntries++; this.coverage.complete = false; return; }
    if (pin) this.pinned = true;
    this.slots.push(slot); this.bytes += slot.size; this.count++;
    if (message) { this.messageBytes += slot.size; this.messageCount++; }
    if (lane) this.regionBytes[lane][0] += slot.size;
    while (this.bytes > this.maxBytes && this.reduce());
  }
  private paths(text: string, known: string[] = []) {
    const paths = new Set(known.slice(0, 5));
    // At most 240 characters, the schema's bound, whatever the prefix (`./` and `../` made a match of 241 or 242).
    for (const match of text.matchAll(/(?:^|[\s"'(=])((?:\/|\.\.?\/)[\w@.+/~\/-]{1,239})/g)) { if (paths.size === 5) break; paths.add(match[1].slice(0, 240)); }
    return [...paths];
  }
  /** Text parts of a content array (or a string); images and thinking are counted (`count`), never kept. */
  private parts(content: unknown, count = true): string[] {
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      const block = object(part), type = string(block.type);
      if (count && ["image", "input_image"].includes(type)) this.gap("image_omitted");
      // Claude's readable reasoning: the index is not the model's reasoning (§21.3), and says what it leaves out.
      if (count && (type === "thinking" || type === "redacted_thinking")) this.gap("thinking_omitted");
      return ["text", "input_text", "output_text"].includes(type) && typeof block.text === "string" ? [block.text] : [];
    });
  }
  private message(role: "user" | "assistant", parts: string[], raw: Buffer, source: string, from: number, to: number, type: string, at?: string) {
    if (!parts.join("").trim()) return;
    const cut = excerpt(locateFields(raw, from, parts), levels.message, { from, to });
    if (cut?.unsafe) this.gap("escaped_text_omitted");
    if (!cut) { this.gap("escaped_text_omitted"); this.add({ kind: "message", role, source, from, to, type, at, characters: 0, variants: levels.message.map(() => ({ text: "[escaped content omitted]", truncated: true })), paths: [] }); return; }
    this.add({ kind: "message", role, source, from, to, type, at, characters: cut.characters, decoded: cut.decoded, variants: cut.variants, paths: this.paths(cut.variants[0].text) });
  }
  private category(name: string): NonNullable<SessionHistoryEntry["tool"]>["category"] {
    return /exec|shell|Bash|stdin/.test(name) ? "exec" : /file|read|write|edit|patch/.test(name) ? "file" : /browser|screenshot/.test(name) ? "browser" : /agent|workflow|task/i.test(name) ? "agent" : /fetch|search|web/.test(name) ? "network" : "other";
  }
  /** A call: a raw string input (a code-mode script, a patch) is cut where it stands; structured arguments are walked. */
  private call(name: string, args: unknown, raw: Buffer, source: string, from: number, to: number, type: string, at?: string) {
    const safeName = redactHistory(name).slice(0, 100), tool = { name: safeName, category: this.category(name), kind: "call" as const };
    const opaque = typeof args === "string" && !/^[\s]*[\[{"]/.test(args);
    let fields: Field[], known: string[] = [];
    if (opaque) fields = locateFields(raw, from, [args]);
    else {
      const walked = safeArguments(args);
      if (walked.omitted) this.gap("tool_arguments_omitted");
      const data = object(walked.value);
      known = ["file_path", "filePath", "path", "cwd", "workdir", "directory"].map((key) => string(data[key])).filter((path) => path.length > 0 && path.length <= 240 && !/[\r\n]|:\/\/|\[(?:redacted|escaped|arguments)/.test(path));
      // Re-serialized: the middle is located within the arguments' own token when there is one.
      const token = typeof args === "string" ? locateFields(raw, from, [args])[0] : undefined;
      fields = [{ text: typeof walked.value === "string" ? walked.value : JSON.stringify(walked.value) }];
      if (token?.start !== undefined) { const end = token.start + Buffer.byteLength(JSON.stringify(args)) - 1; return this.callEntry(fields, tool, { from: token.start + 1, to: end }, source, from, to, type, at, known, walked.decoded); }
    }
    this.callEntry(fields, tool, { from, to }, source, from, to, type, at, known);
  }
  private callEntry(fields: Field[], tool: NonNullable<SessionHistoryEntry["tool"]>, span: { from: number; to: number }, source: string, from: number, to: number, type: string, at: string | undefined, known: string[], decoded = false) {
    const cut = excerpt(fields, levels.call, span);
    if (cut?.unsafe) this.gap("escaped_text_omitted");
    if (!cut) { this.gap("escaped_text_omitted"); this.add({ kind: "call", role: "tool", source, from, to, type, at, tool, prefix: `${tool.name}: `, characters: 0, variants: levels.call.map(() => ({ text: "[escaped content omitted]", truncated: true })), paths: known.slice(0, 5) }); return; }
    this.add({ kind: "call", role: "tool", source, from, to, type, at, tool, prefix: `${tool.name}: `, characters: cut.characters, decoded: cut.decoded || decoded, variants: cut.variants, paths: this.paths(cut.variants[0].text, known) });
  }
  /**
   * A tool's output: bounded head and tail, its exit code or error as `outcome`. `fields` are located in the record at
   * `from`–`to` of `source`, or are the whole of a persisted output's file (`source` is then that file).
   */
  private output(name: string, fields: Field[], outcome: string | undefined, source: string, from: number, to: number, type: string, at?: string) {
    if (!fields.map((field) => field.text).join("").trim() && !outcome) return;
    const tool = { name: redactHistory(name).slice(0, 100), category: this.category(name), kind: "output" as const, ...(outcome ? { outcome: sanitizeText(outcome)?.text.slice(0, 300) ?? "error" } : {}) };
    const cut = fields.length ? excerpt(fields, levels.output, { from, to }) : { characters: 0, decoded: false, unsafe: false, variants: levels.output.map(() => ({ text: "", truncated: false })) };
    if (cut?.unsafe) this.gap("escaped_text_omitted");
    if (!cut) { this.gap("escaped_text_omitted"); this.add({ kind: "output", role: "tool", source, from, to, type, at, tool, characters: 0, variants: levels.output.map(() => ({ text: "[escaped content omitted]", truncated: true })), paths: [] }); return; }
    this.add({ kind: "output", role: "tool", source, from, to, type, at, tool, characters: cut.characters, decoded: cut.decoded, variants: cut.variants, paths: this.paths(cut.variants[0].text) });
  }
  /** The files a Claude record's persisted tool results name, for the builder to read before the record (`line`). */
  persistedPaths(raw: Buffer): string[] {
    let value: Record<string, unknown>;
    try { value = object(JSON.parse(raw.toString("utf8"))); } catch { return []; }
    const content = object(value.message).content;
    if (value.type !== "user" || value.isSidechain === true || !Array.isArray(content)) return [];
    return content.flatMap((item) => { const block = object(item); return block.type === "tool_result" ? this.parts(block.content, false).flatMap((part) => { const stub = persistedStub(part); return stub ? [stub.path] : []; }) : []; });
  }
  /** `persisted`: the persisted tool results this record names, as the builder read them (`persistedPaths`). */
  line(raw: Buffer, provider: "codex" | "claude", source: string, from: number, to: number, textOnly: boolean, persisted?: ReadonlyMap<string, PersistedOutput>) {
    let value: Record<string, unknown>;
    try { value = object(JSON.parse(raw.toString("utf8"))); } catch { this.gap("invalid_json", raw.length); return; }
    const type = string(value.type), payload = object(value.payload), at = string(value.timestamp);
    if (!textOnly && (value.sessionId && value.sessionId !== this.sessionId || type === "session_meta" && payload.id && payload.id !== this.sessionId)) this.identityMismatch = true;
    if (this.identityMismatch) { this.gap("session_identity_mismatch", raw.length); return; }
    if (provider === "codex") return this.codex(type, payload, raw, source, from, to, at);
    if (value.isSidechain === true && !textOnly) { this.gap("sidechain_omitted"); return; }
    const msg = object(value.message), content = msg.content;
    if (type === "user" || type === "assistant") {
      if (value.isMeta === true) return;
      const role = type === "assistant" || value.isCompactSummary === true ? "assistant" : "user";
      if (role === "user" && typeof content === "string" && this.repeatedNotice(content)) return;
      this.message(role, this.parts(content), raw, source, from, to, value.isCompactSummary ? "claude/compact_summary" : `claude/${type}`, at);
      if (!textOnly && Array.isArray(content)) for (const item of content) {
        const block = object(item);
        if (block.type === "tool_use") { this.rememberCall(string(block.id), string(block.name)); this.call(string(block.name), block.input, raw, source, from, to, "claude/tool_use", at); }
        if (block.type === "tool_result") {
          const callId = string(block.tool_use_id), name = this.calls.get(callId) ?? "tool_result"; this.calls.delete(callId);
          this.toolResult(name, this.parts(block.content), block.is_error === true ? "error" : undefined, raw, source, from, to, at, persisted);
        }
      }
    } else if (type === "attachment") this.attachment(object(value.attachment), raw, source, from, to, at);
    else if (type === "queue-operation") {
      // A task notice absorbed into a running turn is written only here (enqueue, then remove); a person's queued words
      // are recorded where they are delivered (an attachment or a user record).
      const queued = value.content;
      if (typeof queued === "string" && queued.includes("<task-notification>") && !this.repeatedNotice(queued)) this.message("user", [queued], raw, source, from, to, "claude/queue-operation", at);
    } else if (!claudeMetadataRecords.has(type) && type !== "pr-link") this.gap(unsupported(type));
  }
  /**
   * A Claude tool result. One that Claude Code saved to a file (a <persisted-output> stub with a 2 KB preview) is indexed
   * from that file when the builder read it, its middle located in the file's bytes; otherwise the preview is indexed
   * and the loss is a named gap (SESSION-HANDOFF-SPEC §8.1).
   */
  private toolResult(name: string, parts: string[], outcome: string | undefined, raw: Buffer, source: string, from: number, to: number, at: string, persisted?: ReadonlyMap<string, PersistedOutput>) {
    const fields = locateFields(raw, from, parts), stubs = fields.map((field) => persistedStub(field.text));
    const saved = stubs.findIndex(Boolean), stub = stubs[saved], file = stub && persisted?.get(stub.path);
    if (!stub || !file?.fields) {
      // The file's size when it is there, otherwise the size the stub states.
      if (stub) this.gap("persisted_output_not_indexed", file?.bytes || stub.bytes);
      return this.output(name, fields, outcome, source, from, to, "claude/tool_result", at);
    }
    this.output(name, file.fields, outcome, file.ref, 0, file.bytes, "claude/tool_result/persisted", at);
    const rest = fields.filter((_, index) => index !== saved);
    if (rest.some((field) => field.text.trim())) this.output(name, rest, undefined, source, from, to, "claude/tool_result", at);
  }
  /**
   * Claude Code run through the SDK writes what arrives during a turn (a person's words, a task notice) only as an
   * attachment of type queued_command: no user record repeats it. Routine attachments are host metadata.
   */
  private attachment(attachment: Record<string, unknown>, raw: Buffer, source: string, from: number, to: number, at: string) {
    const subtype = string(attachment.type);
    if (subtype === "queued_command") {
      const prompt = attachment.prompt;
      if (typeof prompt === "string" && this.repeatedNotice(prompt)) return;
      this.message("user", this.parts(prompt), raw, source, from, to, "claude/attachment/queued_command", at);
    } else if (!claudeRoutineAttachments.has(subtype)) this.gap(unsupported("attachment", subtype));
  }
  /** Whether this task notice was indexed already (remembers it otherwise); any other text is never a repeat. */
  private repeatedNotice(text: string) {
    if (!text.includes("<task-notification>")) return false;
    const key = createHash("sha256").update(text).digest("hex");
    if (this.notices.has(key)) return true;
    this.notices.add(key); if (this.notices.size > 64) this.notices.delete(this.notices.values().next().value!);
    return false;
  }
  private codex(type: string, payload: Record<string, unknown>, raw: Buffer, source: string, from: number, to: number, at: string) {
    const item = string(payload.type);
    if (type === "response_item" && item === "message") {
      const role = string(payload.role);
      if (role === "user" || role === "assistant") this.message(role, this.parts(payload.content), raw, source, from, to, type + "/message", at);
      else this.gap(role === "developer" || role === "system" ? "developer_instructions_omitted" : unsupported(type, "message", role));
    } else if (type === "response_item" && ["function_call", "custom_tool_call"].includes(item)) {
      const callId = string(payload.call_id); if (callId) this.rememberCall(callId, string(payload.name));
      this.call(string(payload.name), payload.arguments ?? payload.input, raw, source, from, to, type + "/" + item, at);
    } else if (type === "response_item" && /output/.test(item)) {
      const callId = string(payload.call_id), name = this.calls.get(callId) ?? "tool_result"; this.calls.delete(callId);
      const output = payload.output, parts = typeof output === "string" ? [output] : Array.isArray(output) ? this.parts(output) : output === undefined ? [] : [JSON.stringify(output)];
      this.output(name, locateFields(raw, from, parts), codexOutcome(output, parts), source, from, to, type + "/" + item, at);
    } else if (type === "compacted" || type === "response_item" && item === "reasoning") this.gap("encrypted_reasoning_omitted");
    else if (!codexMetadata.has(type)) this.gap(type === "response_item" ? unsupported(type, item) : unsupported(type));
  }
  private rememberCall(id: string, name: string) { if (!id) return; this.calls.set(id, name); if (this.calls.size > 64) this.calls.delete(this.calls.keys().next().value!); }
}

/** How a Codex tool call ended, when its output says so: an exit code, an error, a failed script. */
function codexOutcome(output: unknown, parts: string[]): string | undefined {
  const parse = (text: string) => { if (!/^\s*\{/.test(text) || text.length > 256 * 1024) return {}; try { return object(JSON.parse(text)); } catch { return {}; } };
  const result = typeof output === "string" ? parse(output) : object(output);
  const exit = result.exit_code ?? object(result.metadata).exit_code;
  if (typeof exit === "number" && Number.isSafeInteger(exit)) return `exit ${exit}`;
  if (string(result.error)) return string(result.error);
  if (result.is_error === true || result.isError === true) return "error";
  const header = /^Process exited with code (-?\d{1,10})\b/m.exec(parts[0]?.slice(0, 500) ?? "")?.[1];
  if (header !== undefined) return `exit ${header}`;
  const script = /^Script (?!completed\b)[^\n]{1,200}/.exec(parts[0] ?? "")?.[0];
  if (script) return script;
  if (parts.slice(1).some((part) => { const data = parse(part); return data.isError === true || data.is_error === true; })) return "error";
  return undefined;
}
