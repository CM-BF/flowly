import { createHash } from "node:crypto";
import { handoffMessageSource, handoffSource } from "./handoff-source";
import type { CaptureBackground, CaptureGap, CaptureSemantics, CaptureSource } from "./handoff-capture";

export const captureLimits = { bytes: 64 * 2 ** 20, line: 256 * 2 ** 10, chunk: 64 * 2 ** 10, records: 5000, gaps: 100, calls: 64, live: 8, liveChars: 4000, messageChars: 800 } as const;

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown) => typeof value === "string" ? value : "";
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const id = (value: unknown): string | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === "string" && /^[\w:.-]{1,200}$/.test(value) && !/^(?:sk-|gh[pousr]_|github_pat_|glpat-|npm_|xox[abprs]-)/.test(value) ? value : undefined;
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
const stableId = handoffSource;
const sourceKey = (source: CaptureSource) => `${source.agentId}:${source.provider}:${source.sessionId ?? ""}:${source.fileId ?? ""}:${source.offset ?? ""}`;
const toolNames = new Map<string, { kind: CaptureBackground["kind"]; action: "start" | "close" | "poll" }>([
  ["register_async_shell", { kind: "async_shell", action: "start" }], ["cancel_async_shell", { kind: "async_shell", action: "close" }],
  ["Bash", { kind: "exec", action: "start" }], ["exec_command", { kind: "exec", action: "start" }], ["write_stdin", { kind: "exec", action: "poll" }],
  ["browser_new_tab", { kind: "browser", action: "start" }], ["close_tab", { kind: "browser", action: "close" }], ["browser_close_tab", { kind: "browser", action: "close" }],
  ["create_terminal", { kind: "terminal", action: "start" }], ["start_workspace_script", { kind: "workspace_script", action: "start" }],
  ["create_agent", { kind: "agent", action: "start" }], ["spawn_agent", { kind: "agent", action: "start" }],
  ["create_schedule", { kind: "schedule", action: "start" }], ["delete_schedule", { kind: "schedule", action: "close" }], ["cancel_schedule", { kind: "schedule", action: "close" }],
  ["create_heartbeat", { kind: "heartbeat", action: "start" }], ["delete_heartbeat", { kind: "heartbeat", action: "close" }], ["cancel_heartbeat", { kind: "heartbeat", action: "close" }],
]);
export type PendingCaptureCall = { callId: string; kind: CaptureBackground["kind"]; action: "start" | "close" | "poll"; source: CaptureSource; at: string; handle?: string; label?: string; detached?: boolean };

/** Keep task paths and prose, remove credential values and inline binary data before any excerpt is made. */
export function redactCaptureText(text: string): string {
  return text
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/data:[\w.+/-]+;base64,[A-Za-z0-9+/=]+/gi, "[inline data omitted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@")
    .replace(/((?:proxy-)?Authorization(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?(?:Bearer|Basic|token)\s+)[^\s"'<>\\,}]+/gi, "$1[redacted]")
    .replace(/\b((?:[A-Z_][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH)[A-Z0-9_]*|api[_-]?key|password|secret|token)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;<>]+)/gi, "$1[redacted]")
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]+|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g, "[redacted]")
    .replace(/[A-Za-z0-9_+=-]{40,}/g, (value) => /^[0-9a-f]+$/i.test(value) ? value : /\d/.test(value) && /[a-z]/i.test(value) ? "[redacted]" : value);
}

