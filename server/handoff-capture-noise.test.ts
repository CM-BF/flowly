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
import { handoffOpenIds } from "../shared/handoff";
import { handoffRefusalFingerprint } from "./handoff-requirements";
import { fixtureMix, replicaTimeline, writeReplicaRollout } from "./handoff-capture-fixture";

const roots: string[] = [], observers: HandoffObserver[] = [];
afterEach(async () => { forgetHistory(); await Promise.all(observers.splice(0).map((observer) => observer.stop())); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const at = "2026-10-25T02:00:00.000Z", flowly = { by: { kind: "flowly" as const } };
const uuid = "019a15e5-0000-7abc-8def-0123456789ab";
const json = (value: unknown) => JSON.stringify(value) + "\n";
const event = (type: string, data: Record<string, unknown> = {}) => ({ timestamp: at, type: "event_msg", payload: { type, ...data } });
const response = (type: string, data: Record<string, unknown>) => ({ timestamp: at, type: "response_item", payload: { type, ...data } });
const item = (value: Record<string, unknown>) => event("item_completed", { thread_id: uuid, turn_id: "t", item: value });
const script = (callId: string, input: string) => response("custom_tool_call", { call_id: callId, id: `ctc_${callId}`, status: "completed", name: "exec", input });
const scriptOutput = (callId: string, header: string, ...printed: unknown[]) => response("custom_tool_call_output", { call_id: callId, output: [{ type: "input_text", text: `${header}\nWall time 0.5 seconds\nOutput:\n` }, ...printed.map((value) => ({ type: "input_text", text: typeof value === "string" ? value : JSON.stringify(value) }))] });

async function codex() {
  const root = await mkdtemp(join(tmpdir(), "flowly-capture-noise-")); roots.push(root);
  const home = join(root, "codex"), stamp = new Date(parseInt(uuid.replace(/-/g, "").slice(0, 12), 16));
  const dir = join(home, "sessions", String(stamp.getFullYear()), String(stamp.getMonth() + 1).padStart(2, "0"), String(stamp.getDate()).padStart(2, "0"));
  await mkdir(dir, { recursive: true }); const path = join(dir, `rollout-date-${uuid}.jsonl`); await writeFile(path, "");
  const agent = { id: "managed-agent", provider: "codex", cwd: root, persistence: { provider: "codex", nativeHandle: uuid, sessionId: uuid } };
  const capture = (cursor?: CaptureCursor) => captureHandoff(agent, cursor, { codexHome: home, claudeHome: join(root, "unused"), now: () => Date.parse(at) });
  return { path, capture, write: (lines: unknown[]) => writeFile(path, lines.map(json).join("")), append: (lines: unknown[]) => appendFile(path, lines.map(json).join("")) };
}

test("a script that only ran finished commands and MCP calls leaves no gap and no background item, only a script count", async () => {
  const x = await codex();
  await x.write([
    script("s1", `const r = await tools.exec_command({ cmd: "npm test", yield_time_ms: 1000 });\nconst card = await tools.mcp__flowly__flowly_get_task({});\ntext(r.output); text(card);`),
    item({ type: "CommandExecution", id: "exec-1", process_id: "77", command: ["/bin/zsh", "-lc", "npm test"], status: "completed", exit_code: 0, aggregated_output: "private output is never kept" }),
    item({ type: "McpToolCall", id: "mcp-1", server: "flowly", tool: "flowly_get_task", arguments: {}, status: "completed", result: { content: [{ type: "text", text: "{}" }] } }),
    scriptOutput("s1", "Script completed", "ok", { ok: true }),
  ]);
  const b = await x.capture();
  expect(b.gaps).toEqual([]); expect(b.scriptCalls).toBe(1);
  expect(b.background.every((entry) => entry.closeOnly && entry.status === "closed")).toBe(true);
  expect(JSON.stringify(b)).not.toContain("private output");
});

test("a script that leaves a process running still surfaces it: printed session id, detached literal, nested start and unfinished exec", async () => {
  const x = await codex();
  await x.write([
    // (a) unified exec session still running at yield: printed result has session_id and no exit_code.
    script("s1", `const dev = await tools.exec_command({ cmd: "npm run dev", yield_time_ms: 2000 });\ntext(dev);`),
    scriptOutput("s1", "Script completed", { chunk_id: "c1", wall_time_seconds: 2, session_id: 4242, original_token_count: 10, output: "listening" }),
    // (b) a self-daemonising command literal in the script text.
    script("s2", `await tools.exec_command({ cmd: "nohup ./serve.sh > serve.log 2>&1 &" });`),
    item({ type: "CommandExecution", id: "exec-2", process_id: "88", command: ["/bin/zsh", "-lc", "nohup ./serve.sh > serve.log 2>&1 &"], status: "completed", exit_code: 0 }),
    scriptOutput("s2", "Script completed"),
    // (c) a nested background tool whose completion item was not observed (for example a skipped long line).
    script("s3", `const shell = await tools.mcp__async_shell__register_async_shell({ command: "make long-build", description: "build" });\ntext("registered");`),
    scriptOutput("s3", "Script completed", "registered"),
    // (d) a nested exec_command with no completion item and nothing printed: it is still running.
    script("s4", `const r = await tools.exec_command({ cmd: longRunning, yield_time_ms: 1000 });\ntext(r.output);`),
    scriptOutput("s4", "Script completed", "partial output"),
  ]);
  const b = await x.capture();
  const live = b.background.filter((entry) => !entry.closeOnly);
  expect(live).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "exec", handle: "4242", status: "open" }),
    expect.objectContaining({ kind: "exec", status: "unknown", label: expect.stringContaining("nohup ./serve.sh") }),
    expect.objectContaining({ kind: "async_shell", status: "unknown", label: expect.stringContaining("register_async_shell") }),
    expect.objectContaining({ kind: "exec", status: "unknown", label: expect.stringContaining("completion not observed") }),
  ]));
  expect(b.gaps.map((gap) => gap.kind)).not.toContain("opaque_tool_background");
  // The later completion item of session 4242 closes it, and a reprint of the old start result cannot reopen it.
  await x.append([item({ type: "CommandExecution", id: "exec-9", process_id: "4242", command: ["/bin/zsh", "-lc", "npm run dev"], status: "completed", exit_code: 0 }),
    script("s5", "text(dev);"), scriptOutput("s5", "Script completed", { session_id: 4242, output: "stale copy" })]);
  const c = await x.capture(b.cursor);
  expect(c.background).toContainEqual(expect.objectContaining({ handle: "4242", status: "closed", closeOnly: true }));
  expect(c.background.some((entry) => entry.handle === "4242" && entry.status === "open")).toBe(false);
});

