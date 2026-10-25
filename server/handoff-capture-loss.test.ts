/**
 * Information-loss invariants of passive capture (review of 2026-10-25, after the noise fix).
 * Every text is synthetic; the record shapes follow Codex rollouts, Paseo timelines and the
 * paseo-dynamic-workflow / paseo-async-shell plugin sources.
 */
import { afterEach, expect, test, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { captureHandoff, captureTimeline, type CaptureCursor } from "./handoff-capture";
import { HandoffObserver, type HandoffObserverDeps } from "./handoff-observer";
import { HandoffStore } from "./handoff-store";
import { BoardStore } from "./store";
import { forgetHistory } from "./provider-history";
import { handoffOpenIds, type CardHandoff } from "../shared/handoff";
import { detachedCommand } from "./handoff-detached";

const roots: string[] = [], observers: HandoffObserver[] = [];
afterEach(async () => { forgetHistory(); await Promise.all(observers.splice(0).map((observer) => observer.stop())); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const at = "2026-10-25T02:00:00.000Z";
const uuid = "019a15e5-0000-7abc-8def-0123456789ab";
const json = (value: unknown) => JSON.stringify(value) + "\n";
const event = (type: string, data: Record<string, unknown> = {}) => ({ timestamp: at, type: "event_msg", payload: { type, ...data } });
const response = (type: string, data: Record<string, unknown>) => ({ timestamp: at, type: "response_item", payload: { type, ...data } });
const item = (value: Record<string, unknown>) => event("item_completed", { thread_id: uuid, turn_id: "t", item: value });
const script = (callId: string, input: string) => response("custom_tool_call", { call_id: callId, id: `ctc_${callId}`, status: "completed", name: "exec", input });
const scriptOutput = (callId: string, ...printed: string[]) => response("custom_tool_call_output", { call_id: callId, output: [{ type: "input_text", text: "Script completed\nWall time 0.5 seconds\nOutput:\n" }, ...printed.map((text) => ({ type: "input_text", text }))] });
const commandDone = (itemId: string, pid: string, cmd: string, exit = 0, output = "") => item({ type: "CommandExecution", id: itemId, process_id: pid, command: ["/bin/zsh", "-lc", cmd], status: "completed", exit_code: exit, aggregated_output: output });
const folder = (home: string) => { const stamp = new Date(parseInt(uuid.replace(/-/g, "").slice(0, 12), 16)); return join(home, "sessions", String(stamp.getFullYear()), String(stamp.getMonth() + 1).padStart(2, "0"), String(stamp.getDate()).padStart(2, "0")); };

async function codex(options: { maxLineBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "flowly-capture-loss-")); roots.push(root);
  const home = join(root, "codex"); await mkdir(folder(home), { recursive: true });
  const path = join(folder(home), `rollout-loss-${uuid}.jsonl`); await writeFile(path, "");
  const agent = { id: "managed-agent", provider: "codex", cwd: root, persistence: { provider: "codex", nativeHandle: uuid, sessionId: uuid } };
  const capture = (cursor?: CaptureCursor) => captureHandoff(agent, cursor, { codexHome: home, claudeHome: join(root, "unused"), now: () => Date.parse(at), ...options });
  return { capture, write: (lines: unknown[]) => writeFile(path, lines.map(json).join("")), append: (lines: unknown[]) => appendFile(path, lines.map(json).join("")) };
}
/** What a capture leaves for the card: background that is not closed, gaps, inputs and notes. */
const visible = (b: Awaited<ReturnType<typeof captureHandoff>>) => ({
  background: b.background.filter((entry) => !entry.closeOnly && entry.status !== "closed").map((entry) => `${entry.kind}:${entry.status}:${entry.handle ?? ""}:${entry.label ?? ""}`),
  gaps: b.gaps.map((gap) => gap.kind), inputs: b.inputs.map((input) => input.text) });

async function observerFixture(options: { maxLineBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "flowly-capture-loss-observer-")); roots.push(directory);
  const board = new BoardStore(directory), records = new HandoffStore(directory), home = join(directory, "synthetic-codex");
  await board.mutate((value) => {
    value.projects.push({ id: "project", title: "P", description: "", paseoProjectId: "native", primaryPath: directory, repos: [directory], revision: 1, createdAt: at, updatedAt: at, archivedAt: null });
    value.tasks.push({ id: "card", projectId: "project", workspaceId: "workspace", sourcePath: directory, repoPaths: [], title: "Card", description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: "create", createdAt: at, updatedAt: at, archivedAt: null });
  });
  await mkdir(folder(home), { recursive: true });
  const rollout = join(folder(home), `rollout-loss-${uuid}.jsonl`);
  await writeFile(rollout, json({ timestamp: at, type: "session_meta", payload: { id: uuid, session_id: uuid, cwd: directory } }));
  const actor = { id: "worker", provider: "codex", model: "gpt-fixture", workspaceId: "workspace", status: "idle", activeTurn: null, pendingPermissions: [] as unknown[], createdAt: at, updatedAt: at, lastUserMessageAt: at, persistence: { provider: "codex", nativeHandle: uuid }, archivedAt: null };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: actor }) }) } } as unknown as PaseoApi;
  const deps: HandoffObserverDeps = { records, board, paseo: () => paseo, serial: <T>(_: string, fn: () => Promise<T>) => fn(), syncIndex: async () => undefined, clock: () => Date.parse(at),
    capture: (agent, previous, o) => captureHandoff(agent, previous, { ...o, codexHome: home, claudeHome: join(home, "unused"), ...(options.maxLineBytes ? { maxLineBytes: options.maxLineBytes } : {}) }),
    git: vi.fn(async () => ({ snapshots: [], unchecked: [] })) };
  const observer = new HandoffObserver(deps); observers.push(observer);
  const read = () => records.read("card", "project");
  const ack = async (disposition: "done" | "obsolete", note: string, filter: (id: string) => boolean = () => true) => {
    const record = await read();
    await records.update("card", "project", { handoffRevision: record.revision, ack: { handoffRevision: record.revision, heads: [], understanding: "synthetic", items: handoffOpenIds(record).filter(filter).map((id) => ({ id, disposition, note })) } }, { by: { kind: "agent", agentId: "worker" } }, { agentId: "worker", actualHeads: [] });
  };
  return { observer, records, rollout, read, ack, append: (lines: unknown[]) => appendFile(rollout, lines.map(json).join("")), poll: () => observer.observe("card", "worker") };
}
const background = (record: CardHandoff) => record.ledger.flatMap((session) => session.background);
const pending = (record: CardHandoff) => background(record).filter((entry) => entry.status !== "closed");

