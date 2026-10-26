/**
 * Synthetic Codex rollouts and Paseo turn-end timelines with the record shapes seen on the
 * 2026-10-25 live takeover fixture (card 432b159f: predecessor, successor and reviewer on
 * codex/gpt-6-luna). Only shapes and counts are copied; every text below is invented.
 * Test-only: never imported by plugin code.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ReplicaSession = { agentId: string; uuid: string; scripts: number; shellPerScript: number[]; worldStates: number; settings: number; compaction: boolean; activityRows: number; summaryRows: number; compactionLoadingRow: boolean };
type Line = Record<string, unknown>;

/** The observed mix: 65/43/12 scripts, 5 world_state, 4 thread_settings_applied, 9 plugin rows, 1 compaction. */
export const fixtureMix: ReplicaSession[] = [
  { agentId: "predecessor-b6", uuid: "019a15e5-0000-7abc-8def-00000000b613", scripts: 65, shellPerScript: [4, 4, 1, 1, 1], worldStates: 3, settings: 4, compaction: true, activityRows: 4, summaryRows: 4, compactionLoadingRow: true },
  { agentId: "successor-e19", uuid: "019a15e5-0000-7abc-8def-00000000e19d", scripts: 43, shellPerScript: [6, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], worldStates: 1, settings: 0, compaction: false, activityRows: 0, summaryRows: 0, compactionLoadingRow: false },
  { agentId: "reviewer-cf6", uuid: "019a15e5-0000-7abc-8def-00000000cf64", scripts: 12, shellPerScript: [1, 1], worldStates: 1, settings: 0, compaction: false, activityRows: 1, summaryRows: 0, compactionLoadingRow: false },
];

const base = Date.parse("2026-10-25T01:34:58.000Z");
export function rolloutLines(session: ReplicaSession): Line[] {
  let ordinal = 0, clock = base;
  const at = () => new Date((clock += 1000)).toISOString();
  const record = (type: string, payload: Line) => ({ timestamp: at(), ordinal: ordinal++, type, payload });
  const event = (payload: Line) => record("event_msg", payload);
  const item = (value: Line) => event({ type: "item_completed", thread_id: session.uuid, turn_id: "turn-1", item: value, started_at_ms: clock, completed_at_ms: clock });
  const worldState = (full: boolean) => record("world_state", { full, state: full
    ? { agents_md: {}, apps_instructions: false, collaboration_mode: { mode: "default", model: "gpt-fixture", instructions: "0".repeat(40) }, context_window_guidance: "", environments: { environments: { local: { cwd: "/tmp/fixture", status: "ready", shell: "zsh" } }, current_date: "2026-10-25", timezone: "America/Los_Angeles", filesystem: "synthetic" }, host_skills: { body: "synthetic skill catalog", includeInstructions: true }, managed_developer_instructions: {}, model: "gpt-fixture", permissions: { instructions: "1".repeat(40), approved_command_prefixes: [] }, persistent_mode: {}, realtime: { active: false }, skills: { includeInstructions: true } }
    : { host_skills: { body: "synthetic skill catalog, larger after a skill install", includeInstructions: true } } });
  const lines: Line[] = [
    record("session_meta", { id: session.uuid, session_id: session.uuid, cwd: "/tmp/fixture", originator: "codex_cli_rs", history_mode: "paginated" }),
    worldState(true),
    event({ type: "task_started", turn_id: "turn-1", model_context_window: 258400 }),
    item({ type: "UserMessage", id: "um-1", content: [{ type: "text", text: "[Flowly automation] synthetic launch" }] }),
  ];
  let shells = 0;
  for (let n = 0; n < session.scripts; n++) {
    const callId = `call_script_${n}`, commands = session.shellPerScript[n] ?? 0;
    const source = commands
      ? `const r = await tools.exec_command({ cmd: "git status --short", yield_time_ms: 1000 });\ntext(r.output);`
      : `const card = await tools.mcp__flowly__flowly_get_task({});\ntext(card);`;
    lines.push(record("response_item", { type: "custom_tool_call", id: `ctc_${n}`, status: "completed", call_id: callId, name: "exec", input: source, internal_chat_message_metadata_passthrough: { turn_id: "turn-1", create_time: clock / 1000 } }));
    if (commands) for (let k = 0; k < commands; k++) lines.push(item({ type: "CommandExecution", id: `exec-${n}-${k}`, process_id: String(1000 + shells++), command: ["/bin/zsh", "-lc", "git status --short"], cwd: "/tmp/fixture", parsed_cmd: [], source: "unified_exec_startup", status: "completed", stdout: "", stderr: "", aggregated_output: "", exit_code: 0, duration: { secs: 0, nanos: 1 }, formatted_output: "" }));
    else lines.push(item({ type: "McpToolCall", id: `mcp-${n}`, server: "flowly", tool: "flowly_get_task", arguments: {}, readOnlyHint: true, status: "completed", result: { content: [{ type: "text", text: "{\"ok\":true}" }], structuredContent: { ok: true } }, duration: { secs: 0, nanos: 1 } }));
    lines.push(record("response_item", { type: "custom_tool_call_output", id: `ctco_${n}`, call_id: callId, output: [{ type: "input_text", text: "Script completed\nWall time 0.3 seconds\nOutput:\n" }, { type: "input_text", text: commands ? "" : "{\"ok\":true}" }] }));
    lines.push(event({ type: "token_count", info: { last_token_usage: { total_tokens: 40000 + n * 100 }, model_context_window: 258400 } }));
    if (n === 10) lines.push(item({ type: "AgentMessage", id: `am-${n}`, content: [{ type: "Text", text: "synthetic progress" }], phase: "commentary" }));
    if (n < session.settings) lines.push(event({ type: "thread_settings_applied", thread_id: session.uuid, thread_settings: { model: "gpt-fixture", model_provider_id: "openai", service_tier: "default", approval_policy: "never", collaboration_mode: { mode: "default", settings: { model: "gpt-fixture", reasoning_effort: "high", developer_instructions: "synthetic system prompt" } }, disabled_plugin_ids: [] } }));
    if (n === 30 && session.worldStates > 1) lines.push(worldState(false));
    if (n === 40 && session.compaction) {
      lines.push(record("compacted", { message: "", replacement_history: [{ type: "compaction", encrypted_content: "synthetic" }], retained_context: { verified_answers: [], incomplete: false, user_messages: [], user_messages_incomplete: false, assistant_messages: [], assistant_messages_incomplete: false, next_order: 1 }, window_number: 2, latest_token_usage_record: { thread_id: session.uuid, turn_id: "turn-1", session_id: session.uuid } }));
      lines.push(item({ type: "ContextCompaction", id: "compaction-1" }));
      if (session.worldStates > 2) lines.push(worldState(true));
    }
  }
  lines.push(event({ type: "task_complete", turn_id: "turn-1", last_agent_message: "synthetic final" }));
  return lines;
}