export function lineHint(prefix: Uint8Array) {
  const text = Buffer.from(prefix).toString("utf8");
  const types = [...text.matchAll(/"type"\s*:\s*"([\w.-]{1,80})"/g)].slice(0, 2).map((match) => redactCaptureText(match[1]));
  const at = /"timestamp"\s*:\s*"([^"\r\n]{1,80})"/.exec(text)?.[1];
  return { type: types.join("/") || "unknown", at: at && Number.isFinite(Date.parse(at)) ? at : undefined, messageId: id(/"(?:message_id|messageId|client_message_id|uuid)"\s*:\s*"([\w:.-]{1,200})"/.exec(text)?.[1]) };
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => { const value = object(item); return ["text", "input_text", "output_text"].includes(string(value.type)) && typeof value.text === "string" ? [value.text] : []; }).join("\n");
}
const unescapeXml = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]!);
/** Mirrors Paseo 0.12's versioned envelope grammar; human-quoted reserved content stays human. */
function envelope(text: string): { kind: string; text: string; messageId?: string; senderId?: string; title?: string; event?: string } | undefined {
  const system = /^<paseo-system>\n([\s\S]*)\n<\/paseo-system>$/.exec(text);
  if (system) return { kind: "system-message", text: system[1], title: "Paseo system" };
  const match = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>\n([\s\S]*)\n<\/paseo-system>$/.exec(text);
  if (!match || /[<>]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(match[2])) return;
  const attributes = new Map<string, string>();
  for (const found of match[1].matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
    if (attributes.has(found[1]) || /&(?!amp;|lt;|gt;|quot;|apos;)/.test(found[2])) return;
    attributes.set(found[1], unescapeXml(found[2]));
  }
  const kind = attributes.get("kind"), messageId = id(attributes.get("message-id")), senderId = id(attributes.get("source-agent-id"));
  if (attributes.get("version") !== "1" || !messageId || !["user-message", "agent-message", "agent-notification"].includes(kind ?? "")) return;
  if (kind === "user-message" && (senderId || attributes.has("event"))) return;
  if (kind !== "user-message" && !senderId) return;
  const event = attributes.get("event");
  if (kind === "agent-notification" && !["finished", "errored", "permission-required", "closed"].includes(event ?? "")) return;
  return { kind: kind!, text: unescapeXml(match[2]), messageId, senderId, title: attributes.get("source-agent-title"), event };
}

/** This Codex record is usage metadata, not task content; unknown extensions must still remain visible as gaps. */
function tokenUsageMetadata(entry: RecordValue, sessionId: string | undefined) {
  const exact = (value: RecordValue, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  if (!sessionId || !exact(entry, ["timestamp", "ordinal", "type", "payload"]) || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp)) || !Number.isSafeInteger(entry.ordinal) || (entry.ordinal as number) < 0) return false;
  const payload = object(entry.payload), identities = ["thread_id", "turn_id", "session_id", "root_turn_id", "response_id"], groups = ["usage", "turn_token_usage", "thread_token_usage"];
  if (!exact(payload, [...identities, ...groups]) || payload.thread_id !== sessionId || payload.session_id !== sessionId || !identities.every(key => typeof payload[key] === "string" && id(payload[key]) === payload[key])) return false;
  const counters = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
  return groups.every(key => { const usage = object(payload[key]); return exact(usage, counters) && counters.every(counter => Number.isSafeInteger(usage[counter]) && (usage[counter] as number) >= 0); });
}