// ---------------------------------------------------------------- background completion notices (loss-F1, loss-F7)
test("a failed Workflow keeps its outcome on the closed item and leaves a note with its status, failures and recovery", async () => {
  const x = await observerFixture();
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [
    { type: "tool_call", name: "Workflow", callId: "wf-ok", status: "completed", detail: { input: { scriptPath: "/tmp/wf/review.js" }, output: "Workflow launched in background. Task ID: task_wf1 Summary: synthetic review" } },
    { type: "user_message", text: "<task-notification>\n<task-id>task_wf1</task-id>\n<tool-use-id>wf-ok</tool-use-id>\n<status>failed</status>\n<summary>Workflow \"review\" failed: 2 of 5 agents failed</summary>\n<failures>reviewer-3: synthetic timeout</failures>\n<recovery>Resume with resumeFromRunId to reuse 3 cached results.</recovery>\n</task-notification>" },
  ] });
  const record = await x.read();
  expect(background(record)).toEqual([expect.objectContaining({ ref: "task_wf1", status: "closed", outcome: "failed" })]);
  const notes = record.notes.filter((note) => note.text.includes("task_wf1"));
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ kind: "hazard" });
  expect(notes[0].text).toMatch(/status failed/); expect(notes[0].text).toContain("reviewer-3: synthetic timeout"); expect(notes[0].text).toContain("resumeFromRunId");
  expect(record.inputs).toEqual([]);
  // A replay of the same timeline adds nothing.
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [{ type: "user_message", text: "<task-notification>\n<task-id>task_wf1</task-id>\n<status>failed</status>\n<summary>Workflow \"review\" failed: 2 of 5 agents failed</summary>\n<failures>reviewer-3: synthetic timeout</failures>\n<recovery>Resume with resumeFromRunId to reuse 3 cached results.</recovery>\n</task-notification>" }] });
  expect((await x.read()).notes.filter((note) => note.text.includes("task_wf1"))).toHaveLength(1);
});

