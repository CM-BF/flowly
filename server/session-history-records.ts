import { sessionHistoryExcerpts as excerpts, sessionHistoryLimits as limits, type SessionHistoryEntry, type SessionHistoryPage } from "../shared/session-history";
import { excerpt, locateFields, redactHistory, safeArguments, sanitizeText, type Budget, type Field, type Variant } from "./session-history-text";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" ? value : "";
type Kind = "message" | "call" | "output";
const levels: Record<Kind, readonly Budget[]> = { message: excerpts.message, call: excerpts.arguments, output: excerpts.output };
/** The order outputs and arguments step down when the index would pass its budget. */
const steps: [Kind, number][] = [["output", 1], ["call", 1], ["output", 2], ["call", 2], ["output", 3]];
/** Excerpted on purpose, so they do not make the coverage incomplete; everything else does. */
const intentional = new Set(["image_omitted", "encrypted_reasoning_omitted", "developer_instructions_omitted", "message_excerpt", "call_excerpt", "output_excerpt"]);
/** Codex records with no conversation content in them (they still count in `growth`). */
const codexMetadata = new Set(["event_msg", "session_meta", "turn_context", "world_state", "token_usage_record"]);

type Slot = { kind: Kind; base: Omit<SessionHistoryEntry, "text" | "truncated" | "middle">; prefix: string; first: number; variants: Variant[]; size: number };
type Draft = { kind: Kind; role: SessionHistoryEntry["role"]; source: string; from: number; to: number; type: string; at?: string; tool?: SessionHistoryEntry["tool"]; prefix?: string; characters: number; decoded?: boolean; variants: Variant[]; paths: string[] };

/**
 * The derived index of one session (SESSION-HANDOFF-SPEC §8.1): messages, tool calls with their arguments and tool
 * outputs, each a redacted head and tail whose omitted middle is located in the source. Bounded by bytes and entries:
 * outputs and then arguments step down a level, then the oldest calls and outputs leave by age (so the latest tool
 * results stay), and only when messages alone fill it is a new entry refused; every reduction is reported.
 */
