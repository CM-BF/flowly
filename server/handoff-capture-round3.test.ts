/**
 * Review round 3 (loss-r3-L1–L3, noise-r3-1–4): what a background completion, a sub-agent and the agent itself said must
 * reach the card, and host bookkeeping must not become gaps that reopen. Every text is synthetic; the shapes follow this
 * machine's Codex rollouts and Claude Code SDK transcripts (structure and counts only), paseo-async-shell
 * (server/notifications.ts) and Paseo's browser tools. Run through the real HandoffObserver and HandoffStore.
 */
import { afterEach, expect, test } from "vitest";
import { captureTimeline } from "./handoff-capture";
import { claudeBase, cleanupObserverFixtures, codexEvent, codexItem, codexResponse, codexTyped, observerFixture, successorView } from "./handoff-observer-fixture";

afterEach(cleanupObserverFixtures);
const call = (callId: string, name: string, args: Record<string, unknown>) => codexResponse("function_call", { name, call_id: callId, arguments: JSON.stringify(args) });
const result = (callId: string, output: string) => codexResponse("function_call_output", { call_id: callId, output });
const spawn = (callId: string, name: string, message: string) => [call(callId, "spawn_agent", { task_name: name, message, fork_turns: "none" }), result(callId, JSON.stringify({ task_name: `/root/${name}` }))];
const activity = (name: string, kind: string) => codexItem({ type: "SubAgentActivity", id: `sa-${name}-${kind}`, agent_path: `/root/${name}`, agent_thread_id: "019a15e5-1111-7abc-8def-0123456789ab", kind });
/** Codex multi-agent: a message between threads, a `Message Type` header block then (sometimes) an encrypted copy. */
const channel = (id: string, author: string, recipient: string, text: string, encrypted = false) => codexResponse("agent_message", { id, author, recipient, content: [...(text ? [{ type: "input_text", text }] : []), ...(encrypted ? [{ type: "encrypted_content", encrypted_content: "gAAAAsynthetic0paque1token2" }] : [])], internal_chat_message_metadata_passthrough: {} });
const header = (type: string, sender: string, payload: string) => `Message Type: ${type}\nTask name: /root\nSender: ${sender}\nPayload:\n${payload}`;
const answer = "Committed 1a2b3c4 on branch sub/migration-0042. Migration 0042 still FAILS on staging: column legacy_id is referenced by view v_orders; I did not drop it. Do not deploy until the view is changed.";

// ---------------------------------------------------------------- a Codex native sub-agent's final answer (loss-r3-L1, noise-r3-4)
test("R3-B1 what a native sub-agent reported when it finished reaches the card, as a Paseo child's last message does", async () => {
  const x = await observerFixture();
  await x.append([...spawn("sp-1", "db_migration_owner", "Write migration 0042 and run it against staging"), activity("db_migration_owner", "started"),
    channel("am-9", "/root/db_migration_owner", "/root", header("FINAL_ANSWER", "/root/db_migration_owner", answer)), activity("db_migration_owner", "completed")]);
  await x.poll(); await x.poll();
  const view = successorView(await x.read());
  expect(view.background).toEqual([expect.stringMatching(/^subagent:closed:\/root\/db_migration_owner:.*completed$/)]);
  expect(view.notes).toEqual([`background:Sub-agent /root/db_migration_owner reported its final answer: ${answer}`]);
  expect(view.gaps).toEqual([]); expect(view.inputs).toEqual([]); expect(view.open).toBe(0);
});

test("R3-B2 comparison: a Paseo child agent's finished notification keeps its last message as a note", async () => {
  const x = await observerFixture();
  await x.hook([{ type: "tool_call", name: "mcp__paseo__create_agent", callId: "ca-1", status: "completed", detail: { input: { title: "db migration" }, output: { structuredContent: { agentId: "agent-child-9" } } } }]);
  await x.append([codexTyped("01a170bb-0402", `<paseo-system version="1" kind="agent-notification" source-agent-id="agent-child-9" message-id="msg-2" source-agent-title="db migration" event="finished">\n${answer}\n</paseo-system>`)]);
  await x.poll();
  expect(successorView(await x.read()).notes.join("\n")).toContain("still FAILS on staging");
});