test("the notice of a launch Flowly never itemized is still on the card: an interrupted dynamic workflow and a background agent's result", async () => {
  const x = await observerFixture();
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [
    { type: "user_message", text: "[paseo-dynamic-workflow] A background workflow you launched has ended. This message comes from the plugin, not from the user.\n<task-notification>\n<task-id>wf_cli1</task-id>\n<status>interrupted</status>\n<summary>Dynamic workflow \"audit\" was interrupted</summary>\n<recovery>Resume with resumeFromRunId wf_cli1.</recovery>\n<interrupted-agents>\n1 agent(s) were cut off and their partial work is not cached.\naudit-3: agent agent-synthetic-77\n</interrupted-agents>\n</task-notification>" },
    { type: "user_message", text: "<task-notification>\n<task-id>a1b2c3d4</task-id>\n<tool-use-id>ag-1</tool-use-id>\n<status>completed</status>\n<summary>Agent \"audit\" completed</summary>\n<result>Found 3 synthetic issues; the second needs the owner's decision.</result>\n</task-notification>" },
    { type: "user_message", text: "<task-notification>\n<task-id>bsh42</task-id>\n<output-file>/tmp/synthetic/bsh42.output</output-file>\n<status>completed</status>\n<summary>Background command \"npm test\" completed (exit code 0)</summary>\n</task-notification>" },
  ] });
  const record = await x.read(), texts = record.notes.map((note) => note.text).join("\n");
  expect(texts).toContain("wf_cli1"); expect(texts).toContain("interrupted"); expect(texts).toContain("agent-synthetic-77");
  expect(texts).toContain("Found 3 synthetic issues");
  // Untracked and completed without result blocks: the note is the only trace, so it is kept too.
  expect(texts).toContain("bsh42"); expect(texts).toContain("/tmp/synthetic/bsh42.output");
  expect(record.inputs).toEqual([]); expect(record.gaps).toEqual([]);
});

test("a tracked completion without result blocks only closes its item; long results are bounded and redacted in the note", () => {
  const long = `${"synthetic finding ".repeat(1200)} token=sk-abcdefghijklmnopqrstuvwx`;
  const b = captureTimeline("agent", [
    { type: "tool_call", name: "Workflow", callId: "wf-1", status: "completed", detail: { input: { name: "lint" }, output: "Workflow launched in background. Task ID: task_lint" } },
    { type: "user_message", text: "<task-notification>\n<task-id>task_lint</task-id>\n<status>completed</status>\n<summary>Workflow \"lint\" completed</summary>\n</task-notification>" },
    { type: "tool_call", name: "Workflow", callId: "wf-2", status: "completed", detail: { input: { name: "audit" }, output: "Workflow launched in background. Task ID: task_audit" } },
    { type: "user_message", text: `<task-notification>\n<task-id>task_audit</task-id>\n<status>completed</status>\n<summary>Workflow "audit" completed</summary>\n<result>${long}</result>\n</task-notification>` },
  ], { outcome: "completed" });
  const lint = b.background.find((entry) => entry.handle === "task_lint" && entry.closeOnly)!, audit = b.background.find((entry) => entry.handle === "task_audit" && entry.closeOnly)!;
  expect(lint).toMatchObject({ status: "closed", outcome: "completed" }); expect(lint.note?.always).toBe(false);
  expect(audit.note).toMatchObject({ always: true, kind: "background" });
  expect(audit.note!.text.length).toBeLessThanOrEqual(2000); expect(audit.note!.text).toContain("synthetic finding"); expect(audit.note!.text).not.toContain("sk-abcdefghijklmnop");
});

test("the dynamic-workflow plugin's relay of the user's Ultracode setting is kept as words on the card, not an anonymous gap", async () => {
  const x = await observerFixture();
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [
    { type: "user_message", text: "[paseo-dynamic-workflow] The user turned Ultracode off for you in Paseo. This message comes from the plugin, not from the user.\n<ultracode>off</ultracode>\nWorkflows are also turned off for you: do not launch any until the user enables them again. Reply only \"Ultracode off.\" and wait for the user's next request." },
  ] });
  const record = await x.read();
  expect(record.gaps).toEqual([]);
  expect(record.inputs).toEqual([expect.objectContaining({ via: "agent", from: expect.objectContaining({ title: "paseo-dynamic-workflow" }), status: "received", text: expect.stringContaining("do not launch any") })]);
});