test("a nested background tool seen through its completion item gets its real handle instead of an unknown placeholder", async () => {
  const x = await codex();
  await x.write([
    script("s1", `await tools.mcp__async_shell__register_async_shell({ command: "make long-build", description: "build" });`),
    item({ type: "McpToolCall", id: "mcp-9", server: "async_shell", tool: "register_async_shell", arguments: { command: "make long-build" }, status: "completed", result: { content: [{ type: "text", text: "{\"task_id\":\"task-77\"}" }], structuredContent: { task_id: "task-77" } } }),
    scriptOutput("s1", "Script completed"),
    event("user_message", { message: "[async-shell finished task-77] done" }),
  ]);
  const b = await x.capture();
  const live = b.background.filter((entry) => !entry.closeOnly);
  expect(live).toContainEqual(expect.objectContaining({ kind: "async_shell", handle: "task-77", status: "open" }));
  expect(live).toContainEqual(expect.objectContaining({ kind: "async_shell", handle: "task-77", status: "closed" }));
  expect(live.some((entry) => entry.status === "unknown")).toBe(false);
});

test("a yielded script cell is open background work until a wait reports it finished", async () => {
  const x = await codex();
  await x.write([script("s1", "await longTask();"), scriptOutput("s1", "Script running with cell ID 3")]);
  const b = await x.capture();
  expect(b.background).toContainEqual(expect.objectContaining({ kind: "exec", handle: "cell:3", status: "open" }));
  await x.append([response("function_call", { name: "wait", call_id: "w1", arguments: JSON.stringify({ cell_id: 3, yield_time_ms: 30000, max_tokens: 1000 }) }), response("function_call_output", { call_id: "w1", output: "Script completed\nWall time 31 seconds\nOutput:\n" })]);
  const c = await x.capture(b.cursor);
  expect(c.background).toContainEqual(expect.objectContaining({ handle: "cell:3", status: "closed", closeOnly: true }));
  expect(c.gaps).toEqual([]);
});

