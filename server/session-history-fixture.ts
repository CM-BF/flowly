import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { forgetHistory } from "./provider-history";
import { sessionHistoryManifestSchema, type SessionHistory } from "./session-history";

/**
 * Synthesized replicas of the three Codex rollouts of the live P2 acceptance (2026-10-25): predecessor, successor and
 * reviewer of one card. The record types, sizes and placements are the ones that made the first history index miss the
 * codeword (a code-mode `exec` script whose `flowly_report_progress` note names it past the 300-character argument
 * preview; `get_task` outputs of 10–40 KB that carry it in the middle or near the end; escaped narration and scripts;
 * metadata records that dwarf the conversation). No real session content, account or path is copied. Test helper only.
 */
export const replicaCodeword = "QUILLFERN-5821";
/** Each one would survive the old redaction in at least one of the places it is planted. */
export const replicaSecrets = {
  argumentPassword: "hunter2-replica-61",
  argumentBearer: "rpl.bearer.Token.88",
  argumentEscaped: "esc-token-4471",
  outputKey: "out-key-5520",
  outputEscaped: "esc-out-pass-9917",
} as const;
export type ReplicaRole = "predecessor" | "successor" | "reviewer";

const words = ["handoff", "record", "verify", "workspace", "stage", "marker", "seed", "bytes", "review", "session", "card", "note", "state", "next", "commit", "branch", "fixture", "comment"];
/** Readable filler with no credential-shaped token in it. */
export function filler(characters: number, salt = 0) {
  let text = "", n = salt;
  while (text.length < characters) text += words[(n++ * 7) % words.length] + (n % 13 ? " " : ".\n");
  return text.slice(0, characters);
}
const json = (value: unknown) => JSON.stringify(value) + "\n";
const cwd = "/tmp/plugin-test-replica-20261025";
const seed = "c8dba68945249de9b4faed72b89e041e3df77ffff885122599e6c2f7c65a68b2";