export class HistoryRecords {
  readonly coverage: NonNullable<SessionHistoryPage["coverage"]> = { sourceBytes: 0, readBytes: 0, through: 0, totalRecords: 0, indexedEntries: 0, omittedEntries: 0, skippedLines: 0, skippedBytes: 0, complete: true };
  private gaps = new Map<string, { count: number; bytes: number }>();
  private growth = new Map<string, { bytes: number; lines: number }>();
  private slots: (Slot | null)[] = [];
  private bytes = 0;
  private count = 0;
  private level: Record<Kind, number> = { message: 0, call: 0, output: 0 };
  private step = 0;
  private oldestTool = 0;
  private evicted = { call: 0, output: 0 };
  private ordinal = 0;
  private firstAt?: number;
  private calls = new Map<string, string>();
  private identityMismatch = false;
  private readonly maxBytes: number;
  constructor(private sessionId: string, maxBytes: number = limits.skeletonBytes) { this.maxBytes = Math.min(maxBytes, limits.skeletonBytes); }
  gap(kind: string, bytes = 0) {
    if (this.gaps.size >= 19 && !this.gaps.has(kind)) kind = "other_gaps";
    const gap = this.gaps.get(kind) ?? { count: 0, bytes: 0 }; gap.count++; gap.bytes += bytes; this.gaps.set(kind, gap);
    if (!intentional.has(kind)) this.coverage.complete = false;
  }
  grow(type: string, bytes: number) { if (this.growth.size >= 15 && !this.growth.has(type)) type = "other"; const value = this.growth.get(type) ?? { bytes: 0, lines: 0 }; value.bytes += bytes; value.lines++; this.growth.set(type, value); }
  /** The jsonl body, in source order. */
  body() { return this.slots.flatMap((slot) => slot ? [JSON.stringify(this.render(slot)) + "\n"] : []).join(""); }
  metadata() {
    for (const slot of this.slots) {
      const middle = slot && this.variant(slot).middle;
      if (middle) this.gap(`${slot.kind}_excerpt`, middle.to - middle.from);
    }
    if (this.evicted.output) this.gaps.set("output_index_budget", { count: this.evicted.output, bytes: 0 });
    if (this.evicted.call) this.gaps.set("call_index_budget", { count: this.evicted.call, bytes: 0 });
    if (this.evicted.output || this.evicted.call) this.coverage.complete = false;
    const width = (kind: Kind) => { const { head, tail } = levels[kind][this.level[kind]]; return head + tail; };
    this.coverage.excerpts = { message: width("message"), arguments: width("call"), output: width("output") };
    this.coverage.indexedEntries = this.count;
    return { coverage: this.coverage, gaps: [...this.gaps].slice(0, 20).map(([kind, value]) => ({ kind, count: value.count, ...(value.bytes ? { bytes: value.bytes } : {}) })), growth: [...this.growth].map(([type, value]) => ({ type, ...value })) };
  }
  private variant(slot: Slot) { return slot.variants[this.level[slot.kind] - slot.first]; }
  private render(slot: Slot): SessionHistoryEntry {
    const variant = this.variant(slot);
    return { ...slot.base, text: slot.prefix + variant.text, truncated: variant.truncated, ...(variant.middle ? { middle: variant.middle } : {}) };
  }
  private measure(slot: Slot) { return Buffer.byteLength(JSON.stringify(this.render(slot))) + 1; }
  /** The next step down for outputs or arguments; false when both are at their last level. */
  private reduce() {
    if (this.step >= steps.length) return false;
    const [kind, level] = steps[this.step++];
    this.level[kind] = level;
    for (const slot of this.slots) if (slot?.kind === kind) {
      const size = this.measure(slot); this.bytes += size - slot.size; slot.size = size;
      slot.variants = slot.variants.slice(level - slot.first); slot.first = level;
    }
    return true;
  }
  /** Removes the oldest call or output, whichever came first; messages never leave for a later entry. */
  private evict() {
    for (; this.oldestTool < this.slots.length; this.oldestTool++) {
      const slot = this.slots[this.oldestTool];
      if (!slot || slot.kind === "message") continue;
      this.slots[this.oldestTool++] = null; this.bytes -= slot.size; this.count--; this.evicted[slot.kind]++;
      return true;
    }
    return false;
  }
  private add(draft: Draft) {
    const time = draft.at && Number.isFinite(Date.parse(draft.at)) ? draft.at : undefined, ms = time ? Date.parse(time) : undefined;
    if (ms !== undefined && this.firstAt === undefined) this.firstAt = ms;
    const base: Slot["base"] = { ordinal: this.ordinal++, role: draft.role, characters: draft.characters, ...(draft.decoded ? { decoded: true } : {}), paths: draft.paths, evidence: { source: draft.source, from: draft.from, to: draft.to, type: redactHistory(draft.type).slice(0, 100) }, ...(time ? { at: time, relativeMs: ms! - this.firstAt! } : {}), ...(draft.tool ? { tool: draft.tool } : {}) };
    const first = this.level[draft.kind], slot: Slot = { kind: draft.kind, base, prefix: draft.prefix ?? "", first, variants: draft.variants.slice(first), size: 0 };
    slot.size = this.measure(slot);
    while (this.bytes + slot.size > this.maxBytes || this.count >= limits.entries) {
      const full = this.count >= limits.entries;
      if (!full && this.reduce()) { slot.variants = draft.variants.slice(this.level[draft.kind]); slot.first = this.level[draft.kind]; slot.size = this.measure(slot); continue; }
      if (!this.evict()) { this.coverage.omittedEntries++; this.coverage.complete = false; return; }
    }
    this.slots.push(slot); this.bytes += slot.size; this.count++;
  }
  private paths(text: string, known: string[] = []) {
    const paths = new Set(known.slice(0, 5));
    for (const match of text.matchAll(/(?:^|[\s"'(=])((?:\/|\.\.?\/)[\w@.+/~\/-]{1,239})/g)) { if (paths.size === 5) break; paths.add(match[1]); }
    return [...paths];
  }
  /** Text parts of a content array (or a string); images are counted, never kept. */
  private parts(content: unknown): string[] {
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => { const block = object(part); if (["image", "input_image"].includes(string(block.type))) this.gap("image_omitted"); return ["text", "input_text", "output_text"].includes(string(block.type)) && typeof block.text === "string" ? [block.text] : []; });
  }
  private message(role: "user" | "assistant", parts: string[], raw: Buffer, source: string, from: number, to: number, type: string, at?: string) {
    if (!parts.join("").trim()) return;
    const cut = excerpt(locateFields(raw, from, parts), levels.message, { from, to });
    if (cut?.unsafe) this.gap("escaped_text_omitted");
    if (!cut) { this.gap("escaped_text_omitted"); this.add({ kind: "message", role, source, from, to, type, at, characters: 0, variants: [{ text: "[escaped content omitted]", truncated: true }], paths: [] }); return; }
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
  /** A tool's output: bounded head and tail, its exit code or error as `outcome`. */
  private output(name: string, parts: string[], outcome: string | undefined, raw: Buffer, source: string, from: number, to: number, type: string, at?: string) {
    if (!parts.join("").trim() && !outcome) return;
    const tool = { name: redactHistory(name).slice(0, 100), category: this.category(name), kind: "output" as const, ...(outcome ? { outcome: sanitizeText(outcome)?.text.slice(0, 300) ?? "error" } : {}) };
    const cut = parts.length ? excerpt(locateFields(raw, from, parts), levels.output, { from, to }) : { characters: 0, decoded: false, unsafe: false, variants: levels.output.map(() => ({ text: "", truncated: false })) };
    if (cut?.unsafe) this.gap("escaped_text_omitted");
    if (!cut) { this.gap("escaped_text_omitted"); this.add({ kind: "output", role: "tool", source, from, to, type, at, tool, characters: 0, variants: levels.output.map(() => ({ text: "[escaped content omitted]", truncated: true })), paths: [] }); return; }
    this.add({ kind: "output", role: "tool", source, from, to, type, at, tool, characters: cut.characters, decoded: cut.decoded, variants: cut.variants, paths: this.paths(cut.variants[0].text) });
  }
  line(raw: Buffer, provider: "codex" | "claude", source: string, from: number, to: number, textOnly: boolean) {
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
      this.message(role, this.parts(content), raw, source, from, to, value.isCompactSummary ? "claude/compact_summary" : `claude/${type}`, at);
      if (!textOnly && Array.isArray(content)) for (const item of content) {
        const block = object(item);
        if (block.type === "tool_use") { this.rememberCall(string(block.id), string(block.name)); this.call(string(block.name), block.input, raw, source, from, to, "claude/tool_use", at); }
        if (block.type === "tool_result") {
          const callId = string(block.tool_use_id), name = this.calls.get(callId) ?? "tool_result"; this.calls.delete(callId);
          this.output(name, this.parts(block.content), block.is_error === true ? "error" : undefined, raw, source, from, to, "claude/tool_result", at);
        }
      }
    } else if (!["system", "progress", "file-history-snapshot", "queue-operation"].includes(type)) this.gap("unsupported_record");
  }
  private codex(type: string, payload: Record<string, unknown>, raw: Buffer, source: string, from: number, to: number, at: string) {
    const item = string(payload.type);
    if (type === "response_item" && item === "message") {
      const role = string(payload.role);
      if (role === "user" || role === "assistant") this.message(role, this.parts(payload.content), raw, source, from, to, type + "/message", at);
      else this.gap(role === "developer" || role === "system" ? "developer_instructions_omitted" : "unsupported_record");
    } else if (type === "response_item" && ["function_call", "custom_tool_call"].includes(item)) {
      const callId = string(payload.call_id); if (callId) this.rememberCall(callId, string(payload.name));
      this.call(string(payload.name), payload.arguments ?? payload.input, raw, source, from, to, type + "/" + item, at);
    } else if (type === "response_item" && /output/.test(item)) {
      const callId = string(payload.call_id), name = this.calls.get(callId) ?? "tool_result"; this.calls.delete(callId);
      const output = payload.output, parts = typeof output === "string" ? [output] : Array.isArray(output) ? this.parts(output) : output === undefined ? [] : [JSON.stringify(output)];
      this.output(name, parts, codexOutcome(output, parts), raw, source, from, to, type + "/" + item, at);
    } else if (type === "compacted" || type === "response_item" && item === "reasoning") this.gap("encrypted_reasoning_omitted");
    else if (!codexMetadata.has(type)) this.gap("unsupported_record");
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
