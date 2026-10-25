import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { jobOf } from "../shared/automation";
import { AutomationService } from "./automation";
import { cleanupRunningFixtures, handedOver, type RunningCard } from "./handoff-running-fixture";

// The dispatcher's minute watch of a running implementer (SESSION-HANDOFF-SPEC §5.1, §21.1): a turn that is doing work grows
// its provider history every minute. board.json (1.5 MB on the live board, decoded by the phone at every delta) changes only
// at a turn end, a rotation, or when a record goes stale or fresh again; the minute byte samples stay in memory unless the
// "growing fast enough to reach 200 MiB" reminder can fire (main history at least 64 MiB). Production wiring on synthetic
// Codex rollouts and a real Git repository (handoff-running-fixture.ts); the history size is the dispatcher's own measurement.
const dispatchers: AutomationService[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dispatchers.splice(0).map((automation) => automation.stop())); await cleanupRunningFixtures(); });

const MiB = 2 ** 20;
/** The dispatcher of index.server.ts with the observer as its bridge; `size()` is the running session's history size. */
function dispatcher(x: RunningCard, size: () => number, measured: string[]) {
  const bridge = { ...x.observer.bridge, measure: async (input: { taskId: string; agentId: string }) => { measured.push(input.agentId); return x.observer.bridge.measure!(input); } };
  const automation = new AutomationService(x.board, { prepare: async () => { throw new Error("a running card starts no session"); }, globalModel: async () => null, clock: x.now, historyBytes: async () => size(), handoff: bridge });
  dispatchers.push(automation); automation.attach(x.paseo);
  return automation;
}
/**
 * One active minute: the successor runs a quick command (new provider data for the observer; no new token count, so the
 * one-time 60% context reminder stays out of the picture), then four 15-second dispatcher passes and one observer poll.
 */
async function activeMinute(x: RunningCard, automation: AutomationService, minute: number) {
  const timestamp = new Date(x.now()).toISOString(), call = `watch-call-${minute}`;
  await x.raw([{ timestamp, type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: call, arguments: JSON.stringify({ cmd: `npm test -- --shard ${minute}` }) } },
    { timestamp, type: "response_item", payload: { type: "function_call_output", call_id: call, output: `Process exited with code 0\nOutput:\n${"ok\n".repeat(50)}` } }]);
  for (let n = 0; n < 4; n++) { x.advance(15_000); await automation.kick(); }
  await x.observer.poll(x.managed);
}

test("a running session whose history grows every minute below 64 MiB never rewrites board.json from the minute watch", async () => {
  const failures = vi.spyOn(console, "error");
  const x = await handedOver({ notes: 6 });
  let size = 4096;
  const measured: string[] = [], automation = dispatcher(x, () => size, measured);
  let commits = 0; const prior = x.board.onCommit; x.board.onCommit = () => { commits++; prior?.(); };
  const board = join(x.directory, "board.json"), hash = async () => createHash("sha256").update(await readFile(board)).digest("hex");
  await activeMinute(x, automation, 0); size += 20_000;
  const before = { bytes: await hash(), revision: (await x.board.read()).revision, commits };
  // 30 minutes of work: every minute one more command and 20 KB more history (184 KB to 604 KB).
  for (let minute = 1; minute <= 30; minute++) { await activeMinute(x, automation, minute); size += 20_000; }
  expect({ bytes: await hash(), revision: (await x.board.read()).revision, commits }).toEqual(before);
  // The watch did measure the running session every minute; nothing it saw was a board change.
  expect(measured.filter((agentId) => agentId === "succ").length).toBeGreaterThanOrEqual(30);
  expect(jobOf(await x.board.read(), "card")?.checkpoint).toBeUndefined();
  expect(failures).not.toHaveBeenCalled();
}, 120_000); // production wiring with real Git, like the other handedOver tests

test("above 64 MiB the growth reminder still fires, also when the plugin reloads in the middle of the samples", async () => {
  const reason = "History is growing fast enough to reach 200 MiB within ten minutes.";
  // 20 MiB a minute from 70 MiB: the third sample (110 MiB) projects past 200 MiB within ten minutes; 128 MiB is not reached.
  for (const reload of [false, true]) {
    const x = await handedOver({ notes: 6 });
    let size = 70 * MiB;
    const measured: string[] = [];
    let automation = dispatcher(x, () => size, measured);
    await activeMinute(x, automation, 0); size += 20 * MiB;
    expect(jobOf(await x.board.read(), "card")?.checkpoint).toBeUndefined();
    await activeMinute(x, automation, 1); size += 20 * MiB;
    expect(jobOf(await x.board.read(), "card")?.checkpoint).toBeUndefined();
    if (reload) { await automation.stop(); automation = dispatcher(x, () => size, measured); }
    await activeMinute(x, automation, 2);
    expect(jobOf(await x.board.read(), "card")?.checkpoint).toMatchObject({ agentId: "succ", reason });
    // Once it fired, a fourth sample is no board change.
    const board = join(x.directory, "board.json"), bytes = await readFile(board);
    size += 20 * MiB * 0.25; await activeMinute(x, automation, 3);
    expect((await readFile(board)).equals(bytes)).toBe(true);
  }
}, 120_000);