class Rollout {
  private lines: string[] = [];
  private time: number;
  private calls = 0;
  constructor(readonly sessionId: string, start: string) { this.time = Date.parse(start); }
  private at() { this.time += 1500; return new Date(this.time).toISOString(); }
  push(type: string, payload: unknown) { this.lines.push(json({ timestamp: this.at(), type, payload })); }
  item(type: string, payload: Record<string, unknown>) { this.push("response_item", { type, ...payload }); }
  event(type: string, payload: Record<string, unknown>) { this.push("event_msg", { type, ...payload }); }
  start(brief: string) {
    this.push("session_meta", { id: this.sessionId, session_id: this.sessionId, timestamp: new Date(this.time).toISOString(), cwd, originator: "codex_cli_rs", cli_version: "0.160.1", source: "vscode", model_provider: "openai", base_instructions: { text: filler(18_000, 1) } });
    this.event("task_started", { turn_id: `turn-${this.sessionId}-1` });
    this.item("message", { role: "developer", content: [{ type: "input_text", text: filler(72_000, 2) }] });
    this.item("message", { role: "user", content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>zsh</shell>\n</environment_context>` }] });
    this.push("world_state", { full: true, state: { context_window_guidance: filler(23_000, 3), model: "gpt-6-luna" } });
    this.push("turn_context", { cwd, model: "gpt-6-luna", instructions: filler(48_000, 4) });
    this.user(brief);
  }
  user(text: string) {
    this.item("message", { role: "user", content: [{ type: "input_text", text }] });
    this.event("item_completed", { item: { type: "UserMessage", content: [{ type: "text", text }] } });
  }
  say(text: string) {
    this.item("reasoning", { summary: [], encrypted_content: "gAAAA" + filler(4200, this.calls).replace(/[^a-z]/g, "") });
    this.event("item_completed", { item: { type: "Reasoning", text: filler(380, 5) } });
    this.item("message", { role: "assistant", content: [{ type: "output_text", text }] });
    this.event("item_completed", { item: { type: "AgentMessage", content: [{ type: "text", text }] } });
  }
  /** A code-mode script and what it printed; Codex also stores a large item_completed copy of every inner call. */
  exec(script: string, printed: string[], duplicate = 0) {
    const call = `call_replica_${this.sessionId.slice(-4)}_${++this.calls}`;
    this.item("custom_tool_call", { id: `ctc_${call}`, status: "completed", call_id: call, name: "exec", input: script });
    this.push("token_usage_record", { thread_id: this.sessionId, usage: { input_tokens: 40_000 + this.calls, cached_input_tokens: 39_000, output_tokens: 300, total_tokens: 40_300 } });
    this.event("token_count", { info: { total_token_usage: { input_tokens: 40_000 + this.calls } } });
    // Started and completed copies of the inner call, as large as the output or larger; never indexed (event_msg).
    for (let n = 0; duplicate && n < 2; n++) this.event("item_completed", { item: { type: "McpToolCall", status: n ? "completed" : "inProgress", result: printed.join("\n").slice(0, duplicate) + filler(Math.max(0, duplicate - printed.join("\n").length), 6 + n) } });
    this.item("custom_tool_call_output", { id: `out_${call}`, call_id: call, output: [{ type: "input_text", text: "Script completed\nWall time 0.4 seconds\nOutput:\n" }, ...printed.map((text) => ({ type: "input_text", text }))] });
  }
  end() { this.event("task_complete", { last_agent_message: "done" }); }
  /** A later turn: Codex writes the thread settings and the turn context again. */
  turn() { this.event("thread_settings_applied", { settings: { instructions: filler(48_000, 7) } }); this.push("turn_context", { cwd, model: "gpt-6-luna", instructions: filler(48_000, 8) }); }
  text() { return this.lines.join(""); }
}

/** What `flowly_get_task` printed: Codex keeps the text and the structured copy, so the codeword is in it twice, once escaped. */
function getTask(position: "middle" | "late", size: number, salt: number, extra: Record<string, unknown> = {}) {
  const question = { id: "q:replica-1", status: "answered", text: `Stage A is ready. I mentioned ${replicaCodeword} once for the next session's history lookup. Please add the exact marker block.` };
  const before = filler(position === "middle" ? Math.floor(size * 0.22) : Math.floor(size * 0.42), salt), after = filler(position === "middle" ? Math.floor(size * 0.2) : 260, salt + 1);
  const structured = { identity: { taskId: "replica-card", workspaceId: "wks_replica" }, revision: { task: 3, project: 2 }, comments: [{ id: "c1", text: before }], handoff: { revision: 3, items: [question], notes: [{ text: after }] }, ...extra };
  return JSON.stringify({ content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: false });
}
/** A handoff page printed as JSON: the question with the codeword sits about 700 characters before the end. */
function handoffPage(salt: number) {
  const items = [{ section: "done", text: filler(4200, salt) }, { section: "decisions", text: filler(4600, salt + 1) }, { section: "questions", text: `Asked for the exact marker; mentioned ${replicaCodeword} for the history lookup.` }, { section: "next", text: filler(560, salt + 2) }];
  return JSON.stringify({ revision: 3, page: { taskId: "replica-card", items, complete: true } });
}
/** exec_command results printed by a script: one JSON line per command. */
function commands(outputs: { output: string; exit?: number }[]) {
  return outputs.map((entry, i) => JSON.stringify({ i, chunk_id: `c${i}a6`, wall_time_seconds: 0.00001, exit_code: entry.exit ?? 0, original_token_count: 20, output: entry.output })).join("\n");
}
const validationError = JSON.stringify({ content: [{ type: "text", text: "Input validation error: Invalid arguments for tool flowly_update_handoff: set.3.why: Invalid input: expected string, received undefined" }], isError: true });
const unauthorized = JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ code: "UNAUTHORIZED", message: "Invalid Kanban connection or request signature.", retryable: false }) }], structuredContent: { error: { code: "UNAUTHORIZED", message: "Invalid Kanban connection or request signature." } }, isError: true });
const brief = `[Flowly automation] Flowly's agent automation started this session to work on this card unattended, from start to finish.\n\n${filler(1500, 9)}`;