export class CaptureRecords {
  readonly result: CaptureSemantics = { inputs: [], live: [], background: [], usage: [], compactions: [], gaps: [], omittedGaps: 0, narrationOmitted: 0, narrationTrimmedChars: 0 };
  private calls = new Map<string, PendingCaptureCall>();
  private sent: Set<string>;
  sawUsage = false;
  firstUsageAvailable = true;
  identityMismatch = false;
  constructor(private agentId: string, private capturedAt: string, sentMessageIds: readonly string[] = [], private automationTextHashes: readonly string[] = []) { this.sent = new Set(sentMessageIds); }
  restore(calls: PendingCaptureCall[], sawUsage: boolean, firstUsageAvailable: boolean) { this.calls = new Map(calls.slice(-captureLimits.calls).map((call) => [call.callId, call])); this.sawUsage = sawUsage; this.firstUsageAvailable = firstUsageAvailable; }
  pending() { return [...this.calls.values()]; }
  gap(value: CaptureGap) { value.id = stableId(value.id); if (["parse_failed", "unknown_record_type", "unknown_event_type", "unknown_response_type", "session_identity_mismatch"].includes(value.kind)) this.firstUsageAvailable = false; if (this.result.gaps.length < captureLimits.gaps) this.result.gaps.push(value); else this.result.omittedGaps++; }
  private time(value: unknown) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? { at: value, atSource: "provider" as const } : { at: this.capturedAt, atSource: "captured" as const }; }
  private message(text: string, source: CaptureSource, timestamp: unknown, assistant = false, received = false) {
    if (!text.trim()) return;
    const wrapped = assistant ? undefined : envelope(text.trim());
    if (!assistant && text.trimStart().startsWith("<paseo-system") && !wrapped) {
      this.gap({ id: `envelope:${sourceKey(source)}`, kind: "unknown_system_envelope", source }); return;
    }
    if (wrapped) {
      source = { ...source, messageId: wrapped.messageId ?? source.messageId }; text = wrapped.text;
      if (wrapped.kind === "agent-notification" && ["finished", "errored", "closed"].includes(wrapped.event!)) this.result.background.push({ id: `notice:${this.agentId}:${wrapped.messageId}`, source, kind: "agent", handle: wrapped.senderId, status: "closed", outcome: wrapped.event, at: this.time(timestamp).at });
    }
    if (!assistant && text.trimStart().startsWith("[Flowly automation]")) return;
    if (!assistant && text.trimStart().startsWith("[async-shell")) {
      const notice = /^\[async-shell\s+(finished|failed|timed_out)\s+([\w.-]+)(?:\s|\])/.exec(text.trimStart());
      if (notice) this.result.background.push({ id: `async-notice:${sourceKey(source)}`, source, kind: "async_shell", handle: notice[2], status: "closed", outcome: notice[1], at: this.time(timestamp).at });
      else this.gap({ id: `async-notice:${sourceKey(source)}`, kind: "unknown_background_notice", source });
      return;
    }
    const messageId = source.messageId;
    const fromFlowly = !assistant && !wrapped && !messageId && this.automationTextHashes.includes(createHash("sha256").update(text).digest("hex"));
    if (!assistant && messageId && this.sent.has(messageId)) return;
    const key = messageId ? handoffMessageSource(this.agentId, messageId) : handoffSource(`message:${sourceKey(source)}`);
    const safe = redactCaptureText(text), time = this.time(timestamp);
    if (assistant) {
      const excerpt = safe.slice(0, captureLimits.messageChars);
      this.result.narrationTrimmedChars += safe.length - excerpt.length;
      this.result.live.push({ id: key, source, text: excerpt, ...time, ...(safe.length > excerpt.length ? { truncated: true } : {}), ...(messageId ? { messageId } : {}) });
      while (this.result.live.length > captureLimits.live || this.result.live.reduce((n, item) => n + item.text.length, 0) > captureLimits.liveChars) { this.result.live.shift(); this.result.narrationOmitted++; }
    } else this.result.inputs.push({ id: key, source, text: safe, ...time, ...(safe !== text ? { redacted: true } : {}), ...(messageId ? { messageId } : {}), via: fromFlowly || wrapped && wrapped.kind !== "user-message" ? "agent" : "session", ...(fromFlowly ? { senderTitle: "Flowly automation" } : {}), ...(wrapped?.senderId ? { senderId: wrapped.senderId } : {}), ...(wrapped?.title ? { senderTitle: redactCaptureText(wrapped.title).slice(0, 200) } : {}), status: received || fromFlowly ? "received" : "open" });
  }
  private call(name: string, callId: string, input: unknown, source: CaptureSource, timestamp: unknown) {
    const tool = [...toolNames].find(([known]) => name === known || name.endsWith(`__${known}`) || name.endsWith(`.${known}`))?.[1];
    if (!tool) {
      if (["exec", "Workflow"].includes(name.split(".").pop() ?? "")) this.gap({ id: `opaque:${sourceKey(source)}`, kind: "opaque_tool_background", source });
      return;
    }
    if (!id(callId)) { this.gap({ id: `call:${sourceKey(source)}`, kind: "tool_call_identity_unknown", source }); return; }
    let data = object(input);
    if (typeof input === "string") { try { if (input.length > captureLimits.line || Buffer.byteLength(input) > captureLimits.line) throw new Error("Large arguments"); data = object(JSON.parse(input)); } catch { this.gap({ id: `call:${sourceKey(source)}`, kind: "unparsed_tool_arguments", source }); } }
    const detached = data.run_in_background === true || /\bnohup\b|&\s*$/.test(string(data.cmd ?? data.command));
    if (name === "Bash" && !detached) return;
    const handle = id(data.session_id ?? data.task_id ?? data.taskId ?? data.agentId ?? data.agent_id ?? data.tabId ?? data.tab_id ?? data.terminalId ?? data.scheduleId ?? data.heartbeatId ?? data.id);
    const label = redactCaptureText(string(data.cmd ?? data.command ?? data.title ?? data.name)).slice(0, 120);
    const call: PendingCaptureCall = { callId, ...tool, source, at: this.time(timestamp).at, ...(handle ? { handle } : {}), ...(label ? { label } : {}), ...(detached ? { detached: true } : {}) };
    this.calls.set(callId, call);
    if (this.calls.size > captureLimits.calls) { const first = this.calls.keys().next().value!; this.calls.delete(first); this.gap({ id: `pending:${sourceKey(source)}`, kind: "pending_call_budget", source }); }
  }
  private output(callId: string, raw: unknown, source: CaptureSource, failed = false) {
    const call = this.calls.get(callId);
    if (!call) return;
    this.calls.delete(callId);
    let value = raw;
    if (typeof value === "string" && (value.length > captureLimits.line || Buffer.byteLength(value) > captureLimits.line)) { this.gap({ id: `large-result:${sourceKey(source)}`, kind: "large_tool_result_omitted", source }); value = undefined; }
    if (typeof value === "string") { try { value = JSON.parse(value); } catch { /* Native exec also uses a short textual status header. */ } }
    let data = object(value);
    failed ||= data.isError === true || data.is_error === true || !!data.error;
    if (data.structuredContent) data = object(data.structuredContent);
    else if (Array.isArray(data.content)) {
      const pieces: string[] = []; let length = 0;
      for (const block of data.content.slice(0, 32)) { const text = string(object(block).text); length += text.length; if (length > captureLimits.line) break; pieces.push(text); }
      if (length > captureLimits.line || data.content.length > 32) { this.gap({ id: `large-result:${sourceKey(source)}`, kind: "large_tool_result_omitted", source }); data = {}; value = undefined; }
      else { const text = pieces.join("\n"); try { data = object(JSON.parse(text)); } catch { value = text; } }
    }
    failed ||= data.isError === true || data.is_error === true || !!data.error;
    if (failed) { this.gap({ id: `failed-result:${sourceKey(source)}`, kind: "background_tool_failed", source }); this.result.background.push({ id: `background:${this.agentId}:${callId}`, source, kind: call.kind, callId, ...(call.handle ? { handle: call.handle } : {}), status: "unknown", at: call.at }); return; }
    const specific = object(data[call.kind === "async_shell" ? "task" : call.kind]);
    const handle = id(data.session_id ?? data.task_id ?? data.taskId ?? data.agentId ?? data.agent_id ?? data.tabId ?? data.tab_id ?? data.terminalId ?? data.terminal_id ?? data.runId ?? data.scheduleId ?? data.heartbeatId ?? specific.id ?? data.id) ?? call.handle;
    const header = typeof value === "string" ? /^Process running with session ID ([\w.-]+)/m.exec(value)?.[1] : undefined;
    const ref = handle ?? header;
    const finishedExec = call.kind === "exec" && (number(data.exit_code) !== undefined || (typeof value === "string" && /^Process exited with code \d+/m.test(value)));
    const closed = finishedExec || call.action === "close" && (data.ok === true || data.success === true || data.cancelled === true || data.canceled === true || data.deleted === true || ["closed", "cancelled", "canceled", "deleted"].includes(string(data.status)));
    if (finishedExec && !ref) {
      if (call.detached) { this.gap({ id: `detached:${sourceKey(source)}`, kind: "detached_background_untracked", source }); this.result.background.push({ id: `background:${this.agentId}:${callId}`, source, kind: call.kind, callId, status: "unknown", at: call.at, ...(call.label ? { label: call.label } : {}) }); }
      return;
    }
    if (!ref || call.action === "close" && !closed) { this.gap({ id: `handle:${sourceKey(source)}`, kind: "background_handle_unknown", source }); this.result.background.push({ id: `background:${this.agentId}:${callId}`, source, kind: call.kind, callId, status: "unknown", at: call.at, ...(call.label ? { label: call.label } : {}) }); return; }
    this.result.background.push({ id: `background:${this.agentId}:${call.kind}:${ref}`, source, kind: call.kind, handle: ref, callId, status: closed ? "closed" : "open", at: call.at, ...(call.label ? { label: call.label } : {}), ...(finishedExec ? { outcome: number(data.exit_code) !== undefined ? `exit ${data.exit_code}` : "completed" } : {}) });
  }
  providerLine(provider: "codex" | "claude", raw: Buffer, source: CaptureSource): string {
    if (!raw.toString("utf8").trim()) return "empty";
    let entry: RecordValue;
    try { entry = object(JSON.parse(raw.toString("utf8"))); } catch { this.gap({ id: `parse:${sourceKey(source)}`, kind: "parse_failed", source, bytes: raw.length }); this.firstUsageAvailable = false; return "invalid_json"; }
    const type = redactCaptureText(string(entry.type)).slice(0, 80), payload = object(entry.payload), timestamp = entry.timestamp;
    if (provider === "claude" && entry.isSidechain === true) return "claude/sidechain";
    if (this.identityMismatch) return "wrong_session";
    if (entry.sessionId && entry.sessionId !== source.sessionId || type === "session_meta" && payload.id && payload.id !== source.sessionId) { this.identityMismatch = true; this.gap({ id: `identity:${sourceKey(source)}`, kind: "session_identity_mismatch", source }); return "wrong_session"; }
    if (provider === "claude") {
      if (entry.isSidechain === true) return "claude/sidechain";
      const message = object(entry.message), content = message.content;
      if (Array.isArray(content) && content.some((block) => object(block).type === "image")) this.gap({ id: `image:${sourceKey(source)}`, kind: "image_not_captured", source });
      source = { ...source, ...(id(entry.uuid) ? { messageId: id(entry.uuid) } : {}) };
      if (type === "user" && !entry.isMeta && !entry.isCompactSummary) {
        if (Array.isArray(content)) for (const item of content) { const block = object(item); if (block.type === "tool_result") this.output(string(block.tool_use_id), block.content, source, block.is_error === true); }
        if (!Array.isArray(content) || !content.some((block) => object(block).type === "tool_result")) {
          const text = contentText(content);
          if (/^\s*<(?:task-notification|system-reminder|command-|local-command)/.test(text)) this.gap({ id: `synthetic:${sourceKey(source)}`, kind: "provider_system_notification", source });
          else this.message(text, source, timestamp);
        }
      } else if (type === "assistant") {
        this.message(contentText(content), source, timestamp, true);
        if (Array.isArray(content)) for (const item of content) { const block = object(item); if (block.type === "tool_use") this.call(string(block.name), string(block.id), block.input, source, timestamp); }
        const usage = object(message.usage), values = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens, usage.output_tokens].map(number);
        if (values.some((n) => n !== undefined)) {
          const contextTokens = values.reduce<number>((sum, n) => sum + (n ?? 0), 0), cache = object(usage.cache_creation);
          const ttl = (number(cache.ephemeral_1h_input_tokens) ?? 0) > 0 ? 3300 : (number(cache.ephemeral_5m_input_tokens) ?? 0) > 0 ? 240 : undefined;
          this.result.usage.push({ id: `usage:${sourceKey(source)}`, source, at: this.time(timestamp).at, contextTokens, ...(this.firstUsageAvailable && !this.sawUsage ? { initialContextTokens: contextTokens } : {}), ...(ttl ? { cacheTtlSeconds: ttl } : {}), ...(id(message.id) ? { messageId: id(message.id) } : {}) }); this.sawUsage = true;
        }
      } else if (type === "system" && entry.subtype === "compact_boundary") this.result.compactions.push({ id: `compact:${sourceKey(source)}`, source, at: this.time(timestamp).at, ...(number(object(entry.compactMetadata).preTokens) !== undefined ? { preTokens: number(object(entry.compactMetadata).preTokens) } : {}) });
      else if (type === "system" && !["turn_duration", "api_error", "local_command", "stop_hook_summary"].includes(string(entry.subtype))) this.gap({ id: `system:${sourceKey(source)}`, kind: "unknown_system_type", source, typeHint: redactCaptureText(string(entry.subtype)).slice(0, 80) || "unknown" });
      else if (!["progress", "file-history-snapshot", "queue-operation", "summary", "custom-title", "ai-title", "last-prompt", "system"].includes(type)) this.gap({ id: `type:${sourceKey(source)}`, kind: "unknown_record_type", source, typeHint: type.slice(0, 80) || "unknown" });
      return `claude/${type.slice(0, 80) || "unknown"}`;
    }
    if (type === "token_usage_record" && tokenUsageMetadata(entry, source.sessionId)) return "token_usage_record";
    if (type === "event_msg") {
      const event = redactCaptureText(string(payload.type)).slice(0, 80);
      source = { ...source, ...(id(payload.message_id ?? payload.messageId ?? payload.client_message_id) ? { messageId: id(payload.message_id ?? payload.messageId ?? payload.client_message_id) } : {}) };
      if (Array.isArray(payload.images) && payload.images.length || Array.isArray(payload.local_images) && payload.local_images.length) this.gap({ id: `image:${sourceKey(source)}`, kind: "image_not_captured", source });
      if (event === "user_message" || event === "agent_message") this.message(string(payload.message ?? payload.text), source, timestamp, event === "agent_message");
      else if (event === "token_count") {
        const info = object(payload.info), contextTokens = number(object(info.last_token_usage).total_tokens), windowTokens = number(info.model_context_window ?? payload.model_context_window);
        if (contextTokens !== undefined) { this.result.usage.push({ id: `usage:${sourceKey(source)}`, source, at: this.time(timestamp).at, contextTokens, ...(windowTokens ? { windowTokens } : {}), ...(this.firstUsageAvailable && !this.sawUsage ? { initialContextTokens: contextTokens } : {}) }); this.sawUsage = true; }
      } else if (!["task_started", "task_complete", "turn_aborted", "agent_reasoning", "agent_reasoning_raw_content", "item_started", "item_completed", "warning", "error", "context_compacted"].includes(event)) this.gap({ id: `event:${sourceKey(source)}`, kind: "unknown_event_type", source, typeHint: event.slice(0, 80) || "unknown" });
      return `event_msg/${event.slice(0, 80) || "unknown"}`;
    }
    if (type === "response_item") {
      if (["function_call", "custom_tool_call"].includes(string(payload.type))) this.call(string(payload.name), string(payload.call_id), payload.arguments ?? payload.input, source, timestamp);
      else if (["function_call_output", "custom_tool_call_output"].includes(string(payload.type))) this.output(string(payload.call_id), payload.output, source, payload.is_error === true);
      else if (!["message", "reasoning", "web_search_call", "local_shell_call", "compaction"].includes(string(payload.type))) this.gap({ id: `response:${sourceKey(source)}`, kind: "unknown_response_type", source, typeHint: redactCaptureText(string(payload.type)).slice(0, 80) || "unknown" });
      // Native user/assistant text is represented by event_msg too; never capture that alias twice.
      return `response_item/${redactCaptureText(string(payload.type)).slice(0, 80) || "unknown"}`;
    }
    if (type === "compacted") { if (payload.latest_token_usage_record || entry.latest_token_usage_record) this.result.compactions.push({ id: `compact:${sourceKey(source)}`, source, at: this.time(timestamp).at }); }
    else if (!["session_meta", "turn_context"].includes(type)) this.gap({ id: `type:${sourceKey(source)}`, kind: "unknown_record_type", source, typeHint: type.slice(0, 80) || "unknown" });
    return type.slice(0, 80) || "unknown";
  }
  timeline(items: readonly unknown[], received: boolean) {
    const counts = new Map<string, number>();
    for (const raw of items) {
      const item = object(raw), type = string(item.type), messageId = id(item.messageId ?? item.clientMessageId);
      const value = string(item.text), fingerprint = digest(`${type}\0${value}\0${string(item.callId)}\0${string(item.name)}`), occurrence = (counts.get(fingerprint) ?? 0) + 1;
      counts.set(fingerprint, occurrence);
      const source: CaptureSource = { agentId: this.agentId, provider: "timeline", fileId: `${fingerprint}:${occurrence}`, ...(messageId ? { messageId } : {}) };
      if (type === "user_message" || type === "assistant_message" || type === "agent_message") this.message(value, source, item.at ?? item.timestamp, type !== "user_message", received);
      else if (type === "tool_call") {
        const callId = id(item.callId) ?? `timeline:${fingerprint}:${occurrence}`, detail = object(item.detail);
        this.call(string(item.name), callId, detail.input ?? item.input, source, item.at ?? item.timestamp);
        if (["completed", "failed", "canceled"].includes(string(item.status))) this.output(callId, detail.output ?? item.output ?? item.metadata, source, item.status !== "completed");
      } else if (type === "compaction" && item.status === "completed") this.result.compactions.push({ id: `compact:${sourceKey(source)}`, source, at: this.time(item.at ?? item.timestamp).at, ...(number(item.preTokens) !== undefined ? { preTokens: number(item.preTokens) } : {}) });
      else if (!["reasoning", "plan", "plan_update", "error", "notice", "turn_started", "turn_completed"].includes(type)) this.gap({ id: `timeline:${sourceKey(source)}`, kind: "unknown_timeline_type", source, typeHint: type.slice(0, 80) || "unknown" });
    }
  }
  finish() {
    for (const call of this.calls.values()) {
      this.gap({ id: `pending-background:${this.agentId}:${call.callId}`, kind: "background_handle_pending", source: call.source });
      if (!this.result.background.some((item) => item.callId === call.callId)) this.result.background.push({ id: `background:${this.agentId}:${call.callId}`, source: call.source, kind: call.kind, callId: call.callId, status: "unknown", at: call.at, ...(call.label ? { label: call.label } : {}) });
    }
    for (const list of [this.result.inputs, this.result.live, this.result.background, this.result.usage, this.result.compactions]) for (const item of list) item.id = stableId(item.id);
  }
}