// ---------------------------------------------------------------- script attribution and placeholders (loss-F2, noise-F1, noise-F2)
test("restarting a dev server: the old session's completion inside the new script does not hide the server that script starts", async () => {
  for (const variant of ["restart", "poll-build"] as const) {
    const x = await observerFixture();
    const [first, cmd, pid] = variant === "restart" ? ["npm run dev", "npm run dev -- --port 3001", "4242"] : ["npm run build", "npm start", "5001"];
    await x.append([script("s1", `const r = await tools.exec_command({ cmd: ${JSON.stringify(first)}, yield_time_ms: 3000 });\ntext(r);`), scriptOutput("s1", JSON.stringify({ session_id: Number(pid), output: "started" }))]);
    await x.poll();
    expect(pending(await x.read()).map((entry) => entry.ref)).toEqual([pid]);
    await x.append([script("s2", `await tools.write_stdin({ session_id: ${pid}, chars: "\\u0003", yield_time_ms: 1000 });\nconst next = await tools.exec_command({ cmd: ${JSON.stringify(cmd)}, yield_time_ms: 3000 });\ntext("ok");`),
      commandDone(`e-${pid}`, pid, first, variant === "restart" ? 130 : 0), scriptOutput("s2", "ok")]);
    await x.poll();
    const record = await x.read();
    expect(background(record).find((entry) => entry.ref === pid)).toMatchObject({ status: "closed", outcome: variant === "restart" ? "exit 130" : "exit 0" });
    expect(pending(record)).toEqual([expect.objectContaining({ kind: "exec_session", status: "unknown", label: expect.stringContaining("completion not observed") })]);
  }
});

test("a script's exec_command whose completion arrives after the script returned is closed by that completion", async () => {
  const x = await observerFixture();
  await x.append([script("s1", `await tools.exec_command({ cmd: "npm run dev", yield_time_ms: 2000 });\ntext("started");`), scriptOutput("s1", "started")]);
  await x.poll();
  expect(pending(await x.read())).toEqual([expect.objectContaining({ status: "unknown", label: expect.stringContaining("completion not observed") })]);
  // The dev server exits later: Codex writes its CommandExecution completion while no script runs.
  await x.append([commandDone("exec-late", "4242", "npm run dev", 0)]);
  await x.poll();
  const record = await x.read();
  expect(pending(record)).toEqual([]); expect(handoffOpenIds(record)).toEqual([]);
  expect(background(record)[0]).toMatchObject({ status: "closed", outcome: "exit 0" });
});

test("an ACK done or obsolete with a note settles an unknown background item for every later reader", async () => {
  const x = await observerFixture();
  await x.append([script("s1", `if (flag) await tools.exec_command({ cmd: "npm run dev", yield_time_ms: 2000 });\ntext("skipped");`), scriptOutput("s1", "skipped")]);
  await x.poll();
  expect(handoffOpenIds(await x.read())).toHaveLength(1);
  await x.ack("done", "checked with ps: no dev server is running");
  const record = await x.read();
  expect(handoffOpenIds(record)).toEqual([]);
  expect(pending(record)).toEqual([]); expect(background(record)[0]).toMatchObject({ status: "closed", outcome: expect.stringContaining("ACK") });
  expect(record.ledger[0].ack?.complete).toBe(true);
  // Replays and later polls do not reopen it.
  await x.poll(); expect(handoffOpenIds(await x.read())).toEqual([]);
});

test("41 scripts whose exec_commands never report completion do not stop capture: the person's next words are still stored", async () => {
  const x = await observerFixture();
  for (let n = 0; n < 41; n++) await x.append([script(`s${n}`, `await tools.exec_command({ cmd: "npm run watch-${n}", yield_time_ms: 1000 });\ntext("ok");`), scriptOutput(`s${n}`, "ok")]);
  await x.poll();
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [{ type: "user_message", text: "Please also keep the old endpoint", messageId: "human-1" }] });
  const record = await x.read(), entries = pending(record);
  expect(record.inputs.map((input) => input.text)).toEqual(["Please also keep the old endpoint"]);
  expect(entries.length).toBeLessThanOrEqual(40);
  // Nothing is silently dropped: the merged items are counted on one open entry and listed in a note.
  expect(entries).toContainEqual(expect.objectContaining({ label: expect.stringMatching(/^\d+ more background items merged/) }));
  const merged = Number(/^(\d+)/.exec(entries.find((entry) => /merged/.test(entry.label))!.label)![1]);
  expect(entries.length - 1 + merged).toBe(41);
  expect(record.notes.some((note) => note.text.includes("npm run watch-0") || note.text.includes("completion not observed"))).toBe(true);
});

