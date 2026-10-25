import { createHash } from "node:crypto";
import { handoffMessageSource, handoffSource } from "./handoff-source";
import { nextRowKind, summaryRowKind } from "../shared/native-session";
import { detachedCommand } from "./handoff-detached";
import { locatedGapKinds, type CaptureBackground, type CaptureGap, type CaptureSemantics, type CaptureSource } from "./handoff-capture";

export const captureLimits = { bytes: 64 * 2 ** 20, line: 256 * 2 ** 10, chunk: 64 * 2 ** 10, records: 5000, gaps: 100, calls: 64, live: 8, liveChars: 4000, messageChars: 800, hints: 8, notices: 20, closed: 64 } as const;

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
const knownTool = (name: string) => [...toolNames].find(([known]) => name === known || name.endsWith(`__${known}`) || name.endsWith(`.${known}`))?.[1];
/** Codex code-mode scripts (`exec`), Claude Code `Workflow` and the paseo-dynamic-workflow MCP `workflow`: their inner calls are not itemized, only evident background work. */
const scriptTool = (name: string): "script" | "workflow" | undefined => {
  const last = name.split(".").pop() ?? "";
  return last === "exec" ? "script" : last === "Workflow" || /(?:^|__|\.)workflow$/.test(name) ? "workflow" : undefined;
};
/** Nested tools a script can call that leave something running; the Codex exec tool is handled through its completion items. */
const nestedStart = (base: string): CaptureBackground["kind"] | undefined => {
  if (base === "workflow") return "agent";
  const tool = toolNames.get(base);
  return tool?.action === "start" && base !== "Bash" && base !== "exec_command" ? tool.kind : undefined;
};
const toolBase = (name: string) => name.split(/__|\./).pop() ?? name;
const nestedCalls = /\btools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'`])([^"'`\n]{1,200})\2\s*\])\s*\(/g;
const commandLiterals = /\b(?:cmd|command)["']?\s*:\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
const unescapeLiteral = (text: string) => text.replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[c] ?? c);
const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
/** Printed tool results: a unified exec session that is still running reports `session_id` and no `exit_code`. */
function runningSessions(blocks: readonly string[]): string[] {
  const found = new Set<string>(); let nodes = 0;
  const walk = (value: unknown, depth: number) => {
    if (depth > 6 || ++nodes > 2000 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    const record = value as RecordValue, session = id(record.session_id);
    if (session && (record.exit_code === undefined || record.exit_code === null)) found.add(session);
    for (const child of Object.values(record)) walk(child, depth + 1);
  };
  for (const block of blocks) {
    const trimmed = block.trim(), parsed = parseJson(trimmed);
    if (parsed !== undefined) { walk(parsed, 0); continue; }
    for (const line of trimmed.split("\n")) if (/^[[{]/.test(line.trim())) walk(parseJson(line.trim()), 0);
    for (const match of trimmed.matchAll(/\bProcess running with session ID ([\w.-]+)/g)) { const session = id(match[1]); if (session) found.add(session); }
  }
  return [...found];
}
/** Text the tool returned, as separate blocks (Codex code mode: a status header block, then each printed value). */
function outputBlocks(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  const blocks = (list: unknown[]) => list.slice(0, 64).flatMap((item) => typeof item === "string" ? [item] : typeof object(item).text === "string" ? [object(item).text as string] : []);
  if (Array.isArray(raw)) return blocks(raw);
  const value = object(raw);
  if (Array.isArray(value.content)) return blocks(value.content);
  if (typeof value.output === "string") return [value.output];
  return raw === undefined || raw === null ? [] : [JSON.stringify(raw)];
}
/** A background handle announced in plain text: Claude's backgrounded Bash and Workflow, the dynamic-workflow MCP tool. */
const announcedHandle = (text: string) => id(/\b(?:running in background with ID|Task ID|Run ID):\s*([\w-]+(?:\.[\w-]+)*)/i.exec(text)?.[1]);
/**
 * Background started by a CLI from a shell, seen only in the command's output: `paseo-workflow run` prints its run id,
 * `paseo-shell register` prints the registered task as JSON. The command must be that CLI: quoting a launch is not one.
 */
function cliLaunch(command: string, output: string): { kind: "agent" | "async_shell"; handle: string; label: string } | undefined {
  const text = output.length > captureLimits.chunk ? output.slice(0, captureLimits.chunk) : output, label = redactCaptureText(command).slice(0, 100);
  if (/\bpaseo-workflow\b[^\n]*\brun\b/.test(command) && /(?:^|\n)Workflow launched in background\./.test(text)) {
    const handle = announcedHandle(text);
    return handle ? { kind: "agent", handle, label: `Workflow: ${label}` } : undefined;
  }
  if (/\bpaseo-shell\b[^\n]*\bregister\b/.test(command)) {
    const data = object(parseJson(text.trim())), task = object(data.task);
    const handle = id(task.taskId ?? data.task_id ?? data.taskId) ?? id(/"(?:taskId|task_id)"\s*:\s*"([\w.-]{1,200})"/.exec(text)?.[1]);
    return handle ? { kind: "async_shell", handle, label: `async shell: ${label}` } : undefined;
  }
}
const pluginMetadata = new Set([summaryRowKind, nextRowKind, "activity-list", "guard-decision", "learning-update", "dynamic-workflow-run"]);
const asyncShellRunning = new Set(["pending", "running"]);
/** `known`: exec session ids the script text names (write_stdin to an earlier session): their completions are not this script's starts. */
type ScriptEvidence = { workflow?: boolean; timeline?: boolean; starts: string[]; execCalls: number; seen: Record<string, number>; detached?: string; known?: string[] };
export type PendingCaptureCall = { callId: string; kind: CaptureBackground["kind"]; action: "start" | "close" | "poll"; source: CaptureSource; at: string; handle?: string; label?: string; detached?: boolean; script?: ScriptEvidence; wait?: { terminate?: boolean } };

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
  readonly result: CaptureSemantics = { inputs: [], live: [], background: [], usage: [], compactions: [], gaps: [], notices: [], omittedGaps: 0, narrationOmitted: 0, narrationTrimmedChars: 0, scriptCalls: 0 };
  private calls = new Map<string, PendingCaptureCall>();
  private sent: Set<string>;
  /** Calls whose result this batch already handled: Codex repeats a top-level call as an item_completed with the same id. */
  private done = new Set<string>();
  /** Unified exec sessions proven finished (CommandExecution process_id); a later printed copy of the start result cannot reopen them. */
  private closed: string[] = [];
  /** Unified exec sessions known to be running (printed by a script, or a top-level exec_command still running): their completions close them, never count toward a later script. */
  private sessions: string[] = [];
  /** Aggregation per kind and type hint: a flood of one unknown record type is one gap with a count. */
  private groups = new Map<string, CaptureGap>();
  private origin: "provider" | "timeline" = "provider";
  private lineAt?: string;
  /** Identity of the timeline row being read (plugin row id, message id, call id, or fingerprint and occurrence). */
  private row?: string;
  sawUsage = false;
  firstUsageAvailable = true;
  identityMismatch = false;
  constructor(private agentId: string, private capturedAt: string, sentMessageIds: readonly string[] = [], private automationTextHashes: readonly string[] = []) { this.sent = new Set(sentMessageIds); }
  restore(calls: PendingCaptureCall[], sawUsage: boolean, firstUsageAvailable: boolean, closed: readonly string[] = [], sessions: readonly string[] = []) { this.calls = new Map(calls.slice(-captureLimits.calls).map((call) => [call.callId, call])); this.sawUsage = sawUsage; this.firstUsageAvailable = firstUsageAvailable; this.closed = closed.slice(-captureLimits.closed); this.sessions = sessions.slice(-captureLimits.closed); }
  pending() { return [...this.calls.values()]; }
  closedSessions() { return [...this.closed]; }
  runningSessions() { return [...this.sessions]; }
  private running(session: string) { if (!this.closed.includes(session)) this.sessions = [...this.sessions.filter((value) => value !== session), session].slice(-captureLimits.closed); }
  gap(value: CaptureGap) {
    if (["parse_failed", "unknown_record_type", "unknown_event_type", "unknown_response_type", "session_identity_mismatch"].includes(value.kind)) this.firstUsageAvailable = false;
    const at = value.at ?? this.lineAt ?? this.capturedAt;
    if (this.row && !value.occurrences) value = { ...value, occurrences: [this.row] };
    let key = locatedGapKinds.has(value.kind) ? `${value.kind}\0${value.id}` : `${value.kind}\0${value.typeHint ?? ""}`;
    if (!this.groups.has(key) && value.typeHint !== undefined && [...this.groups.values()].filter((gap) => gap.kind === value.kind && gap.typeHint !== undefined).length >= captureLimits.hints) { key = `${value.kind}\0*`; value = { ...value, typeHint: "*" }; }
    const group = this.groups.get(key);
    if (group) {
      group.count = (group.count ?? 1) + (value.count ?? 1);
      if (at < (group.at ?? at)) group.at = at;
      if (at > (group.lastAt ?? group.at ?? at)) group.lastAt = at;
      if (value.bytes !== undefined) group.bytes = (group.bytes ?? 0) + value.bytes;
      if (value.to !== undefined) group.to = Math.max(group.to ?? value.to, value.to);
      if (value.occurrences) group.occurrences = [...(group.occurrences ?? []), ...value.occurrences].slice(-512);
      return;
    }
    const gap: CaptureGap = { ...value, id: stableId(value.id), at, lastAt: at, count: value.count ?? 1 };
    if (this.result.gaps.length < captureLimits.gaps) { this.result.gaps.push(gap); this.groups.set(key, gap); } else this.result.omittedGaps++;
  }
  private notice(key: string, text: string, timestamp: unknown) {
    if (this.result.notices.some((notice) => notice.id === key)) return;
    if (this.result.notices.length >= captureLimits.notices) { this.gap({ id: `notices:${this.agentId}`, kind: "notice_budget" }); return; }
    this.result.notices.push({ id: key, text: redactCaptureText(text).slice(0, 600), at: this.time(timestamp).at });
  }
  private time(value: unknown) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? { at: value, atSource: "provider" as const } : { at: this.capturedAt, atSource: "captured" as const }; }
  /** A completion notice only closes an item already captured; it never invents one. */
  private closeHandle(handle: string, source: CaptureSource, timestamp: unknown, outcome?: string, kind: CaptureBackground["kind"] = "agent", extra: Pick<CaptureBackground, "late" | "note"> = {}) {
    this.result.background.push({ id: `close:${this.agentId}:${handle}`, source, kind, handle, status: "closed", at: this.time(timestamp).at, closeOnly: true, ...(outcome ? { outcome: outcome.slice(0, 40) } : {}), ...extra });
  }
  /**
   * Claude task notifications and paseo-dynamic-workflow run notices: close the item with its status, and keep what the
   * notice said (status, summary, output file, the start of result/error/failures/recovery/interrupted agents) as a
   * bounded, redacted note. The note is always written for a failure or a result, and otherwise only when no recorded
   * launch matches (the observer decides). A text without a task id and a status is not a notice (returns false).
   */
  private taskNotice(text: string, source: CaptureSource, timestamp: unknown): boolean {
    const block = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
    const task = id(block("task-id")), status = /^[\w-]{1,40}$/.exec(block("status") ?? "")?.[0];
    if (!task || !status) return false;
    const line = (value: string | undefined, max: number) => value ? redactCaptureText(value.replace(/\s+/g, " ")).slice(0, max) : "";
    const parts = [`Background task ${task} ended with status ${status}${block("summary") ? `: ${line(block("summary"), 300)}` : ""}.`];
    if (block("output-file")) parts.push(`Output file: ${line(block("output-file"), 300)}.`);
    const details = ([["result", "Result", 700], ["error", "Error", 500], ["failures", "Failures", 500], ["recovery", "Recovery", 300], ["interrupted-agents", "Interrupted agents", 600]] as const).filter(([name]) => block(name));
    let cut = false;
    for (const [name, label, max] of details) {
      // The dynamic-workflow plugin lists cut-off agents after its instructions: their ids come first, they hold the partial work to re-read.
      const raw = block(name)!, agents = name === "interrupted-agents" ? raw.split("\n").filter((row) => /:\s*(?:agent\s+\S+|not started)\s*$/.test(row)) : [];
      const value = redactCaptureText((agents.length ? agents.join("; ") : raw).replace(/\s+/g, " "));
      cut ||= value.length > max || agents.length > 0; parts.push(`${label}: ${value.slice(0, max)}${value.length > max ? "…" : ""}`);
    }
    if (cut) parts.push("(Excerpt; the whole notice is in that session's raw history.)");
    const kind = status === "completed" ? "background" as const : "hazard" as const;
    // Not `late`: a notice cannot tell a workflow from a background command, so an unmatched one never settles a placeholder; its note keeps it.
    this.closeHandle(task, source, timestamp, status, "agent", { note: { id: `task-notice:${task}:${status}`, text: parts.join(" ").slice(0, 2000), kind, always: status !== "completed" || details.length > 0 } });
    return true;
  }
  private message(text: string, source: CaptureSource, timestamp: unknown, assistant = false, received = false, unlinked?: string) {
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
      if (notice) this.result.background.push({ id: `async-notice:${sourceKey(source)}`, source, kind: "async_shell", handle: notice[2], status: "closed", outcome: notice[1], at: this.time(timestamp).at, late: true });
      else this.gap({ id: `async-notice:${sourceKey(source)}`, kind: "unknown_background_notice", source });
      return;
    }
    // Background completions addressed to the agent (Claude task notifications, paseo-dynamic-workflow): close their item, never a person's words.
    // The same plugin marker also relays the user's settings (Ultracode, workflows off): those are words for the agent, kept verbatim.
    let relay: string | undefined;
    if (!assistant && (/^\s*<task-notification>/.test(text) || text.trimStart().startsWith("[paseo-dynamic-workflow]"))) {
      if (this.taskNotice(text, source, timestamp)) return;
      relay = text.trimStart().startsWith("[paseo-dynamic-workflow]") ? "paseo-dynamic-workflow" : "background task notification";
    }
    const messageId = source.messageId;
    const fromFlowly = !assistant && !wrapped && !messageId && this.automationTextHashes.includes(createHash("sha256").update(text).digest("hex"));
    if (!assistant && messageId && this.sent.has(messageId)) return;
    if (unlinked && fromFlowly) return;
    const key = messageId ? handoffMessageSource(this.agentId, messageId) : unlinked ? handoffSource(`provider-user:${this.agentId}:${unlinked}`) : handoffSource(`message:${sourceKey(source)}`);
    const safe = redactCaptureText(text), time = this.time(timestamp);
    if (assistant) {
      const excerpt = safe.slice(0, captureLimits.messageChars);
      this.result.narrationTrimmedChars += safe.length - excerpt.length;
      this.result.live.push({ id: key, source, text: excerpt, ...time, ...(safe.length > excerpt.length ? { truncated: true } : {}), ...(messageId ? { messageId } : {}) });
      while (this.result.live.length > captureLimits.live || this.result.live.reduce((n, item) => n + item.text.length, 0) > captureLimits.liveChars) { this.result.live.shift(); this.result.narrationOmitted++; }
    } else this.result.inputs.push({ id: key, source, text: safe, ...time, ...(safe !== text ? { redacted: true } : {}), ...(messageId ? { messageId } : {}), via: fromFlowly || relay || wrapped && wrapped.kind !== "user-message" ? "agent" : "session", ...(fromFlowly ? { senderTitle: "Flowly automation" } : relay ? { senderTitle: relay } : {}), ...(wrapped?.senderId ? { senderId: wrapped.senderId } : {}), ...(wrapped?.title ? { senderTitle: redactCaptureText(wrapped.title).slice(0, 200) } : {}), status: received || fromFlowly ? "received" : "open", ...(unlinked && !messageId ? { unlinked: true as const } : {}) });
  }
  private arguments(input: unknown, source: CaptureSource): RecordValue | undefined {
    if (typeof input !== "string") return object(input);
    try { if (input.length > captureLimits.line || Buffer.byteLength(input) > captureLimits.line) throw new Error("Large arguments"); return object(JSON.parse(input)); }
    catch { this.gap({ id: `call:${sourceKey(source)}`, kind: "unparsed_tool_arguments", source }); return undefined; }
  }
  private register(call: PendingCaptureCall, source: CaptureSource) {
    this.calls.set(call.callId, call);
    if (this.calls.size > captureLimits.calls) { const first = this.calls.keys().next().value!; this.calls.delete(first); this.gap({ id: `pending:${sourceKey(source)}`, kind: "pending_call_budget", source }); }
  }
  private call(name: string, callId: string, input: unknown, source: CaptureSource, timestamp: unknown) {
    if (this.done.has(callId)) return;
    const script = scriptTool(name);
    if (script) { this.script(script, callId, input, source, timestamp); return; }
    if (name.split(".").pop() === "wait") {
      // Codex code mode resumes a yielded script cell with a top-level wait {cell_id}.
      const data = this.arguments(input, source), cell = id(data?.cell_id);
      if (cell && id(callId)) this.register({ callId, kind: "exec", action: "close", source, at: this.time(timestamp).at, handle: `cell:${cell}`, wait: data?.terminate === true ? { terminate: true } : {} }, source);
      return;
    }
    const tool = knownTool(name);
    if (!tool) return;
    if (!id(callId)) { this.gap({ id: `call:${sourceKey(source)}`, kind: "tool_call_identity_unknown", source }); return; }
    const data = this.arguments(input, source) ?? {};
    const detached = data.run_in_background === true || detachedCommand(string(data.cmd ?? data.command));
    if (name === "Bash" && !detached) return;
    const handle = id(data.session_id ?? data.task_id ?? data.taskId ?? data.agentId ?? data.agent_id ?? data.tabId ?? data.tab_id ?? data.terminalId ?? data.scheduleId ?? data.heartbeatId ?? data.id);
    const label = redactCaptureText(string(data.cmd ?? data.command ?? data.title ?? data.name)).slice(0, 120);
    this.register({ callId, ...tool, source, at: this.time(timestamp).at, ...(handle ? { handle } : {}), ...(label ? { label } : {}), ...(detached ? { detached: true } : {}) }, source);
  }
  /** Scripts and workflows are counted, not itemized: only background work they evidently leave running becomes an item (see SESSION-HANDOFF-SPEC §5.7). */
  private script(type: "script" | "workflow", callId: string, input: unknown, source: CaptureSource, timestamp: unknown) {
    this.result.scriptCalls++;
    if (!id(callId)) return;
    const at = this.time(timestamp).at;
    if (type === "workflow") {
      const data = typeof input === "string" ? object(parseJson(input)) : object(input);
      const name = redactCaptureText(string(data.name) || string(data.workflowName) || string(data.scriptPath).split("/").pop()?.replace(/\.[^.]+$/, "") || "").slice(0, 80);
      this.register({ callId, kind: "agent", action: "start", source, at, label: `Workflow${name ? ` ${name}` : ""}`, script: { workflow: true, starts: [], execCalls: 0, seen: {} } }, source);
      return;
    }
    const raw = typeof input === "string" ? input : string(object(input).code ?? object(input).script ?? object(input).input) || JSON.stringify(input ?? "");
    const text = raw.length > captureLimits.line ? raw.slice(0, captureLimits.line) : raw;
    const bases = [...text.matchAll(nestedCalls)].map((match) => toolBase(match[1] ?? match[3]));
    const starts = [...new Set(bases.filter((base) => nestedStart(base)))].slice(0, 16);
    const command = [...text.matchAll(commandLiterals)].map((match) => unescapeLiteral(match[1] ?? match[2] ?? match[3])).find(detachedCommand) ?? (/\brun_in_background["']?\s*:\s*true\b/.test(text) ? "run_in_background" : undefined);
    const known = [...new Set([...text.matchAll(/\bsession_id["']?\s*:\s*["']?(\d{1,12})\b/g)].map((match) => match[1]))].slice(0, 16);
    this.register({ callId, kind: "exec", action: "start", source, at, label: "script running", script: { ...(this.origin === "timeline" ? { timeline: true } : {}), starts, execCalls: bases.filter((base) => base === "exec_command").length, seen: {}, ...(command ? { detached: redactCaptureText(command).slice(0, 100) } : {}), ...(known.length ? { known } : {}) } }, source);
  }
  /**
   * Nested completion items count toward the newest unfinished script; they show that a started call ended within it.
   * A completion of an exec session known before (running or finished, or named in the script text) is not that script's
   * start: counting it would hide an exec_command the script left running (restart a dev server, poll a build then start one).
   * Returns whether the completion was credited to a running script.
   */
  private attribute(base: string, session?: string) {
    const script = [...this.calls.values()].reverse().find((call) => call.script && !call.script.workflow)?.script;
    if (!script || !(base === "exec_command" || base === "detached" || script.starts.includes(base))) return false;
    if (base === "exec_command" && session && (this.sessions.includes(session) || this.closed.includes(session) || script.known?.includes(session))) return false;
    script.seen[base] = (script.seen[base] ?? 0) + 1; return true;
  }
  private push(item: Omit<CaptureBackground, "source" | "at">, source: CaptureSource, at: string) { this.result.background.push({ ...item, source, at }); }
  private scriptOutput(call: PendingCaptureCall, raw: unknown, source: CaptureSource, failed: boolean) {
    const script = call.script!, blocks = outputBlocks(raw), text = blocks.join("\n");
    // The in-flight placeholder (finish) closes unless evidence below keeps the work open.
    this.push({ id: `background:${this.agentId}:${call.callId}`, kind: call.kind, callId: call.callId, status: "closed", closeOnly: true }, source, call.at);
    if (Buffer.byteLength(text) > captureLimits.line) { this.gap({ id: `large-result:${sourceKey(source)}`, kind: "large_tool_result_omitted", source }); return; }
    if (script.workflow) {
      if (failed || !(/launched in background/i.test(text) || /"status"\s*:\s*"async_launched"/.test(text))) return; // A rejected workflow started nothing.
      const handle = announcedHandle(text) ?? id(object(parseJson(text)).taskId ?? object(parseJson(text)).runId);
      if (!handle) this.gap({ id: `handle:${sourceKey(source)}`, kind: "background_handle_unknown", source });
      this.push({ id: handle ? `background:${this.agentId}:agent:${handle}` : `background:${this.agentId}:${call.callId}:workflow`, kind: "agent", callId: call.callId, ...(handle ? { handle, status: "open" } : { status: "unknown" }), label: call.label }, source, call.at);
      return;
    }
    const header = /^Script (completed|failed|running with cell ID ([\w.-]+))/.exec(blocks[0] ?? "");
    if (header?.[2]) { const handle = `cell:${header[2]}`; this.push({ id: `background:${this.agentId}:exec:${handle}`, kind: "exec", handle, status: "open", label: `script cell ${header[2]} still running` }, source, call.at); return; }
    const running = runningSessions(blocks.slice(blocks.length > 1 ? 1 : 0)).filter((session) => !this.closed.includes(session));
    for (const handle of running) { this.running(handle); this.push({ id: `background:${this.agentId}:exec:${handle}`, kind: "exec", handle, status: "open", label: "exec session started by a script" }, source, call.at); }
    if (script.detached && !script.seen.detached) this.push({ id: `background:${this.agentId}:${call.callId}:detached`, kind: "exec", callId: `${call.callId}:detached`, status: "unknown", label: `detached in script: ${script.detached}`.slice(0, 120) }, source, call.at);
    if (script.timeline) return; // Paseo's timeline shows nested calls as their own rows.
    for (const base of script.starts) if (!script.seen[base]) this.push({ id: `background:${this.agentId}:${call.callId}:${base}`, kind: nestedStart(base)!, callId: `${call.callId}:${base}`, status: "unknown", label: `${base} called in a script; result not observed` }, source, call.at);
    // One placeholder per exec_command call site still unaccounted for (at most 4): each later unattributed completion settles the oldest.
    const missing = Math.min(4, script.execCalls - (script.seen.exec_command ?? 0) - running.length);
    for (let n = 1; n <= missing; n++) this.push({ id: `background:${this.agentId}:${call.callId}:exec${n > 1 ? `:${n}` : ""}`, kind: "exec", callId: `${call.callId}:exec${n > 1 ? `:${n}` : ""}`, status: "unknown", label: "exec_command in a script; completion not observed" }, source, call.at);
  }
  private output(callId: string, raw: unknown, source: CaptureSource, failed = false) {
    const call = this.calls.get(callId);
    if (!call) return;
    this.calls.delete(callId); this.done.add(callId);
    if (call.script) { this.scriptOutput(call, raw, source, failed); return; }
    if (call.wait) {
      const ended = /^Script (completed|failed)/.exec(outputBlocks(raw)[0] ?? "")?.[1];
      // The wait itself is never background work: close any placeholder an earlier poll left for it while it was in flight.
      this.push({ id: `background:${this.agentId}:${callId}`, kind: "exec", callId, status: "closed", closeOnly: true }, source, call.at);
      if (call.wait.terminate || ended) this.closeHandle(call.handle!, source, undefined, call.wait.terminate ? "terminated" : ended, "exec");
      return;
    }
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
    const handle = id(data.session_id ?? data.task_id ?? data.taskId ?? data.agentId ?? data.agent_id ?? data.tabId ?? data.tab_id ?? data.terminalId ?? data.terminal_id ?? data.runId ?? data.scheduleId ?? data.heartbeatId ?? specific.taskId ?? specific.id ?? data.id) ?? call.handle;
    const header = typeof value === "string" ? id(/^Process running with session ID ([\w.-]+)/m.exec(value)?.[1]) ?? announcedHandle(value) : undefined;
    const ref = handle ?? header;
    const finishedExec = call.kind === "exec" && (number(data.exit_code) !== undefined || (typeof value === "string" && /^Process exited with code \d+/m.test(value)));
    if (call.kind === "exec" && ref && !finishedExec) this.running(ref);
    const closed = finishedExec || call.action === "close" && (data.ok === true || data.success === true || data.cancelled === true || data.canceled === true || data.deleted === true || ["closed", "cancelled", "canceled", "deleted"].includes(string(data.status)));
    if (finishedExec && !ref) {
      if (call.detached) { this.gap({ id: `detached:${sourceKey(source)}`, kind: "detached_background_untracked", source }); this.result.background.push({ id: `background:${this.agentId}:${callId}`, source, kind: call.kind, callId, status: "unknown", at: call.at, ...(call.label ? { label: call.label } : {}) }); }
      else this.push({ id: `background:${this.agentId}:${callId}`, kind: call.kind, callId, status: "closed", closeOnly: true }, source, call.at);
      return;
    }
    if (!ref || call.action === "close" && !closed) { this.gap({ id: `handle:${sourceKey(source)}`, kind: "background_handle_unknown", source }); this.result.background.push({ id: `background:${this.agentId}:${callId}`, source, kind: call.kind, callId, status: "unknown", at: call.at, ...(call.label ? { label: call.label } : {}) }); return; }
    this.result.background.push({ id: `background:${this.agentId}:${call.kind}:${ref}`, source, kind: call.kind, handle: ref, callId, status: closed ? "closed" : "open", at: call.at, ...(call.label ? { label: call.label } : {}), ...(finishedExec ? { outcome: number(data.exit_code) !== undefined ? `exit ${data.exit_code}` : "completed" } : {}) });
  }
  /** Codex item_completed: nested calls of a code-mode script appear only here (top-level ones repeat their call id). */
  private item(raw: unknown, source: CaptureSource, timestamp: unknown) {
    const item = object(raw), type = string(item.type), itemId = string(item.id);
    if (type === "McpToolCall") {
      const name = `${string(item.server)}.${string(item.tool)}`;
      this.attribute(toolBase(name));
      this.call(name, itemId, item.arguments, source, timestamp);
      if (this.calls.has(itemId)) this.output(itemId, item.result ?? item.error, source, !!item.error || !["completed", ""].includes(string(item.status)));
    } else if (type === "CommandExecution") {
      const command = Array.isArray(item.command) ? string(item.command.at(-1)) : string(item.command), session = id(item.process_id);
      const credited = this.attribute("exec_command", session), known = !!session && this.sessions.includes(session);
      if (session) {
        this.closed = [...this.closed.filter((value) => value !== session), session].slice(-captureLimits.closed);
        this.sessions = this.sessions.filter((value) => value !== session);
        // Not a known session and not a start of the running script: an exec_command that outlived its script ended now.
        this.push({ id: `background:${this.agentId}:exec:${session}`, kind: "exec", handle: session, status: "closed", closeOnly: true, ...(number(item.exit_code) !== undefined ? { outcome: `exit ${item.exit_code}` } : {}), ...(!credited && !known && !this.done.has(itemId) && !this.calls.has(itemId) ? { late: true } : {}) }, source, this.time(timestamp).at);
      }
      const launch = number(item.exit_code) === 0 || item.exit_code === undefined ? cliLaunch(command, string(item.aggregated_output)) : undefined;
      if (launch) this.push({ id: `background:${this.agentId}:${launch.kind}:${launch.handle}`, kind: launch.kind, handle: launch.handle, status: "open", label: launch.label }, source, this.time(timestamp).at);
      if (detachedCommand(command) && id(itemId)) this.attribute("detached");
      if (detachedCommand(command) && id(itemId)) this.push({ id: `background:${this.agentId}:${itemId}`, kind: "exec", callId: itemId, status: "unknown", label: `detached: ${redactCaptureText(command)}`.slice(0, 120) }, source, this.time(timestamp).at);
    } else if (type === "UserMessage" && id(itemId)) {
      // This Codex version writes a person's words only here (no event_msg user_message). Without Paseo's message id the
      // observer keeps them only when no other source (Flowly send, comment, turn-end timeline) already put that text on the card.
      // Codex's own wrappers (automation heartbeats, browser context, history summaries) are not words typed into the session.
      const text = contentText(item.content);
      if (!/^\s*<(?:heartbeat|in-app-browser-context|chat-history-summary)\b/.test(text)) this.message(text, source, timestamp, false, false, itemId);
    }
    // Other items (Reasoning, FileChange, ContextCompaction, AgentMessage, ...) are covered elsewhere or are metadata; see SESSION-HANDOFF-SPEC §5.7.
  }
  providerLine(provider: "codex" | "claude", raw: Buffer, source: CaptureSource): string {
    this.origin = "provider";
    try { return this.line(provider, raw, source); } finally { this.lineAt = undefined; }
  }
  private line(provider: "codex" | "claude", raw: Buffer, source: CaptureSource): string {
    if (!raw.toString("utf8").trim()) return "empty";
    let entry: RecordValue;
    try { entry = object(JSON.parse(raw.toString("utf8"))); } catch { this.gap({ id: `parse:${sourceKey(source)}`, kind: "parse_failed", source, bytes: raw.length }); this.firstUsageAvailable = false; return "invalid_json"; }
    const type = redactCaptureText(string(entry.type)).slice(0, 80), payload = object(entry.payload), timestamp = entry.timestamp;
    if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))) this.lineAt = timestamp;
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
          if (/^\s*<(?:system-reminder|command-|local-command)/.test(text)) this.gap({ id: `synthetic:${sourceKey(source)}`, kind: "provider_system_notification", source });
          else this.message(text, source, timestamp);
        }
      } else if (type === "assistant") {
        this.message(contentText(content), source, timestamp, true);
        if (Array.isArray(content)) for (const item of content) { const block = object(item); if (block.type === "tool_use") this.call(string(block.name), string(block.id), block.input, source, timestamp); }
        const usage = object(message.usage), values = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens, usage.output_tokens].map(number);
        if (values.some((n) => n !== undefined)) {
          const contextTokens = values.reduce<number>((sum, n) => sum + (n ?? 0), 0), cache = object(usage.cache_creation);
          const ttl = (number(cache.ephemeral_1h_input_tokens) ?? 0) > 0 ? 3300 : (number(cache.ephemeral_5m_input_tokens) ?? 0) > 0 ? 240 : undefined;
          this.result.usage.push({ id: `usage:${sourceKey(source)}`, source, ...this.time(timestamp), contextTokens, ...(this.firstUsageAvailable && !this.sawUsage ? { initialContextTokens: contextTokens } : {}), ...(ttl ? { cacheTtlSeconds: ttl } : {}), ...(id(message.id) ? { messageId: id(message.id) } : {}) }); this.sawUsage = true;
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
        if (contextTokens !== undefined) { this.result.usage.push({ id: `usage:${sourceKey(source)}`, source, ...this.time(timestamp), contextTokens, ...(windowTokens ? { windowTokens } : {}), ...(this.firstUsageAvailable && !this.sawUsage ? { initialContextTokens: contextTokens } : {}) }); this.sawUsage = true; }
      } else if (event === "item_completed") this.item(payload.item, source, timestamp);
      else if (event === "thread_goal_updated") {
        // A /goal objective is a person's standing instruction; repeated updates of the same objective are one input.
        const objective = string(object(payload.goal).objective).trim();
        if (objective) this.message(objective, { ...source, messageId: `goal:${digest(objective)}` }, timestamp);
      } else if (!metadataEvents.has(event)) this.gap({ id: `event:${sourceKey(source)}`, kind: "unknown_event_type", source, typeHint: event.slice(0, 80) || "unknown" });
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
    else if (!metadataRecords.has(type)) this.gap({ id: `type:${sourceKey(source)}`, kind: "unknown_record_type", source, typeHint: type.slice(0, 80) || "unknown" });
    return type.slice(0, 80) || "unknown";
  }
  /** Paseo shell rows (Codex command executions, also nested ones; Claude Bash): a row still running at turn end is evidently background work. */
  private shell(item: RecordValue, callId: string, detail: RecordValue, source: CaptureSource, timestamp: unknown) {
    const input = object(detail.input ?? item.input), command = string(detail.command ?? input.command ?? input.cmd), status = string(item.status), at = this.time(timestamp).at;
    const label = redactCaptureText(command).slice(0, 100) || "shell";
    if (status === "running") { this.push({ id: `background:${this.agentId}:${callId}`, kind: "exec", callId, status: "open", label: `running at turn end: ${label}` }, source, at); return; }
    const output = detail.output ?? item.output, outputText = typeof output === "string" ? output : outputBlocks(output).join("\n");
    const launch = status === "completed" ? cliLaunch(command, outputText) : undefined;
    if (launch) this.push({ id: `background:${this.agentId}:${launch.kind}:${launch.handle}`, kind: launch.kind, handle: launch.handle, status: "open", label: launch.label }, source, at);
    if (input.run_in_background === true || detachedCommand(command)) {
      const handle = announcedHandle(outputText);
      this.push({ id: `background:${this.agentId}:${callId}`, kind: "exec", callId, ...(handle ? { handle, status: "open" } : { status: "unknown" }), label: `detached: ${label}` }, source, at);
      return;
    }
    this.push({ id: `background:${this.agentId}:${callId}`, kind: "exec", callId, status: "closed", closeOnly: true }, source, at);
  }
  /** Plugin rows never reach the model. Known UI and summary rows are metadata; a person's goal is an input; anything else stays a (grouped) gap. */
  private plugin(item: RecordValue, source: CaptureSource, timestamp: unknown, received: boolean) {
    const kind = redactCaptureText(string(item.kind)).slice(0, 60), plugin = redactCaptureText(string(item.pluginId)).slice(0, 60), data = object(item.data);
    if (pluginMetadata.has(kind)) return;
    if (kind === "async-shell-task") {
      // paseo-async-shell appends this row once, at registration; for `paseo-shell register` it is the only structural trace.
      const handle = id(data.taskId), status = string(data.status), what = redactCaptureText(string(data.description) || string(data.commandPreview)).slice(0, 100);
      if (handle) this.push({ id: `background:${this.agentId}:async_shell:${handle}`, kind: "async_shell", handle, ...(asyncShellRunning.has(status) ? { status: "open" as const } : { status: "closed" as const, outcome: status.slice(0, 40) }), label: `async shell: ${what || handle}` }, source, this.time(timestamp).at);
      else this.gap({ id: `timeline:${sourceKey(source)}`, kind: "background_handle_unknown", source });
      return;
    }
    if (kind === "goal-status") {
      const goal = (string(data.goal) || string(object(data.goal).objective) || string(object(data.goal).text)).trim();
      if (goal) this.message(goal, { ...source, messageId: `goal:${digest(goal)}` }, timestamp, false, received);
      return;
    }
    if (kind === "provider-transfer") { const to = id(data.fallbackAgentId); this.notice(`provider-transfer:${to ?? digest(JSON.stringify(data))}`, `Paseo rate-fallback moved this session's work to agent ${to ?? "(id not recorded)"}; that session is not this card's ledger entry.`, timestamp); return; }
    this.gap({ id: `timeline:${sourceKey(source)}`, kind: "unknown_timeline_type", source, typeHint: `plugin:${plugin || "?"}/${kind || "?"}`.slice(0, 80) });
  }
  timeline(items: readonly unknown[], received: boolean) {
    this.origin = "timeline";
    const counts = new Map<string, number>();
    for (const raw of items) {
      const item = object(raw), type = string(item.type), messageId = id(item.messageId ?? item.clientMessageId);
      const value = string(item.text), fingerprint = digest(`${type}\0${value}\0${string(item.callId)}\0${string(item.name)}`), occurrence = (counts.get(fingerprint) ?? 0) + 1;
      counts.set(fingerprint, occurrence);
      // Gap occurrences are counted by row identity, so a timeline rebuilt after a restart adds its new rows (SESSION-HANDOFF-SPEC §5.7).
      this.row = type === "plugin" && id(item.id) ? `plugin:${string(item.pluginId)}:${string(item.id)}` : messageId ? `message:${messageId}` : id(item.callId) ? `call:${string(item.callId)}` : `pos:${fingerprint}:${occurrence}`;
      const source: CaptureSource = { agentId: this.agentId, provider: "timeline", fileId: `${fingerprint}:${occurrence}`, ...(messageId ? { messageId } : {}) };
      const timestamp = item.at ?? item.timestamp;
      if (type === "user_message" || type === "assistant_message" || type === "agent_message") this.message(value, source, timestamp, type !== "user_message", received);
      else if (type === "tool_call") {
        const callId = id(item.callId) ?? `timeline:${fingerprint}:${occurrence}`, detail = object(item.detail);
        if (string(detail.type) === "shell") { this.shell(item, callId, detail, source, timestamp); continue; }
        this.call(string(item.name), callId, detail.input ?? item.input, source, timestamp);
        if (["completed", "failed", "canceled"].includes(string(item.status))) this.output(callId, detail.output ?? item.output ?? item.metadata, source, item.status !== "completed");
      } else if (type === "compaction") { if (item.status === "completed") this.result.compactions.push({ id: `compact:${sourceKey(source)}`, source, at: this.time(timestamp).at, ...(this.time(timestamp).atSource === "captured" ? { captured: true } : {}), ...(number(item.preTokens) !== undefined ? { preTokens: number(item.preTokens) } : {}) }); }
      else if (type === "plugin") this.plugin(item, source, timestamp, received);
      else if (type === "notification") { const level = string(item.level); if (level === "warning" || level === "error") this.notice(`notification:${digest(`${level}\0${string(item.message)}`)}`, `Paseo ${level} notice in this session: ${string(item.message)}`, timestamp); }
      else if (!["reasoning", "plan", "plan_update", "todo", "error", "notice", "turn_started", "turn_completed"].includes(type)) this.gap({ id: `timeline:${sourceKey(source)}`, kind: "unknown_timeline_type", source, typeHint: type.slice(0, 80) || "unknown" });
    }
    this.row = undefined;
  }
  finish() {
    // A close or poll call in flight (wait, cancel) is not background work; only a start may have left something running.
    for (const call of this.calls.values()) {
      if (call.action !== "start") continue;
      this.gap({ id: `pending-background:${this.agentId}:${call.callId}`, kind: "background_handle_pending", source: call.source });
      if (!this.result.background.some((item) => item.callId === call.callId)) this.result.background.push({ id: `background:${this.agentId}:${call.callId}`, source: call.source, kind: call.kind, callId: call.callId, status: "unknown", at: call.at, ...(call.label ? { label: call.label } : {}) });
    }
    for (const list of [this.result.inputs, this.result.live, this.result.background, this.result.usage, this.result.compactions]) for (const item of list) item.id = stableId(item.id);
  }
}
const metadataRecords = new Set(["session_meta", "turn_context", "world_state", "inter_agent_communication_metadata"]);
const metadataEvents = new Set(["task_started", "task_complete", "turn_aborted", "agent_reasoning", "agent_reasoning_raw_content", "item_started", "warning", "error", "context_compacted", "thread_settings_applied"]);