test("Claude Workflow launches are tracked by task id and closed by their notification; a rejected launch starts nothing", () => {
  const b = captureTimeline("claude-agent", [
    { type: "tool_call", name: "Workflow", callId: "wf-ok", status: "completed", detail: { input: { scriptPath: "/tmp/wf/review.js" }, output: "Workflow launched in background. Task ID: task_abc123 Summary: synthetic" } },
    { type: "tool_call", name: "Workflow", callId: "wf-bad", status: "failed", detail: { input: { script: "bad" }, output: "<tool_use_error>synthetic validation failure</tool_use_error>" } },
    { type: "user_message", text: "<task-notification>\n<task-id>task_abc123</task-id>\n<status>completed</status>\n<summary>synthetic</summary>\n</task-notification>" },
    { type: "tool_call", name: "mcp__dynamic_workflow__workflow", callId: "dw-1", status: "completed", detail: { input: { name: "lint" }, output: { content: [{ type: "text", text: "Workflow launched in background. Run ID: wf_42" }] } } },
    { type: "user_message", text: "[paseo-dynamic-workflow] finished\n<task-id>wf_42</task-id>\n<status>failed</status>\n<summary>synthetic</summary>" },
  ], { outcome: "completed" });
  const live = b.background.filter((entry) => !entry.closeOnly);
  expect(live).toEqual([expect.objectContaining({ kind: "agent", handle: "task_abc123", status: "open", label: "Workflow review" }), expect.objectContaining({ kind: "agent", handle: "wf_42", status: "open", label: "Workflow lint" })]);
  expect(b.background).toContainEqual(expect.objectContaining({ handle: "task_abc123", status: "closed", closeOnly: true, outcome: "completed" }));
  expect(b.background).toContainEqual(expect.objectContaining({ handle: "wf_42", status: "closed", closeOnly: true, outcome: "failed" }));
  expect(b.inputs).toEqual([]); expect(b.gaps).toEqual([]); expect(b.scriptCalls).toBe(3);
});

test("plugin rows: metadata is skipped, a person's goal is captured verbatim, an unknown kind is one grouped gap", () => {
  const b = captureTimeline("agent", [
    { type: "plugin", id: "a1", pluginId: "compact-activity", kind: "activity-list", version: 1, data: { scope: "turn", counts: {} } },
    { type: "plugin", id: "s1", pluginId: "flowly", kind: "flowly-summary", version: 1, data: { recap: "synthetic" } },
    { type: "plugin", id: "g1", pluginId: "goal-loop", kind: "goal-status", version: 1, data: { goal: "Ship the export with a dry-run flag first", status: "active", turnsUsed: 2 } },
    { type: "plugin", id: "g1", pluginId: "goal-loop", kind: "goal-status", version: 1, data: { goal: "Ship the export with a dry-run flag first", status: "active", turnsUsed: 3 } },
    ...Array.from({ length: 5 }, (_, n) => ({ type: "plugin", id: `x${n}`, pluginId: "future-plugin", kind: "future-card", version: 1, data: { n } })),
    { type: "todo", items: [{ text: "synthetic", completed: false }] },
    { type: "compaction", status: "loading" },
    { type: "notification", level: "info", message: "synthetic info" },
    { type: "notification", level: "warning", message: "synthetic host warning" },
  ], { outcome: "completed" });
  // Repeated status rows of one goal share one source id, so the observer stores the person's goal once.
  expect(b.inputs).toEqual([expect.objectContaining({ text: "Ship the export with a dry-run flag first", via: "session", status: "received" }), expect.objectContaining({ id: b.inputs[0].id })]);
  expect(b.gaps).toEqual([expect.objectContaining({ kind: "unknown_timeline_type", typeHint: "plugin:future-plugin/future-card", count: 5 })]);
  expect(b.notices.map((notice) => notice.text)).toEqual(["Paseo warning notice in this session: synthetic host warning"]);
  expect(b.compactions).toEqual([]);
});