test("a wait in flight when a poll lands leaves no placeholder once it returns", async () => {
  const x = await observerFixture();
  await x.append([script("s1", "await longTask();"), response("custom_tool_call_output", { call_id: "s1", output: [{ type: "input_text", text: "Script running with cell ID 3\nWall time 10 seconds\nOutput:\n" }] }),
    response("function_call", { name: "wait", call_id: "w1", arguments: JSON.stringify({ cell_id: 3, yield_time_ms: 30000 }) })]);
  await x.poll();
  expect(pending(await x.read()).map((entry) => entry.ref)).toEqual(["cell:3"]);
  await x.append([response("function_call_output", { call_id: "w1", output: "Script completed\nWall time 31 seconds\nOutput:\n" })]);
  await x.poll();
  const record = await x.read();
  expect(pending(record)).toEqual([]); expect(handoffOpenIds(record)).toEqual([]);
});

// ---------------------------------------------------------------- launches announced by CLIs and plugin rows (loss-F3, loss-F4)
const registered = JSON.stringify({ task: { taskId: "task-0123456789ab", description: "dev server", status: "running", active: true, origin: "cli", commandPreview: "npm run dev" }, duplicate: false }, null, 2);
test("an async shell registered with the paseo-shell CLI is open background work until its finished notice", async () => {
  const x = await observerFixture();
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [
    { type: "tool_call", name: "shell", callId: "sh-2", status: "completed", detail: { type: "shell", command: "paseo-shell register --description 'dev server' --command 'npm run dev'", output: registered } },
    { type: "plugin", id: "async-shell-task-0123456789ab", pluginId: "paseo-async-shell", kind: "async-shell-task", version: 1, data: { taskId: "task-0123456789ab", description: "dev server", status: "running", commandPreview: "npm run dev", startedAt: at, finishedAt: null, exitCode: null } },
    // Only the plugin's row is left of a second shell (its register output was not kept).
    { type: "plugin", id: "async-shell-task-00000000beef", pluginId: "paseo-async-shell", kind: "async-shell-task", version: 1, data: { taskId: "task-00000000beef", description: "watch", status: "pending", commandPreview: "npm run watch", startedAt: null, finishedAt: null, exitCode: null } },
  ] });
  let record = await x.read();
  expect(pending(record)).toEqual([
    expect.objectContaining({ kind: "async_shell", ref: "task-0123456789ab", status: "open" }),
    expect.objectContaining({ kind: "async_shell", ref: "task-00000000beef", status: "open", label: expect.stringContaining("watch") })]);
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [{ type: "user_message", text: "[async-shell failed task-0123456789ab] exit 1\nsynthetic tail" }] });
  record = await x.read();
  expect(background(record).find((entry) => entry.ref === "task-0123456789ab")).toMatchObject({ status: "closed", outcome: "failed" });
  // A row whose shell already ended at registration is not open work.
  const ended = captureTimeline("agent", [{ type: "plugin", id: "r", pluginId: "paseo-async-shell", kind: "async-shell-task", version: 1, data: { taskId: "task-0000000000aa", description: "x", status: "succeeded", commandPreview: "true", startedAt: at, finishedAt: at, exitCode: 0 } }], { outcome: "completed" });
  expect(ended.background).toEqual([expect.objectContaining({ handle: "task-0000000000aa", status: "closed", outcome: "succeeded" })]);
});

test("provider path: async shells registered through paseo-shell or the MCP tool get their real task id", async () => {
  const x = await codex();
  await x.write([
    script("s1", `await tools.exec_command({ cmd: "paseo-shell register --description dev --command 'npm run dev'" });\nawait tools.mcp__async_shell__register_async_shell({ command: "make watch", description: "watch" });\ntext("ok");`),
    commandDone("e1", "31002", "paseo-shell register --description dev --command 'npm run dev'", 0, registered),
    item({ type: "McpToolCall", id: "mcp-1", server: "async_shell", tool: "register_async_shell", arguments: { command: "make watch", description: "watch" }, status: "completed", result: { content: [{ type: "text", text: JSON.stringify({ task: { taskId: "task-0000000000cd", status: "running" } }, null, 2) }] } }),
    scriptOutput("s1", "ok"),
  ]);
  const v = visible(await x.capture());
  expect(v.background).toEqual(["async_shell:open:task-0123456789ab:async shell: paseo-shell register --description dev --command 'npm run dev'", expect.stringMatching(/^async_shell:open:task-0000000000cd:/)]);
  expect(v.gaps).toEqual([]);
});

