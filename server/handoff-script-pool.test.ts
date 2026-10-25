import { afterEach, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { handoffOpenIds, type CardHandoff } from "../shared/handoff";
import { cleanupObserverFixtures, codexEvent, codexItem, codexResponse, fixtureUuid, observerFixture } from "./handoff-observer-fixture";
import { cleanupRunningFixtures, fullRead, handedOver } from "./handoff-running-fixture";

// Codex writes a code-mode script's nested exec_command completions as item_completed CommandExecution records that name no
// script. When scripts overlap (parallel exec cells, or a yielded cell still running while a newer script runs), a completion
// cannot be credited to one of them: crediting the newest script made false "completion not observed" leftovers for the
// others (ACK work, a revision and an archived ledger version at the turn end) and hid a newer script's still-running command
// behind an older cell's completion (SESSION-HANDOFF-SPEC §5.7). Synthetic rollouts in temporary directories only.
afterEach(async () => { await cleanupObserverFixtures(); await cleanupRunningFixtures(); });

const script = (id: string, cmd: string) => codexResponse("custom_tool_call", { call_id: id, id: `ctc_${id}`, status: "completed", name: "exec", input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)} }); text(r);` });
const out = (id: string, header = "Script completed") => codexResponse("custom_tool_call_output", { call_id: id, output: [{ type: "input_text", text: `${header}\nWall time 0.5 seconds\nOutput:\n` }, { type: "input_text", text: "ok" }] });
const done = (pid: number, cmd: string) => codexEvent("item_completed", { thread_id: fixtureUuid, turn_id: "t", item: { type: "CommandExecution", id: `ce-${pid}`, command: ["bash", "-lc", cmd], process_id: pid, exit_code: 0, aggregated_output: "ok" } });
const wait = (id: string, cell: number, terminate = false) => codexResponse("function_call", { name: "wait", call_id: id, arguments: JSON.stringify({ cell_id: cell, yield_time_ms: 30000, ...(terminate ? { terminate: true } : {}) }) });
const waited = (id: string, output = "Script completed\nWall time 31 seconds\nOutput:\n") => codexResponse("function_call_output", { call_id: id, output });
/** A script that calls no exec_command and yields (a watcher). */
const watcher = (id: string) => codexResponse("custom_tool_call", { call_id: id, id: `ctc_${id}`, status: "completed", name: "exec", input: `text("watching"); await new Promise((r) => setTimeout(r, 600000));` });
const items = (record: CardHandoff) => record.ledger.flatMap((session) => session.background).map((entry) => `${entry.status}:${entry.ref}:${entry.label}`);

test("two overlapping scripts whose commands both finished leave nothing behind, during the turn or after it", async () => {
  const x = await observerFixture({ running: true }); await x.poll();
  await x.append([script("s1", "npm test"), script("s2", "git status")]); await x.poll();
  await x.append([done(7001, "npm test"), out("s1"), done(7002, "git status"), out("s2")]); await x.poll();
  expect(items(await x.read())).toEqual([]);
  Object.assign(x.actor, { status: "idle", activeTurn: null }); await x.poll();
  const record = await x.read();
  expect([items(record), handoffOpenIds(record)]).toEqual([[], []]);
  // The same records one script after the other (the control) were already right.
  const y = await observerFixture({ running: true }); await y.poll();
  await y.append([script("s1", "npm test"), done(7001, "npm test"), out("s1"), script("s2", "git status"), done(7002, "git status"), out("s2")]); await y.poll();
  Object.assign(y.actor, { status: "idle", activeTurn: null }); await y.poll();
  expect(handoffOpenIds(await y.read())).toEqual([]);
});

test("a yielded cell's completion does not hide a newer script's command that is still running", async () => {
  const x = await observerFixture({ running: true }); await x.poll();
  await x.append([script("s1", "npm test"), out("s1", "Script running with cell ID 7"), script("s2", "npm run dev")]); await x.poll();
  await x.append([done(7001, "npm test"), out("s2")]); await x.poll();
  const placeholder = "unknown:unknown:s1:exec:exec_command in a script; completion not observed";
  expect(items(await x.read())).toEqual(["open:cell:7:script cell 7 still running", placeholder]);
  Object.assign(x.actor, { status: "idle", activeTurn: null }); await x.poll();
  const over = await x.read();
  expect(handoffOpenIds(over)).toHaveLength(2);
  // The cell finishes in a later turn: one of the two commands is still unaccounted for, so the placeholder stays.
  Object.assign(x.actor, { status: "running", activeTurn: { turnId: "turn-2", startedAt: "2026-10-25T02:10:00.000Z" } });
  await x.append([wait("w1", 7), waited("w1")]); await x.poll();
  expect(items(await x.read())).toEqual(["closed:cell:7:script cell 7 still running", placeholder]);
});

test("once every command of the overlapping scripts is accounted for, the placeholder an earlier return needed is withdrawn", async () => {
  const x = await observerFixture({ running: true }); await x.poll();
  await x.append([script("s1", "npm test"), out("s1", "Script running with cell ID 7"), script("s2", "npm run build")]); await x.poll();
  await x.append([done(7001, "npm test"), out("s2")]); await x.poll();
  expect(items(await x.read())).toHaveLength(2);
  await x.append([done(7002, "npm run build"), wait("w1", 7), waited("w1")]); await x.poll();
  Object.assign(x.actor, { status: "idle", activeTurn: null }); await x.poll();
  const record = await x.read();
  expect([items(record), handoffOpenIds(record)]).toEqual([[], []]); // the cell ended in the turn that started it: dropped, as any such exec session
});

test("terminating a yielded cell keeps an overlapping script's dev server, in either order", async () => {
  // The cell's own completion was already counted for the pool; its calls claim it as while it ran, and are not subtracted twice.
  const placeholder = (call: string) => `unknown:unknown:${call}:exec:exec_command in a script; completion not observed`;
  for (const [first, records] of [
    ["s2", [script("s2", "npm run dev"), script("s1", "npm run build"), done(7001, "npm run build"), out("s1", "Script running with cell ID 7"), out("s2")]],
    ["s1", [script("s1", "npm run build"), out("s1", "Script running with cell ID 7"), script("s2", "npm run dev"), done(7001, "npm run build"), out("s2")]],
  ] as const) {
    const x = await observerFixture({ running: true }); await x.poll();
    await x.append([...records]); await x.poll();
    expect(items(await x.read())).toEqual(["open:cell:7:script cell 7 still running", placeholder(first)]);
    await x.append([wait("w1", 7, true), waited("w1", "Script terminated\nWall time 2 seconds\nOutput:\n")]); await x.poll();
    expect(items(await x.read())).toEqual([placeholder(first)]); // the cell ended in the turn that started it: dropped
    Object.assign(x.actor, { status: "idle", activeTurn: null }); await x.poll();
    const over = await x.read();
    expect(items(over)).toEqual([placeholder(first)]);
    expect(handoffOpenIds(over)).toHaveLength(1);
  }
});

test("a terminated cell's sub-agent start still claims the start it received: an overlapping script's unobserved spawn stays", async () => {
  const spawn = (id: string, name: string) => codexResponse("custom_tool_call", { call_id: id, id: `ctc_${id}`, status: "completed", name: "exec", input: `await tools.spawn_agent({ task_name: ${JSON.stringify(name)}, message: "check the build" }); text("ok");` });
  const started = codexItem({ type: "SubAgentActivity", id: "sa-a-started", agent_path: "/root/a", agent_thread_id: "019a15e5-1111-7abc-8def-0123456789ab", kind: "started" });
  const placeholder = "unknown:unknown:s1:spawn_agent:spawn_agent called in a script; result not observed";
  const x = await observerFixture({ running: true }); await x.poll();
  await x.append([spawn("s1", "a"), out("s1", "Script running with cell ID 7"), spawn("s2", "b"), started, out("s2")]); await x.poll();
  expect(items(await x.read())).toEqual(["open:cell:7:script cell 7 still running", "open:/root/a:a: sub-agent", placeholder]);
  await x.append([wait("w1", 7, true), waited("w1", "Script terminated\nWall time 2 seconds\nOutput:\n")]); await x.poll();
  Object.assign(x.actor, { status: "idle", activeTurn: null }); await x.poll();
  expect(items(await x.read())).toEqual(["open:/root/a:a: sub-agent", placeholder]);
});

test("a placeholder that became history while its pool outlived the turn stays open through a later dip in the count", async () => {
  // Turn 2's completions arrive before its scripts return, so the count dips at the first return and comes back at the second.
  const placeholder = "unknown:unknown:s1:exec:exec_command in a script; completion not observed";
  const turn2 = (x: Awaited<ReturnType<typeof observerFixture>>) => Object.assign(x.actor, { status: "running", activeTurn: { turnId: "turn-2", startedAt: "2026-10-25T02:10:00.000Z" } });
  const idle = (x: Awaited<ReturnType<typeof observerFixture>>) => Object.assign(x.actor, { status: "idle", activeTurn: null });
  // The cell runs no command; the dev server started next to it never completes.
  const x = await observerFixture({ running: true }); await x.poll();
  await x.append([watcher("s1"), out("s1", "Script running with cell ID 7"), script("s2", "npm run dev"), out("s2")]); await x.poll();
  idle(x); await x.poll();
  const first = await x.read();
  expect(items(first)).toEqual(["open:cell:7:script cell 7 still running", placeholder]);
  expect(handoffOpenIds(first)).toHaveLength(2);
  turn2(x);
  await x.append([script("s3", "npm test"), script("s4", "git status"), done(7003, "npm test"), done(7004, "git status"), out("s3"), out("s4")]); await x.poll();
  idle(x); await x.poll();
  const second = await x.read();
  expect(items(second)).toEqual(["open:cell:7:script cell 7 still running", placeholder]);
  expect(handoffOpenIds(second)).toEqual(handoffOpenIds(first));
  // The cell runs the build, which completes; the dip is seen by a poll between the two returns; the cell ends in turn 2.
  const y = await observerFixture({ running: true }); await y.poll();
  await y.append([script("s1", "npm run build"), out("s1", "Script running with cell ID 7"), script("s2", "npm run dev")]); await y.poll();
  await y.append([done(7001, "npm run build"), out("s2")]); await y.poll();
  idle(y); await y.poll();
  expect(handoffOpenIds(await y.read())).toHaveLength(2);
  turn2(y);
  await y.append([script("s3", "npm test"), script("s4", "git status"), done(7003, "npm test"), done(7004, "git status"), out("s3")]); await y.poll();
  expect(items(await y.read())).toContain(placeholder);
  await y.append([out("s4")]); await y.poll();
  await y.append([wait("w1", 7), waited("w1")]); await y.poll();
  idle(y); await y.poll();
  const ended = await y.read();
  expect(items(ended)).toEqual(["closed:cell:7:script cell 7 still running", placeholder]);
  expect(handoffOpenIds(ended)).toHaveLength(1);
  // Read in one batch after the turn: the placeholder is history from the start, never transient.
  const z = await observerFixture(); await z.poll();
  await z.append([watcher("s1"), out("s1", "Script running with cell ID 7"), script("s2", "npm run dev"), out("s2"), script("s3", "npm test"), script("s4", "git status"), done(7003, "npm test"), done(7004, "git status"), out("s3"), out("s4")]); await z.poll();
  expect(items(await z.read())).toEqual(["open:cell:7:script cell 7 still running", placeholder]);
});

test("a settled placeholder a running pool no longer needed closes once the last member returns with the exact count", async () => {
  // The dev server's command did complete, but only after turn 1 ended; the count is exact when the cell ends.
  const x = await observerFixture({ running: true }); await x.poll();
  await x.append([watcher("s1"), out("s1", "Script running with cell ID 7"), script("s2", "npm run dev"), out("s2")]); await x.poll();
  Object.assign(x.actor, { status: "idle", activeTurn: null }); await x.poll();
  expect(handoffOpenIds(await x.read())).toHaveLength(2);
  Object.assign(x.actor, { status: "running", activeTurn: { turnId: "turn-2", startedAt: "2026-10-25T02:10:00.000Z" } });
  await x.append([script("s3", "npm test"), done(7002, "npm run dev"), done(7003, "npm test"), out("s3")]); await x.poll();
  await x.append([wait("w1", 7), waited("w1")]); await x.poll();
  Object.assign(x.actor, { status: "idle", activeTurn: null }); await x.poll();
  const record = await x.read();
  expect(items(record)).toEqual(["closed:cell:7:script cell 7 still running", "closed:unknown:s1:exec:exec_command in a script; completion not observed"]);
  expect(handoffOpenIds(record)).toEqual([]);
});

// A top-level call's completion item repeats the call's own id (checked on local rollouts: function_call, then item_completed
// with that id, then its output, for exec_command, MCP tools and spawn_agent); a script's nested items have ids of their own.
const topCall = (id: string, name: string, args: Record<string, unknown>, namespace?: string) => codexResponse("function_call", { name, call_id: id, arguments: JSON.stringify(args), ...(namespace ? { namespace } : {}) });
const topOut = (id: string, output: string) => codexResponse("function_call_output", { call_id: id, output });
const topCommand = (id: string, pid: number, cmd: string) => [topCall(id, "exec_command", { cmd }), codexItem({ type: "CommandExecution", id, command: ["/bin/zsh", "-lc", cmd], process_id: String(pid), status: "completed", exit_code: 0, aggregated_output: "ok" }), topOut(id, "Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nok")];
const devPlaceholder = "unknown:unknown:s1:exec:exec_command in a script; completion not observed";

test("a top-level exec_command that finishes while a yielded cell runs is no completion of the cell's pool: the dev server's placeholder stays", async () => {
  const idle = (x: Awaited<ReturnType<typeof observerFixture>>) => Object.assign(x.actor, { status: "idle", activeTurn: null });
  // The control: the same records without the top-level git status.
  const control = await observerFixture({ running: true }); await control.poll();
  await control.append([watcher("s1"), out("s1", "Script running with cell ID 7"), script("s2", "npm run dev"), out("s2")]); await control.poll();
  await control.append([wait("w1", 7), waited("w1")]); await control.poll();
  idle(control); await control.poll();
  const expected = await control.read();
  expect(items(expected)).toEqual([devPlaceholder]);
  // The cell returns in the same turn.
  const x = await observerFixture({ running: true }); await x.poll();
  await x.append([watcher("s1"), out("s1", "Script running with cell ID 7"), script("s2", "npm run dev"), out("s2")]); await x.poll();
  await x.append(topCommand("c1", 9001, "git status")); await x.poll();
  expect(items(await x.read())).toEqual(["open:cell:7:script cell 7 still running", devPlaceholder]);
  await x.append([wait("w1", 7), waited("w1")]); await x.poll();
  idle(x); await x.poll();
  const over = await x.read();
  expect([items(over), handoffOpenIds(over)]).toEqual([[devPlaceholder], handoffOpenIds(expected)]);
  // The cell is still running at the turn end and returns in a later turn: the placeholder stays the ACK id it was.
  const y = await observerFixture({ running: true }); await y.poll();
  await y.append([watcher("s1"), out("s1", "Script running with cell ID 7"), script("s2", "npm run dev"), out("s2")]); await y.poll();
  await y.append(topCommand("c1", 9001, "git status")); await y.poll();
  idle(y); await y.poll();
  const first = await y.read();
  expect(handoffOpenIds(first)).toHaveLength(2);
  Object.assign(y.actor, { status: "running", activeTurn: { turnId: "turn-2", startedAt: "2026-10-25T02:10:00.000Z" } });
  await y.append([...topCommand("c2", 9002, "git diff --stat"), wait("w1", 7), waited("w1")]); await y.poll();
  idle(y); await y.poll();
  const second = await y.read();
  expect(items(second)).toEqual(["closed:cell:7:script cell 7 still running", devPlaceholder]);
  expect(handoffOpenIds(second)).toEqual(handoffOpenIds(expected));
  expect(handoffOpenIds(first)).toContain(handoffOpenIds(expected)[0]);
});

test("a top-level MCP start or sub-agent spawn while a yielded cell runs keeps a script's unobserved start of the same tool", async () => {
  const create = codexResponse("custom_tool_call", { call_id: "s2", id: "ctc_s2", status: "completed", name: "exec", input: `await tools.paseo__create_agent({ title: "helper" }); text("ok");` });
  const spawn = codexResponse("custom_tool_call", { call_id: "s3", id: "ctc_s3", status: "completed", name: "exec", input: `await tools.spawn_agent({ task_name: "a", message: "check the build" }); text("ok");` });
  const created = { content: [{ type: "text", text: "{\"agentId\":\"agent-9\"}" }], structuredContent: { agentId: "agent-9" } };
  const x = await observerFixture({ running: true }); await x.poll();
  await x.append([watcher("s1"), out("s1", "Script running with cell ID 7"), create, out("s2"), spawn, out("s3")]); await x.poll();
  const placeholders = ["unknown:unknown:s1:create_agent:create_agent called in a script; result not observed", "unknown:unknown:s1:spawn_agent:spawn_agent called in a script; result not observed"];
  expect(items(await x.read())).toEqual(["open:cell:7:script cell 7 still running", ...placeholders]);
  await x.append([
    topCall("c1", "create_agent", { title: "reviewer" }, "mcp__paseo"), codexItem({ type: "McpToolCall", id: "c1", server: "paseo", tool: "create_agent", status: "completed", arguments: { title: "reviewer" }, result: created }), topOut("c1", "{\"agentId\":\"agent-9\"}"),
    topCall("c2", "spawn_agent", { task_name: "b", message: "review the diff" }), codexItem({ type: "SubAgentActivity", id: "c2", agent_path: "/root/b", agent_thread_id: "019a15e5-1111-7abc-8def-0123456789ab", kind: "started" }), topOut("c2", "{\"task_name\":\"/root/b\"}"),
  ]); await x.poll();
  await x.append([wait("w1", 7), waited("w1")]); await x.poll();
  Object.assign(x.actor, { status: "idle", activeTurn: null }); await x.poll();
  const over = await x.read();
  expect(items(over).filter((item) => item.includes("called in a script"))).toEqual(placeholders);
  expect(items(over)).toEqual(expect.arrayContaining(["open:agent-9:reviewer", "open:/root/b:b: review the diff"]));
});

test("twenty scripts started at once, all of whose commands exit 0, leave no leftover, revision or ledger version", async () => {
  const x = await handedOver({ notes: 30 });
  expect((await fullRead(x)).length).toBeGreaterThan(1);
  const read = await x.read(), archive = async () => (await readFile(x.archive, "utf8").catch(() => "")).split("\n").filter((line) => line.includes("\"ledger\"")).length;
  const archived = await archive();
  const stamp = () => new Date(x.now()).toISOString(), at = <T extends Record<string, unknown>>(value: T) => ({ ...value, timestamp: stamp() });
  await x.raw(Array.from({ length: 20 }, (_, n) => at(script(`sc-${n}`, `npm run check -- --shard ${n}`))));
  for (let minute = 0; minute < 5; minute++) await x.minute();
  for (let n = 0; n < 20; n += 4) {
    await x.raw(Array.from({ length: 4 }, (_, k) => [at(done(9000 + n + k, `npm run check -- --shard ${n + k}`)), at(out(`sc-${n + k}`))]).flat());
    await x.minute();
  }
  const during = await x.read();
  expect(items(during).filter((item) => item.includes("completion not observed"))).toEqual([]);
  x.turn(false); await x.minute(); await x.minute();
  const after = await x.read();
  expect(items(after).filter((item) => item.includes("completion not observed"))).toEqual([]);
  expect(handoffOpenIds(after)).toEqual(handoffOpenIds(read));
  expect(after.revision).toBe(read.revision); expect(await archive()).toBe(archived);
}, 60_000); // production wiring with real Git, like the other handedOver tests