/** Paseo's in-memory turn-end timeline for the same session: plugin rows never reach the rollout. */
export function replicaTimeline(session: ReplicaSession): Line[] {
  return [
    { type: "user_message", text: "[Flowly automation] synthetic launch", messageId: `launch-${session.agentId}` },
    ...Array.from({ length: session.activityRows }, (_, n) => ({ type: "plugin", id: `activity-${n}`, pluginId: "compact-activity", kind: "activity-list", version: 1, data: { scope: "turn", counts: { tools: 3 }, phase: "done", startSeq: n, partial: false } })),
    ...Array.from({ length: session.summaryRows }, (_, n) => ({ type: "plugin", id: `summary-${n}`, pluginId: "flowly", kind: "flowly-summary", version: 1, data: { entryId: `summary-${n}`, state: "synthetic", target: "synthetic", recap: "synthetic", next: "synthetic" } })),
    ...(session.compactionLoadingRow ? [{ type: "compaction", status: "loading" }] : []),
    { type: "assistant_message", text: "synthetic final" },
  ];
}

/** Writes the rollout where locateProviderHistory looks for a Codex UUIDv7 session. */
export async function writeReplicaRollout(codexHome: string, session: ReplicaSession) {
  const stamp = new Date(parseInt(session.uuid.replace(/-/g, "").slice(0, 12), 16));
  const folder = join(codexHome, "sessions", String(stamp.getFullYear()), String(stamp.getMonth() + 1).padStart(2, "0"), String(stamp.getDate()).padStart(2, "0"));
  await mkdir(folder, { recursive: true });
  const path = join(folder, `rollout-replica-${session.uuid}.jsonl`);
  await writeFile(path, rolloutLines(session).map((line) => JSON.stringify(line) + "\n").join(""));
  return path;
}