test("a dynamic workflow launched with the paseo-workflow CLI is open until its notice, from a shell row or a Codex script", async () => {
  const launched = "Workflow launched in background. Run ID: wf_cli2\nSummary: synthetic audit\nScript file: /tmp/wf/audit.js";
  const b = captureTimeline("agent", [
    { type: "tool_call", name: "shell", callId: "sh-1", status: "completed", detail: { type: "shell", command: "paseo-workflow run --script-path /tmp/wf/audit.js", output: launched.replace("wf_cli2", "wf_cli1") } },
    // Printing a log that quotes a launch is not a launch.
    { type: "tool_call", name: "shell", callId: "sh-2", status: "completed", detail: { type: "shell", command: "cat /tmp/notes.txt", output: launched.replace("wf_cli2", "wf_old") } },
  ], { outcome: "completed" });
  expect(b.background.filter((entry) => !entry.closeOnly)).toEqual([expect.objectContaining({ kind: "agent", handle: "wf_cli1", status: "open", label: expect.stringContaining("paseo-workflow run") })]);
  const x = await codex();
  await x.write([
    script("s1", `const r = await tools.exec_command({ cmd: "paseo-workflow run --script-path /tmp/wf/audit.js", yield_time_ms: 5000 });\ntext("launched");`),
    commandDone("e1", "31001", "paseo-workflow run --script-path /tmp/wf/audit.js", 0, launched),
    scriptOutput("s1", "launched"),
  ]);
  const c = await x.capture();
  expect(visible(c).background).toEqual([expect.stringMatching(/^agent:open:wf_cli2:/)]);
  await x.append([event("user_message", { message: "[paseo-dynamic-workflow] A background workflow you launched has ended.\n<task-notification>\n<task-id>wf_cli2</task-id>\n<status>completed</status>\n<summary>synthetic</summary>\n<result>null</result>\n</task-notification>" })]);
  expect((await x.capture(c.cursor)).background).toContainEqual(expect.objectContaining({ handle: "wf_cli2", status: "closed", closeOnly: true, outcome: "completed" }));
});

// ---------------------------------------------------------------- the shared detached rule (loss-F5, noise-F4)
const daemons = [
  "docker compose up -d", "docker-compose -f dev.yml up --detach", "docker run -d --name db postgres:16", "docker run -dit --rm image", "docker start db",
  "tmux new-session -d -s dev 'npm run dev'", "tmux new -ds dev", "screen -dmS dev npm start", "screen -d -m npm start",
  "npm run dev > /tmp/dev.log 2>&1 & echo $!", "npm run dev &\nsleep 2\ncurl -s localhost:3000", "( npm run dev & )", "cd app && npm run dev &",
  "pm2 start ecosystem.config.js", "brew services start postgresql@16", "launchctl load ~/Library/LaunchAgents/dev.plist", "launchctl kickstart -k gui/501/dev",
  "systemctl --user start dev.service", "sudo systemctl restart nginx", "nohup ./serve.sh > serve.log 2>&1", "PORT=3001 nohup npm start", "sudo -E nohup ./serve.sh", "env FOO=1 setsid ./worker",
  "bash -c 'nohup ./serve.sh &'", "zsh -lc \"npm run dev &\"",
];
const finished = [
  "rg -n 'nohup|setsid' server", "grep -rn nohup docs", "echo \"a & b\"", "npm test 2>&1 | tee test.log", "make && make install || echo failed", "npm run build &> build.log",
  "cat <<'EOF' > notes.md\nrun it with nohup ./serve.sh &\nEOF\nwc -l notes.md", "# start later with nohup ./x &\nls", "git commit -m \"fix & polish\"", "curl 'http://localhost:3000/?a=1&b=2'",
  "docker ps -a", "docker compose logs -f api", "docker compose up --build", "docker run --rm image npm test", "docker start -a db", "tmux ls", "screen -ls", "brew services list", "systemctl status nginx", "pm2 logs",
];
test.each(daemons)("a command that leaves a daemon running is detached: %s", (cmd) => { expect(detachedCommand(cmd)).toBe(true); });
test.each(finished)("a command that only finishes, or merely mentions a daemonising word, is not detached: %s", (cmd) => { expect(detachedCommand(cmd)).toBe(false); });

