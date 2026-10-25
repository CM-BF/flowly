import { afterEach, expect, test } from "vitest";
import { cleanupRunningFixtures, fullRead, handedOver, type RunningCard } from "./handoff-running-fixture";

// The successor's own work during its running turn: tool output too long to read (a line over 256 KiB). It may not move the
// revision its full read and its ACK pin; it surfaces once the turn is over (SESSION-HANDOFF-SPEC §5.1, §5.7, §7.5).
// Production wiring, synthetic Codex rollouts, a real Git repository.
afterEach(cleanupRunningFixtures);

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