test("an interrupted sub-agent's answer is a hazard note, whichever comes first; a long answer is bounded and redacted", async () => {
  const x = await observerFixture();
  const long = `${"synthetic partial result ".repeat(150)} token=sk-abcdefghijklmnopqrstuvwx`;
  await x.append([...spawn("sp-1", "perf_probe", "Profile the import"), activity("perf_probe", "started"),
    channel("am-1", "/root/perf_probe", "/root", header("FINAL_ANSWER", "/root/perf_probe", "Stopped halfway: branch sub/perf has an uncommitted profile.")), activity("perf_probe", "interrupted"),
    ...spawn("sp-2", "lint_owner", "Fix lint"), activity("lint_owner", "started"), call("in-1", "interrupt_agent", { target: "lint_owner" }), result("in-1", JSON.stringify({ previous_status: "running" })),
    channel("am-2", "/root/lint_owner", "/root", header("FINAL_ANSWER", "/root/lint_owner", long))]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.notes).toEqual([
    "hazard:Sub-agent /root/perf_probe (interrupted) reported its final answer: Stopped halfway: branch sub/perf has an uncommitted profile.",
    expect.stringMatching(/^hazard:Sub-agent \/root\/lint_owner \(interrupted\) reported its final answer: synthetic partial result .*\(Excerpt; the whole answer is in that session's raw history\.\)$/)]);
  expect(view.notes[1].length).toBeLessThanOrEqual(2000 + "hazard:".length); expect(view.notes[1]).not.toContain("sk-abcdefghijklmnop");
});

test("encrypted-only messages and the root's own instructions are metadata; a report whose header cannot be read is one grouped gap", async () => {
  const x = await observerFixture();
  await x.append([...spawn("sp-1", "docs_owner", "Update the README"), activity("docs_owner", "started"),
    channel("am-1", "/root", "/root/docs_owner", "Also fix the install guide.", true),
    channel("am-2", "/root/docs_owner", "/root", header("MESSAGE", "/root/docs_owner", ""), true),
    channel("am-3", "/root/docs_owner", "/root", "", true),
    channel("am-4", "/root/docs_owner", "/root", "Synthetic report without a header"), channel("am-5", "/root/docs_owner", "/root", "Another synthetic report without a header")]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.notes).toEqual([]); expect(view.inputs).toEqual([]);
  expect(view.gaps).toEqual([expect.stringMatching(/^open:2:Capture gap \(unknown_response_type\): agent_message \(unparsed header\)\./)]);
});

test("R3-S1 a sub-agent whose task text is one opaque token is labelled by its task name, never with a redaction marker", async () => {
  const x = await observerFixture();
  // Real spawn_agent / followup_task `message` arguments are one opaque 600-900 character token (129 of 129 spawns this month).
  const opaque = Array.from({ length: 24 }, (_, n) => `Ab3dEf${n}GhIjK9lMnOpQ7rStUvWx`).join("");
  await x.append([...spawn("sp-1", "db_owner", opaque), activity("db_owner", "started"),
    channel("am-1", "/root/db_owner", "/root", header("FINAL_ANSWER", "/root/db_owner", "Migration 0042 applied; table orders still has the legacy column, do not drop it yet."), true),
    activity("db_owner", "completed"), call("fu-1", "followup_task", { target: "db_owner", message: opaque }), result("fu-1", "")]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.background).toEqual(["subagent:open:/root/db_owner:db_owner"]);
  expect(view.notes.join(" ")).toContain("legacy column");
});

// ---------------------------------------------------------------- a successful background completion keeps its result (loss-r3-L2)
const task = "task-0123456789ab";
const registered = { type: "plugin", id: `async-shell-${task}`, pluginId: "paseo-async-shell", kind: "async-shell-task", version: 1, data: { taskId: task, description: "wait for review", status: "running", commandPreview: "./synthetic-poll.sh" } };
const logs = `Logs: /tmp/synthetic/${task}/stdout and /tmp/synthetic/${task}/stderr. Page through them with read_async_shell_output or \`paseo-shell output ${task} [--stderr] [--offset N]\`.`;
const finished = (stdout: string, size = `${stdout.length} B`) => `[async-shell finished ${task}] "wait for review" exited with code 0 after 41m 2s.\n\nstdout (${size}):\n${stdout}\n\nstderr: (empty)\n\n${logs}\n\nContinue your work.`;

test.each(["provider", "timeline"] as const)("R3-C1 an async shell's finished notice keeps its summary, output tail and logs on the card (%s path)", async (path) => {
  const x = await observerFixture();
  const text = finished("Review service: 3 blocking findings (auth bypass in /login); details in /tmp/synthetic/review.json");
  await x.hook([registered]);
  if (path === "timeline") await x.hook([registered, { type: "user_message", text, messageId: "m-fin" }, { type: "assistant_message", text: "ok" }]);
  else { await x.append([codexTyped("01a170bb-fin", text)]); await x.poll(); }
  const view = successorView(await x.read());
  expect(view.background).toEqual([`async_shell:closed:${task}:async shell: wait for review:finished`]);
  expect(view.notes).toEqual([`background:Async shell ${task} finished: "wait for review" exited with code 0 after 41m 2s. stdout (98 B): Review service: 3 blocking findings (auth bypass in /login); details in /tmp/synthetic/review.json Logs: /tmp/synthetic/${task}/stdout and /tmp/synthetic/${task}/stderr.`]);
  expect(view.gaps).toEqual([]); expect(view.inputs).toEqual([]); expect(view.open).toBe(0);
});

test("a finished notice with a long output keeps only its last 600 characters and says so", () => {
  const lines = Array.from({ length: 80 }, (_, n) => `line ${n} of the synthetic test log`).join("\n");
  const b = captureTimeline("agent", [registered, { type: "user_message", text: finished(lines, "last 12.0 KiB of 40.0 KiB"), messageId: "m-1" }], { outcome: "completed" });
  const note = b.notices.find((value) => value.id === `async-notice:${task}:finished`)!;
  expect(note.kind).toBe("background");
  expect(note.text).toContain("stdout (last 12.0 KiB of 40.0 KiB), last 600 characters: …");
  expect(note.text).toContain("line 79 of the synthetic test log"); expect(note.text).not.toContain("line 3 of");
  expect(note.text).toContain(`Logs: /tmp/synthetic/${task}/stdout and /tmp/synthetic/${task}/stderr.`);
});

const claudeBash = [
  { ...claudeBase, type: "assistant", uuid: "a1", message: { id: "r1", content: [{ type: "tool_use", id: "toolu_bg1", name: "Bash", input: { command: "npm run migrate:staging", run_in_background: true, description: "Run the staging migration" } }] } },
  { ...claudeBase, type: "user", uuid: "u1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg1", content: "Command running in background with ID: bk7p2q9x1. Output is being written to: /tmp/synthetic/tasks/bk7p2q9x1.output" }] } },
];
test("R3-C2 Claude: a matched background command that completed keeps its status, summary and output file on the card", async () => {
  const x = await observerFixture({ provider: "claude" });
  await x.append([...claudeBash, { ...claudeBase, type: "attachment", uuid: "att-9", attachment: { type: "queued_command", commandMode: "task-notification", prompt: "<task-notification>\n<task-id>bk7p2q9x1</task-id>\n<tool-use-id>toolu_bg1</tool-use-id>\n<output-file>/tmp/synthetic/tasks/bk7p2q9x1.output</output-file>\n<status>completed</status>\n<summary>Background command \"npm run migrate:staging\" completed (exit code 0)</summary>\n</task-notification>", source_uuid: "q-9" } }]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.background).toEqual(["exec_session:closed:bk7p2q9x1:npm run migrate:staging:completed"]);
  expect(view.notes).toEqual(["background:Background task bk7p2q9x1 ended with status completed: Background command \"npm run migrate:staging\" completed (exit code 0). Output file: /tmp/synthetic/tasks/bk7p2q9x1.output."]);
  expect(view.gaps).toEqual([]); expect(view.open).toBe(0);
});

// ---------------------------------------------------------------- Codex narration without a turn-end hook (loss-r3-L3)
const progress = "Root cause found: the session cookie is set without SameSite=None, so the login callback drops it. I changed src/auth/cookie.ts and started the e2e suite; next I will fix the Safari redirect.";
const said = (id: string, text: string, phase = "commentary") => codexItem({ type: "AgentMessage", id, content: [{ type: "Text", text }], phase });

test("R3-D1 Codex: passive capture keeps the narration of a turn that never reached its turn-end hook, and lastWords", async () => {
  const x = await observerFixture();
  await x.append([codexTyped("01a170bb-u1", "Fix the login bug on Safari"), said("msg-1", progress)]);
  await x.poll();
  const record = await x.read();
  expect(record.ledger[0].live.map((item) => item.text)).toEqual([progress]);
  expect(record.lastWords).toMatchObject({ agentId: "worker", text: progress });
});

test("R3-D2 comparison: Claude's passive capture keeps the same narration", async () => {
  const x = await observerFixture({ provider: "claude" });
  await x.append([{ ...claudeBase, type: "user", uuid: "u-1", message: { role: "user", content: "Fix the login bug on Safari" } }, { ...claudeBase, type: "assistant", uuid: "a-1", message: { id: "r-1", content: [{ type: "text", text: progress }] } }]);
  await x.poll();
  const record = await x.read();
  expect(record.ledger[0].live.map((item) => item.text)).toEqual([progress]);
  expect(record.lastWords?.text).toBe(progress);
});

test("the provider copy, the turn's task_complete final and the hook copy of the same words are one narration entry", async () => {
  const x = await observerFixture();
  const final = "Fixed: the cookie now sets SameSite=None; e2e green at 4f5e6d7.";
  await x.append([codexTyped("01a170bb-u1", "Fix the login bug on Safari"), said("msg-1", progress), said("msg-2", final, "final_answer"), codexEvent("task_complete", { turn_id: "t", last_agent_message: final })]);
  await x.poll();
  for (let n = 0; n < 2; n++) await x.hook([{ type: "user_message", text: "Fix the login bug on Safari", messageId: "m-1" }, { type: "assistant_message", text: progress }, { type: "assistant_message", text: final }]);
  await x.append([said("msg-3", "Next turn: checking the Firefox path.")]); await x.poll();
  const record = await x.read();
  expect(record.ledger[0].live.map((item) => item.text)).toEqual([progress, final, "Next turn: checking the Firefox path."]);
  expect(record.ledger[0].turns.map((turn) => turn.final)).toEqual([final]);
  expect(record.lastWords?.text).toBe(`${progress}\n${final}\nNext turn: checking the Firefox path.`);
  expect(successorView(record).inputs).toEqual(["session:received:-:Fix the login bug on Safari"]);
});

test("a turn's task_complete final reaches the card when its AgentMessage was not read", async () => {
  const x = await observerFixture();
  await x.append([codexEvent("task_started", { turn_id: "t" }), codexEvent("task_complete", { turn_id: "t", last_agent_message: "Done: migration 0042 applied on staging." })]);
  await x.poll();
  const record = await x.read();
  expect(record.ledger[0].live.map((item) => item.text)).toEqual(["Done: migration 0042 applied on staging."]);
  expect(record.lastWords?.text).toBe("Done: migration 0042 applied on staging.");
});

// ---------------------------------------------------------------- Paseo browser tabs and async-shell cancels (noise-r3-1)
const context = { agentId: "worker", cwd: "/tmp/synthetic", workspaceId: "workspace" };
const newTab = (id: string, browserId: string) => codexItem({ type: "McpToolCall", id, server: "paseo", tool: "browser_new_tab", status: "completed", arguments: { url: "https://app.example.test/" },
  result: { content: [{ type: "text", text: "{}" }], structuredContent: { ok: true, result: { command: "new_tab", browserId, workspaceId: "workspace", url: "https://app.example.test/" }, context } } });
const closeTab = (id: string, browserId: string) => codexItem({ type: "McpToolCall", id, server: "paseo", tool: "browser_close_tab", status: "completed", arguments: { browserId },
  result: { content: [{ type: "text", text: "{}" }], structuredContent: { ok: true, result: { command: "close_tab", browserId }, context: { ...context, browserId } } } });
const shellTask = (status: string) => ({ taskId: task, status, description: "synthetic watcher", commandPreview: "./synthetic-watch.sh", active: status === "running", cwd: "/tmp/synthetic", outcome: status === "cancelled" ? "cancelled" : null });
const shellCall = (id: string, tool: string, args: Record<string, unknown>, value: Record<string, unknown>, isError = false) => codexItem({ type: "McpToolCall", id, server: "async_shell", tool, status: "completed", arguments: args, result: { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) } });