test("metadata records are skipped, a goal objective is an input, and 100 identical unknown events are one gap with a count", async () => {
  const x = await codex();
  await x.write([
    { timestamp: at, ordinal: 1, type: "world_state", payload: { full: true, state: { agents_md: {}, host_skills: { body: "synthetic" } } } },
    event("thread_settings_applied", { thread_id: uuid, thread_settings: { model: "m", collaboration_mode: { mode: "default", settings: { developer_instructions: "synthetic" } } } }),
    { timestamp: at, type: "inter_agent_communication_metadata", payload: { synthetic: true } },
    event("thread_goal_updated", { threadId: uuid, goal: { objective: "Keep the public API unchanged", status: "active", tokensUsed: 1 } }),
    event("thread_goal_updated", { threadId: uuid, goal: { objective: "Keep the public API unchanged", status: "active", tokensUsed: 9 } }),
    ...Array.from({ length: 100 }, (_, n) => ({ ...event("future_event", { n }), timestamp: new Date(Date.parse(at) + n * 1000).toISOString() })),
  ]);
  const b = await x.capture();
  expect(b.gaps).toEqual([expect.objectContaining({ kind: "unknown_event_type", typeHint: "future_event", count: 100, at, lastAt: new Date(Date.parse(at) + 99_000).toISOString() })]);
  expect(b.inputs.map((input) => input.text)).toEqual(["Keep the public API unchanged", "Keep the public API unchanged"]);
  expect(new Set(b.inputs.map((input) => input.id)).size).toBe(1);
});

async function observerFixture() {
  const directory = await mkdtemp(join(tmpdir(), "flowly-capture-noise-observer-")); roots.push(directory);
  const board = new BoardStore(directory), records = new HandoffStore(directory), home = join(directory, "synthetic-codex");
  await board.mutate((value) => {
    value.projects.push({ id: "project", title: "P", description: "", paseoProjectId: "native", primaryPath: directory, repos: [directory], revision: 1, createdAt: at, updatedAt: at, archivedAt: null });
    value.tasks.push({ id: "card", projectId: "project", workspaceId: "workspace", sourcePath: directory, repoPaths: [], title: "Card", description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: "create", createdAt: at, updatedAt: at, archivedAt: null });
  });
  const actor = { id: "worker", provider: "codex", model: "gpt-fixture", workspaceId: "workspace", status: "idle", activeTurn: null, pendingPermissions: [] as unknown[], createdAt: at, updatedAt: at, lastUserMessageAt: at, persistence: { provider: "codex", nativeHandle: uuid }, archivedAt: null };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: actor }) }) } } as unknown as PaseoApi;
  const serial = <T>(_: string, fn: () => Promise<T>) => fn();
  const deps: HandoffObserverDeps = { records, board, paseo: () => paseo, serial, syncIndex: async () => undefined, clock: () => Date.parse(at),
    capture: (agent, previous, options) => captureHandoff(agent, previous, { ...options, codexHome: home, claudeHome: join(home, "unused") }),
    git: vi.fn(async () => ({ snapshots: [], unchecked: [] })) };
  const observer = new HandoffObserver(deps); observers.push(observer);
  return { observer, records, actor, home, read: () => records.read("card", "project") };
}