test("inside a Codex script, a daemonising command surfaces even though its exec_command completed; a search for the word does not", async () => {
  for (const cmd of ["docker compose up -d", "tmux new-session -d -s dev 'npm run dev'", "npm run dev > /tmp/dev.log 2>&1 & echo $!"]) {
    const x = await codex();
    await x.write([script("s1", `await tools.exec_command({ cmd: ${JSON.stringify(cmd)} });\ntext("started");`), commandDone("e1", "31003", cmd, 0, "started"), scriptOutput("s1", "started")]);
    expect(visible(await x.capture()).background).toEqual([expect.stringMatching(/^exec:unknown::detached/)]);
  }
  const x = await observerFixture();
  await x.append([script("s1", `const r = await tools.exec_command({ cmd: "rg -n 'nohup|setsid' server" });\ntext(r.output);`), commandDone("exec-1", "77", "rg -n 'nohup|setsid' server", 0), scriptOutput("s1", "server/x.ts:1: nohup")]);
  await x.poll();
  expect(pending(await x.read())).toEqual([]);
});

// ---------------------------------------------------------------- where skipped content is, and recurrence after a restart (loss-F6, loss-F8, noise-F5)
test("each skipped long human message keeps its own gap with its byte range, message id and length", async () => {
  const x = await observerFixture({ maxLineBytes: 2048 });
  const long = (n: number) => event("user_message", { message: `synthetic long paste ${n} ` + "x".repeat(4000), message_id: `msg-long-${n}` });
  await x.append([long(1), long(2)]);
  await x.poll();
  const gaps = (await x.read()).gaps.filter((gap) => gap.text.includes("long_line"));
  expect(gaps).toHaveLength(2);
  expect(gaps.map((gap) => gap.text)).toEqual([expect.stringMatching(/bytes \d+–\d+.*msg-long-1.*\d+ bytes/), expect.stringMatching(/bytes \d+–\d+.*msg-long-2/)]);
  // Replays do not duplicate them.
  await x.poll(); expect((await x.read()).gaps.filter((gap) => gap.text.includes("long_line"))).toHaveLength(2);
});

test("after a restart rebuilds the timeline, new unknown rows reopen an acknowledged gap and replays do not inflate it", async () => {
  const x = await observerFixture();
  const row = (n: number) => ({ type: "plugin", id: `verdict-${n}`, pluginId: "turn-check", kind: "turn-check", version: 1, data: { verdict: n } });
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [row(1), row(2), row(3), { type: "assistant_message", text: "t1" }] });
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [row(1), row(2), row(3), { type: "assistant_message", text: "t1" }] });
  let gap = (await x.read()).gaps[0];
  expect(gap).toMatchObject({ status: "open", count: 3 });
  await x.ack("obsolete", "checked the three verdicts");
  expect((await x.read()).gaps[0]).toMatchObject({ status: "closed", resolution: { count: 3 } });
  // Plugin rows live only in the daemon's memory: after a restart the timeline holds only rows appended since.
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [row(4), { type: "assistant_message", text: "t2" }] });
  gap = (await x.read()).gaps[0];
  expect(gap).toMatchObject({ status: "open", count: 4 });
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [row(4), row(5), { type: "assistant_message", text: "t2" }, { type: "assistant_message", text: "t3" }] });
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [row(4), row(5), { type: "assistant_message", text: "t2" }, { type: "assistant_message", text: "t3" }] });
  expect((await x.read()).gaps).toEqual([expect.objectContaining({ status: "open", count: 5 })]);
});

test("unknown timeline rows without an identity are counted again once a shorter, rebuilt timeline shows them", async () => {
  const x = await observerFixture();
  const rows = (n: number) => Array.from({ length: n }, () => ({ type: "future_row", status: "done" }));
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: rows(3) });
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: rows(3) });
  expect((await x.read()).gaps).toEqual([expect.objectContaining({ count: 3 })]);
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: rows(1) });
  expect((await x.read()).gaps).toEqual([expect.objectContaining({ count: 4 })]);
});
