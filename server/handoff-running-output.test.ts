import { afterEach, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { handoffOpenIds } from "../shared/handoff";
import { claudeBase, cleanupObserverFixtures, observerFixture, successorView } from "./handoff-observer-fixture";
import { cleanupRunningFixtures, fullRead, handedOver, type RunningCard } from "./handoff-running-fixture";

// The successor's own work during its running turn: tool output too long to read (a line over 256 KiB), and short-lived
// exec sessions it starts and waits on. Neither may move the revision its full read and its ACK pin; both surface once the
// turn is over (SESSION-HANDOFF-SPEC §5.1, §5.7, §7.5). Production wiring, synthetic Codex rollouts, a real Git repository.
afterEach(cleanupRunningFixtures);
afterEach(cleanupObserverFixtures);

const longOutput = (text: string) => `Process exited with code 0\nOutput:\n${text.repeat(Math.ceil(300_000 / text.length))}`.slice(0, 300_000);
/** Current Codex code mode: an `exec` script, the nested command's CommandExecution item and the script's output, both long. */
async function script(x: RunningCard, n: number, cmd: string) {
  const stamp = new Date(x.now()).toISOString(), output = longOutput("✓ server/handoff-store.test.ts > a passing test with a long name (12 ms)\n");
  await x.raw([
    { timestamp: stamp, type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: `script-${n}`, input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)} }); text(r.output);` } },
    { timestamp: stamp, type: "event_msg", payload: { type: "item_completed", thread_id: "t", turn_id: "succ-turn-1", item: { type: "CommandExecution", id: `cmd-${n}`, command: ["/bin/zsh", "-lc", cmd], process_id: String(90000 + n), status: "completed", exit_code: 0, aggregated_output: output } } },
    { timestamp: stamp, type: "response_item", payload: { type: "custom_tool_call_output", call_id: `script-${n}`, output: [{ type: "input_text", text: `Script completed\nWall time 41.2 seconds\nOutput:\n${output}` }] } },
  ]);
}
const ownGaps = async (x: RunningCard) => (await x.read()).gaps.filter((gap) => gap.text.startsWith("Capture gap (long_line)"));
const ack = (x: RunningCard, revision: number, ids: string[], disposition: "doing" | "done" = "doing") => x.heads().then((heads) => x.handoffs.update(x.identity, { handoffRevision: revision, ack: { handoffRevision: revision, heads, understanding: "Read every page.", items: ids.map((id) => ({ id, disposition, ...(disposition === "done" ? { note: "Checked; my own output." } : {}) })) } }));
const archivedLedger = async (x: RunningCard) => (await readFile(x.archive, "utf8").catch(() => "")).split("\n").filter(Boolean).filter((line) => JSON.parse(line).section === "ledger").length;

test("the successor's own outputs over 256 KiB between every page and before its ACK: every page completes, the ACK applies, the gaps come at its turn end", async () => {
  const x = await handedOver();
  const before = await x.read();
  let n = 0;
  const pages = await fullRead(x, async () => {
    await x.tool("exec_command", { cmd: "npm test -- --reporter verbose" }, longOutput("✓ server/some.test.ts > a passing test with a long name 12ms\n"));
    await script(x, ++n, "npm test");
    await x.minute();
  });
  expect(pages.length).toBeGreaterThanOrEqual(3);
  expect(pages.map((page) => [page.revision, !!page.viewChanged])).toEqual(pages.map(() => [before.revision, false]));
  expect(pages.at(-1)!.complete).toBe(true);
  await x.tool("exec_command", { cmd: "git log -p -5" }, longOutput("+ a line of the diff\n")); await x.minute();
  const result = await ack(x, before.revision, [...new Set(pages.flatMap((page) => page.openIds))]);
  expect(result).toMatchObject({ ok: true, handoffRevision: before.revision + 1 }); expect(result.ackMissing).toBeUndefined();
  // While the turn runs the outputs are counted in the session's coverage text, not gaps yet.
  const running = await x.read();
  expect(await ownGaps(x)).toEqual([]);
  expect(running.ledger.find((session) => session.agentId === "succ")!.skeleton).toMatch(/\d+ records of this running turn .*too long to keep.*capture gap when the turn ends/);
  // The turn ends: each kind of skipped output is one counted, open gap, written with the turn's other history.
  x.turn(false); await x.minute();
  const gaps = await ownGaps(x);
  expect(gaps.map((gap) => [gap.status, gap.count, /\(long_line\): ([^ ]+)/.exec(gap.text)?.[1]]).sort()).toEqual([
    ["open", pages.length - 1, "event_msg/item_completed/CommandExecution"], ["open", pages.length, "response_item/function_call_output"], ["open", pages.length - 1, "response_item/custom_tool_call_output"]].sort());
  expect(gaps.every((gap) => gap.text.includes("(tool output)"))).toBe(true);
  expect((await x.read()).revision).toBe(before.revision + 2);
}, 60_000);

test("a settled tool-output gap is not reopened by the same session's output during its next turn; that turn's end reopens it once", async () => {
  const x = await handedOver({ notes: 5 });
  await x.tool("exec_command", { cmd: "git log -p -5" }, longOutput("+ a line of the diff\n")); await x.minute();
  x.turn(false); await x.minute();
  const pages = await fullRead(x), revision = pages[0].revision;
  expect((await ownGaps(x)).map((gap) => `${gap.status}:${gap.count}`)).toEqual(["open:1"]);
  const settled = await ack(x, revision, [...new Set(pages.flatMap((page) => page.openIds))], "done");
  expect(settled.ackMissing).toBeUndefined();
  x.turn(true);
  for (let n = 0; n < 2; n++) { await x.tool("exec_command", { cmd: "npm test" }, longOutput("✓ a passing test\n")); await x.minute(); }
  expect((await x.read()).revision).toBe(settled.handoffRevision);
  expect((await ownGaps(x)).map((gap) => `${gap.status}:${gap.count}`)).toEqual(["closed:1"]);
  x.turn(false); await x.minute();
  expect((await ownGaps(x)).map((gap) => `${gap.status}:${gap.count}`)).toEqual(["open:3"]);
  expect((await x.read()).revision).toBe(settled.handoffRevision + 1);
}, 60_000);

test("output still held when its session is sealed is a gap in the sealed record", async () => {
  const x = await handedOver({ notes: 5 });
  await x.tool("exec_command", { cmd: "npm test" }, longOutput("✓ a passing test\n")); await x.minute();
  expect(await ownGaps(x)).toEqual([]);
  const sealed = await x.observer.bridge.seal({ taskId: "card", rotationId: "rotation:running", role: "implementer", fromAgentId: "succ", reason: "run_again", allowFinalize: false, carry: { id: "instruction", role: "implementer", text: "Continue", fresh: "Continue", kind: "again" } });
  expect((await ownGaps(x)).map((gap) => `${gap.status}:${gap.count}`)).toEqual(["open:1"]);
  expect(sealed.prompt).toContain("Capture gap (long_line): response_item/function_call_output (tool output)");
}, 60_000);

test("30 yielded commands waited on with write_stdin during the successor's read and ACK: no revision, no archived ledger version, no closed exec item stays", async () => {
  const x = await handedOver();
  const before = await x.read(), archived = await archivedLedger(x);
  let session = 8000;
  const command = async () => {
    session++;
    await x.tool("exec_command", { cmd: `npm test -- shard ${session}`, yield_time_ms: 10000 }, `Process running with session ID ${session}\nOutput:\n`);
    for (let wait = 0; wait < 2; wait++) { await x.minute(); await x.tool("write_stdin", { session_id: session, chars: "", yield_time_ms: 30000 }, `Process running with session ID ${session}\nOutput:\n${wait * 40} tests passed\n`); }
    await x.minute();
    await x.tool("write_stdin", { session_id: session, chars: "", yield_time_ms: 30000 }, "Process exited with code 0\nOutput:\nall tests passed\n");
  };
  const pages = await fullRead(x, async () => { for (let n = 0; n < 10; n++) await command(); await x.minute(); });
  while (session < 8030) await command();
  await x.minute();
  expect(pages.at(-1)!.complete).toBe(true);
  expect(pages.every((page) => page.revision === before.revision && !page.viewChanged)).toBe(true);
  expect(await archivedLedger(x)).toBe(archived);
  expect((await x.read()).ledger.find((entry) => entry.agentId === "succ")!.background).toEqual([]);
  const result = await ack(x, before.revision, [...new Set(pages.flatMap((page) => page.openIds))]);
  expect(result).toMatchObject({ ok: true, handoffRevision: before.revision + 1 }); expect(result.ackMissing).toBeUndefined();
  // A server it starts and that still runs is on the card at once, and open work once the turn is over.
  await x.tool("exec_command", { cmd: "npm run dev" }, "Process running with session ID 9001\nOutput:\nlistening on 4100\n"); await x.minute();
  let record = await x.read();
  expect(record.ledger.find((entry) => entry.agentId === "succ")!.background).toEqual([expect.objectContaining({ ref: "9001", status: "open", label: "npm run dev" })]);
  const server = record.ledger.find((entry) => entry.agentId === "succ")!.background[0].id;
  expect(record.revision).toBe(before.revision + 1);
  expect(handoffOpenIds(record)).not.toContain(server);
  x.turn(false); await x.minute();
  record = await x.read();
  expect(handoffOpenIds(record)).toContain(server);
  expect(record.revision).toBe(before.revision + 2);
}, 120_000);

test("a command whose output is too long to read still ends: its exit header settles the call and the session it polls", async () => {
  const x = await handedOver({ notes: 5 });
  await x.tool("exec_command", { cmd: "npm test", yield_time_ms: 10000 }, "Process running with session ID 8101\nOutput:\n"); await x.minute();
  await x.tool("write_stdin", { session_id: 8101, chars: "", yield_time_ms: 30000 }, longOutput("✗ a failing test\n").replace("code 0", "code 1")); await x.minute();
  await x.tool("exec_command", { cmd: "npm run lint" }, longOutput("warning: something\n")); await x.minute();
  x.turn(false); await x.minute();
  const record = await x.read();
  expect(record.ledger.find((entry) => entry.agentId === "succ")!.background).toEqual([]);
  expect((await ownGaps(x)).map((gap) => `${gap.status}:${gap.count}:${/\(long_line\): ([^ ]+)/.exec(gap.text)?.[1]}`)).toEqual(["open:2:response_item/function_call_output"]);
}, 60_000);

test("a write_stdin poll keeps the item's start call: a server from an earlier turn polled in this one writes no revision", async () => {
  const x = await handedOver({ notes: 5 });
  const start = await x.tool("exec_command", { cmd: "npm run dev" }, "Process running with session ID 7001\nOutput:\nlistening on 4100\n"); await x.minute();
  x.turn(false); await x.minute();
  const before = await x.read();
  expect(before.ledger.find((entry) => entry.agentId === "succ")!.background).toEqual([expect.objectContaining({ ref: "7001", status: "open", callId: start })]);
  x.turn(true);
  for (let n = 0; n < 3; n++) { await x.tool("write_stdin", { session_id: 7001, chars: "", yield_time_ms: 1000 }, `Process running with session ID 7001\nOutput:\nGET /health 200 ${n}ms\n`); await x.minute(); }
  const polled = await x.read();
  expect(polled.revision).toBe(before.revision);
  expect(polled.ledger.find((entry) => entry.agentId === "succ")!.background).toEqual([expect.objectContaining({ ref: "7001", status: "open", callId: start, label: "npm run dev" })]);
  // It ends: that is history (the predecessor's turn left it running).
  await x.tool("write_stdin", { session_id: 7001, chars: "\u0003" }, "Process exited with code 130\nOutput:\n"); await x.minute();
  const ended = await x.read();
  expect(ended.revision).toBe(before.revision + 1);
  expect(ended.ledger.find((entry) => entry.agentId === "succ")!.background).toEqual([expect.objectContaining({ ref: "7001", status: "closed", outcome: "exit 130", callId: start })]);
}, 60_000);

test("the turn-end timeline replaying a start does not bring back work that ended within the turn", async () => {
  const x = await observerFixture({ provider: "claude", running: true });
  const monitorInput = { command: "tail -f /tmp/deploy.log", description: "watch the staging deploy", timeout_ms: 1800000 };
  const started = "Monitor started (task bn9u7frii, expires in 30m unless the source ends first). You will be notified on each event.";
  const end = "<task-notification>\n<task-id>bn9u7frii</task-id>\n<status>completed</status>\n<summary>Monitor \"watch the staging deploy\" stream ended</summary>\n<event>deploy exit=0</event>\n</task-notification>";
  await x.append([
    { ...claudeBase, type: "assistant", uuid: "a-mon", message: { id: "r-mon", content: [{ type: "tool_use", id: "toolu_mon1", name: "Monitor", input: monitorInput }] } },
    { ...claudeBase, type: "user", uuid: "u-mon", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mon1", content: started }] } },
  ]);
  await x.poll();
  expect(successorView(await x.read())).toMatchObject({ background: [expect.stringMatching(/^exec_session:open:bn9u7frii:/)], open: 0 });
  await x.append([{ type: "queue-operation", operation: "enqueue", timestamp: claudeBase.timestamp, sessionId: claudeBase.sessionId, content: end }]);
  await x.poll();
  expect(successorView(await x.read())).toMatchObject({ background: [], notes: [expect.stringContaining("Last event: deploy exit=0")], open: 0 });
  // The hook carries the whole in-memory timeline: the Monitor's start row, and here no row for its end.
  x.actor.status = "idle"; x.actor.activeTurn = null;
  const monitorRow = { type: "tool_call", callId: "toolu_mon1", name: "Monitor", status: "completed", error: null, detail: { type: "unknown", input: monitorInput, output: started } };
  await x.hook([monitorRow, { type: "assistant_message", text: "The deploy is out." }]);
  await x.hook([monitorRow, { type: "assistant_message", text: "The deploy is out." }, { type: "assistant_message", text: "Next turn." }]);
  expect(successorView(await x.read())).toMatchObject({ background: [], open: 0 });
  // Nor does a late event of that watch.
  await x.append([{ type: "queue-operation", operation: "enqueue", timestamp: claudeBase.timestamp, sessionId: claudeBase.sessionId, content: "<task-notification>\n<task-id>bn9u7frii</task-id>\n<summary>Monitor event: \"watch the staging deploy\"</summary>\n<event>late</event>\n</task-notification>" }]);
  await x.poll();
  expect(successorView(await x.read())).toMatchObject({ background: [], open: 0 });
});