test("observer: a flood is one open gap, replays do not inflate it, ACK settles it and only growth past the acknowledged count reopens it", async () => {
  const x = await observerFixture(), session = { ...fixtureMix[0], agentId: "worker", uuid, scripts: 0, worldStates: 1, settings: 0, compaction: false };
  const path = await writeReplicaRollout(x.home, session);
  await appendFile(path, Array.from({ length: 100 }, () => json(event("future_event"))).join(""));
  const timeline = Array.from({ length: 3 }, (_, n) => ({ type: "plugin", id: `p${n}`, pluginId: "future-plugin", kind: "future-card", version: 1, data: {} }));
  await x.observer.observe("card", "worker", { timeline, outcome: "completed" });
  await x.observer.observe("card", "worker", { timeline, outcome: "completed" }); // replayed hook, same file
  let record = await x.read();
  expect(record.gaps.filter((gap) => gap.status === "open").map((gap) => [gap.text.split(".")[0], gap.count])).toEqual([
    ["Capture gap (unknown_event_type): future_event", 100], ["Capture gap (unknown_timeline_type): plugin:future-plugin/future-card", 3]]);
  // More occurrences while it is open do not change the delivery gate's requirements.
  const gate = handoffRefusalFingerprint(record);
  await appendFile(path, json(event("future_event"))); await x.observer.observe("card", "worker");
  record = await x.read(); const flood = record.gaps.find((gap) => gap.text.includes("future_event"))!;
  expect(flood.count).toBe(101); expect(handoffRefusalFingerprint(record)).toBe(gate);
  // One acknowledgement covers every occurrence counted at the revision it names. The 101st was counted in place after it
  // (same revision): that ACK settles the 100, and the next one, of the revision that holds all 101, settles the rest (§7.5).
  const ack = (revision: number, ids: string[]) => x.records.update("card", "project", { handoffRevision: revision, ack: { handoffRevision: revision, heads: [], understanding: "synthetic", items: ids.map((id) => ({ id, disposition: "obsolete" as const, note: "checked: unknown host metadata" })) } }, { by: { kind: "agent", agentId: "worker" } }, { agentId: "worker", actualHeads: [] });
  await expect(ack(record.revision, handoffOpenIds(record).filter((id) => id.startsWith("g:")))).resolves.toMatchObject({ ackMissing: [flood.id] });
  record = await x.read();
  expect(record.gaps.find((gap) => gap.id === flood.id)).toMatchObject({ status: "open", count: 101, resolution: { count: 100 } });
  await expect(ack(record.revision, [flood.id])).resolves.not.toHaveProperty("ackMissing");
  record = await x.read();
  expect(record.gaps.every((gap) => gap.status === "closed")).toBe(true); expect(record.gaps.find((gap) => gap.id === flood.id)?.resolution?.count).toBe(101);
  // A replay of what was acknowledged stays closed; a new occurrence reopens the same single gap.
  await x.observer.observe("card", "worker", { timeline, outcome: "completed" });
  expect((await x.read()).gaps.every((gap) => gap.status === "closed")).toBe(true);
  await appendFile(path, json(event("future_event"))); await x.observer.observe("card", "worker");
  record = await x.read();
  expect(record.gaps.filter((gap) => gap.status === "open").map((gap) => [gap.id, gap.count])).toEqual([[flood.id, 102]]);
  expect(record.gaps).toHaveLength(2);
});

test("observer: the takeover fixture's record mix now yields no open gaps, one compaction note and per-session script counts", async () => {
  const x = await observerFixture();
  for (const session of fixtureMix) {
    await writeReplicaRollout(x.home, session);
    x.actor.id = session.agentId; x.actor.persistence.nativeHandle = session.uuid;
    await x.observer.observe("card", session.agentId);
    await x.observer.observe("card", session.agentId, { timeline: replicaTimeline(session), outcome: "completed" });
  }
  const record = await x.read();
  // Before (786d9cd), the same synthetic mix produced 139 open gaps: 120 opaque_tool_background, 9 plugin rows,
  // 5 world_state, 4 thread_settings_applied and 1 compaction (measured in a temporary worktree, docs/PROGRESS.md).
  expect([...record.gaps, ...record.overflow.filter((entry) => entry.section === "gaps")]).toEqual([]);
  expect(handoffOpenIds(record)).toEqual([]);
  expect(record.ledger.map((session) => [session.agentId, session.scriptCalls, session.background.filter((entry) => entry.status !== "closed").length])).toEqual([["predecessor-b6", 65, 0], ["successor-e19", 43, 0], ["reviewer-cf6", 12, 0]]);
  expect(record.ledger[0].skeleton).toContain("65 script or workflow calls ran here");
  const compaction = record.notes.filter((note) => note.text.includes("context was compacted"));
  expect(compaction).toHaveLength(1); expect(compaction[0].text).toMatch(/^Session #1 \(predeces\): its context was compacted at 2026-10-25T\S+\. Details from before then may be missing from that session's memory; its raw session history is unchanged\.$/);
  expect(record.inputs).toEqual([]);
});

test("observer: closing a gap by id records the acknowledged count, so the same count never reopens it", async () => {
  const x = await observerFixture(), session = { ...fixtureMix[0], agentId: "worker", uuid, scripts: 0, worldStates: 1, settings: 0, compaction: false };
  const path = await writeReplicaRollout(x.home, session);
  await appendFile(path, json(event("future_event")) + json(event("future_event")));
  await x.observer.observe("card", "worker"); let record = await x.read();
  const gap = record.gaps[0]; expect(gap.count).toBe(2);
  await x.records.update("card", "project", { handoffRevision: record.revision, gaps: [{ id: gap.id, status: "closed", note: "verified: no instruction was carried" }] }, flowly);
  await x.observer.observe("card", "worker"); record = await x.read();
  expect(record.gaps[0]).toMatchObject({ status: "closed", count: 2, resolution: { count: 2 } });
});