export function replicaRollout(role: ReplicaRole, sessionId: string, start = "2026-10-25T23:29:04.078Z") {
  const r = new Rollout(sessionId, start), s = replicaSecrets;
  r.start(role === "successor" ? `这条评论里有标记。收到它的执行者请完成卡片描述里的第二阶段。\n<<<MARKER\nreplica marker line\nMARKER>>>` : brief);
  if (role === "predecessor") {
    r.say("我会按卡片的 Stage A 指示先补齐标签和 workpad，再检查仓库资料并写入交接文件。");
    r.exec("const matches = ALL_TOOLS.filter(x => /flowly_(get_task|update_handoff|report_progress)/i.test(x.name));\ntext(matches);\n", [filler(17_000, 10)]);
    for (let n = 0; n < 5; n++) r.exec(`const r = await tools.mcp__flowly__flowly_get_task({handoff:"full"});\ntext(r);\n`, [getTask("middle", 24_000 + n * 1500, 20 + n)], 52_000);
    r.exec(`const results = await Promise.all([\n  tools.exec_command({cmd:"cat README.md",workdir:"${cwd}"}),\n  tools.exec_command({cmd:"od -c seed.txt",workdir:"${cwd}"}),\n  tools.exec_command({cmd:"env | grep KEY",workdir:"${cwd}"})\n]);\nfor (const x of results) text(x);\n`,
      [commands([{ output: `# Replica fixture\n\n${filler(900, 30)}` }, { output: "0000000   a   l   p   h   a  \\r  \\n   b   e   t   a  \\r  \\n\n" }, { output: `API_KEY=${s.outputKey}\nPATH=/usr/bin\n` }])]);
    r.say("CRLF 需要按原始字节保留：每行以 `\\r\\n` 结尾，不能按文本规范化。");
    r.exec(`const fs = await import("node:fs/promises");\nconst data = JSON.parse("{\\"apiToken\\":\\"${s.argumentEscaped}\\",\\"note\\":\\"stage a\\"}");\nawait fs.writeFile("stage-a.json", JSON.stringify(data, null, 2) + "\\n");\nconst auth = await tools.exec_command({cmd:"curl -s -H \\"Authorization: Bearer ${s.argumentBearer}\\" https://example.invalid/ping"});\nconst login = {user:"replica", password:"${s.argumentPassword}"};\ntext(auth);\n`,
      [commands([{ output: "" }, { output: `{\\"password\\":\\"${s.outputEscaped}\\",\\"ok\\":true}` }])]);
    r.exec(`const r = await tools.exec_command({cmd:"node -e 'check stage-a.json'"});\ntext(r.output);\n`, [commands([{ output: "" }, { output: `${seed}  seed.txt\n` }, { output: `PASS stage-a.json parses; seed SHA ${seed}\n` }, { output: "?? stage-a.json\n" }])]);
    r.exec(`const r = await tools.mcp__flowly__flowly_update_handoff({handoffRevision:2, set:[{section:"decisions", text:"Keep raw bytes"}]});\ntext(r);\n`, [validationError]);
    r.exec(`const r = await tools.mcp__flowly__flowly_set_tags({add:["routing"]});\ntext(r);\n`, [unauthorized]);
    r.exec(`const r = await tools.mcp__flowly__flowly_get_task({handoff:"full"});\nconst h = r.structuredContent.handoff;\ntext(JSON.stringify(h.page));\n`, [handoffPage(40)], 9000);
    // The note names the codeword past the 300-character argument preview of format 1.
    r.exec(`const t=await tools.mcp__flowly__flowly_get_task({handoff:"full"});\nconst d=t.structuredContent;\nconst r=await tools.mcp__flowly__flowly_report_progress({\n  kind:"question",\n  note:"Stage A is ready: stage-a.json records the initial seed hash, HEAD, nonce, the raw-byte decision, rejected normalization approach, CRLF pitfall, and Stage B next step. I mentioned ${replicaCodeword} once for the next session's history lookup. Please add a comment containing the exact marker block; I will continue waiting until it arrives.",\n  expectedRevision:d.revision,\n  request:d.request\n});\ntext(r);\n`,
      [getTask("middle", 30_000, 50)], 34_000);
    r.say("Stage A 已完成：在 stage-a.json 记录了初始 seed 哈希、HEAD、随机 nonce、决策、排除做法、CRLF 注意事项和下一步。");
    r.end(); r.turn();
    r.user("澄清：stage-a.json 写好之后就不要再改了；继续等标记即可。请把这条澄清记进交接记录。");
    for (let n = 0; n < 3; n++) r.exec(`const r = await tools.mcp__flowly__flowly_get_task({handoff:"full"});\ntext(r);\n`, [getTask("middle", 25_000 + n * 4000, 60 + n)], 70_000);
    r.say("已将澄清记入交接记录，并确认 stage-a.json 未修改。");
    r.end();
  } else if (role === "successor") {
    r.say("I will read the full handoff, verify the workspace and then complete Stage B.");
    for (let n = 0; n < 6; n++) r.exec(`const r = await tools.mcp__flowly__flowly_get_task({handoff:"full"});\nconst j = JSON.parse(r.content.find(c => c.type === "text").text);\ntext(JSON.stringify(j.handoff));\n`, [getTask("middle", 36_000, 70 + n)], n % 2 ? 140_000 : 110_000);
    r.exec(`const r = await tools.mcp__flowly__flowly_session_history({session:"#1", query:"${replicaCodeword}", limit:10});\ntext(r);\n`, [JSON.stringify({ status: "building", message: "Skeleton not ready (building); try again in a minute." })]);
    r.exec(`const r = await tools.exec_command({cmd:"node <<'NODE'\\nconst fs = require('node:fs');\\nfs.writeFileSync('expected-marker.txt', 'replica marker line');\\nNODE"});\ntext(r.output);\n`, [commands([{ output: "" }])]);
    r.exec(`const r = await tools.exec_command({cmd:"node verify.mjs"});\ntext(r.output);\n`, [commands([{ output: "PASS verify.mjs: expected-marker.txt matches; result.json and acceptance.json agree\n" }])]);
    r.say("Stage B outputs are present and verified; node verify.mjs passed.");
    r.end();
  } else {
    r.say("I will check the delivery against the card and the handoff record.");
    for (let n = 0; n < 2; n++) r.exec(`const r = await tools.mcp__flowly__flowly_get_task({handoff:"full"});\ntext(r);\n`, [getTask("middle", 38_000, 80 + n)], 200_000);
    r.exec(`const r = await tools.exec_command({cmd:"node verify.mjs && git diff --check"});\ntext(r.output);\n`, [commands([{ output: "PASS verify.mjs\n" }, { output: "", exit: 1 }])]);
    r.exec(`const r = await tools.mcp__flowly__flowly_get_task({handoff:"full"});\nconst p = r.structuredContent.handoff.page;\ntext(JSON.stringify(p));\n`, [JSON.stringify({ complete: true, items: [{ section: "done", text: filler(4800, 90) }, { section: "questions", text: `The predecessor mentioned ${replicaCodeword}; the history lookup returned building.` }, { section: "reviews", text: filler(1000, 91) }] })], 187_000);
    r.say("Approved: the marker files match and verify passes.");
    r.end();
  }
  return r.text();
}
/** Every manifest a reader published under its directory, and whether read() would accept it (SESSION-HANDOFF-SPEC §21.16). */
export async function publishedManifests(directory: string) {
  const folders = await readdir(join(directory, "session-history")).catch(() => [] as string[]);
  return Promise.all(folders.sort().map(async (folder) => {
    const path = join(directory, "session-history", folder, "current.json"), result = sessionHistoryManifestSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return { path, valid: result.success, ...(result.success ? {} : { issues: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) }) };
  }));
}
/**
 * A test's teardown: stops its readers, then reads back every manifest they published under `<root>/derived` and removes
 * the roots. Returns the manifests read() would refuse, which a test expects to be none.
 */
export async function releaseHistory(readers: SessionHistory[], roots: string[]) {
  await Promise.all(readers.splice(0).map((reader) => reader.stop())); forgetHistory();
  const published = (await Promise.all(roots.map((root) => publishedManifests(join(root, "derived"))))).flat();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  return published.filter((manifest) => !manifest.valid);
}