test("a Paseo browser tab opened and closed leaves nothing to acknowledge; one still open is one item with its browserId", async () => {
  const x = await observerFixture();
  await x.append([newTab("call-open-1", "browser-0001"), closeTab("call-close-1", "browser-0001"), newTab("call-open-2", "browser-0002")]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.background).toEqual(["browser_tab:closed:browser-0001:browser tab: https://app.example.test/", "browser_tab:open:browser-0002:browser tab: https://app.example.test/"]);
  expect(view.gaps).toEqual([]); expect(view.open).toBe(1);
});

test("an async shell the agent cancelled is closed with that outcome", async () => {
  const x = await observerFixture();
  await x.append([shellCall("call-register-1", "register_async_shell", { command: "./synthetic-watch.sh", description: "synthetic watcher" }, { task: shellTask("running"), duplicate: false }),
    shellCall("call-cancel-1", "cancel_async_shell", { task_id: task }, { task: shellTask("cancelled") })]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.background).toEqual([`async_shell:closed:${task}:./synthetic-watch.sh:cancelled`]);
  expect(view.gaps).toEqual([]); expect(view.open).toBe(0);
});

test("a start call that failed started nothing: no item and no gap, only a note with its error", async () => {
  const x = await observerFixture();
  await x.append([codexItem({ type: "McpToolCall", id: "call-open-9", server: "paseo", tool: "browser_new_tab", status: "completed", arguments: { url: "https://app.example.test/" }, result: { content: [{ type: "text", text: "{}" }], structuredContent: { ok: false, error: { code: "PLUGIN_NOT_READY", message: "browser plugin not ready" } } } }),
    shellCall("call-register-9", "register_async_shell", { command: "./synthetic-watch.sh" }, { error: "async shell plugin not ready" }, true),
    shellCall("call-cancel-9", "cancel_async_shell", { task_id: "task-00000000feed" }, { error: "no such task" }, true)]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.background).toEqual([]); expect(view.gaps).toEqual([]); expect(view.open).toBe(0);
  expect(view.notes).toEqual([
    "background:browser_new_tab failed (call call-open-9), so Flowly assumes it started nothing: browser plugin not ready",
    "background:register_async_shell failed (call call-register-9), so Flowly assumes it started nothing: async shell plugin not ready",
    "background:cancel_async_shell failed (call call-cancel-9); what it targeted keeps its state: no such task"]);
});

