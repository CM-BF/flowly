import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { AutomationService } from "./automation";
import { cleanupRunningFixtures, fullRead, handedOver } from "./handoff-running-fixture";

// A quiet stretch of a running turn (a long build or test run that prints nothing): the observer's 60-second passes see the
// session still running and nothing new in its provider file. They write nothing at all, so the successor's prepared ACK
// and full read stay valid, and the turn's proven active time (SESSION-HANDOFF-SPEC §21.1) still counts up to the last pass
// that saw it running. Production wiring on synthetic Codex rollouts and a real Git repository (handoff-running-fixture.ts).
const dispatchers: AutomationService[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dispatchers.splice(0).map((automation) => automation.stop())); await cleanupRunningFixtures(); });

/** Every byte Flowly owns in the data directory (board.json, handoff records, archives, receipts), by path. */
async function bytes(directory: string) {
  const out: Record<string, string> = {};
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (["homes", "repos"].includes(relative(directory, child))) continue;
      if (entry.isDirectory()) await walk(child); else out[relative(directory, child)] = createHash("sha256").update(await readFile(child)).digest("hex");
    }
  };
  await walk(directory); return out;
}

test("a quiet running turn writes nothing: the prepared ACK applies and the turn's proven active time still counts", async () => {
  const failures = vi.spyOn(console, "error");
  const x = await handedOver({ notes: 6 });
  // The automation dispatcher (15-second passes, its minute watch of a running session) with the observer as its bridge.
  const measured: string[] = [], bridge = { ...x.observer.bridge, measure: async (input: { taskId: string; agentId: string }) => { measured.push(input.agentId); return x.observer.bridge.measure!(input); } };
  const automation = new AutomationService(x.board, { prepare: async () => { throw new Error("a running card starts no session"); }, globalModel: async () => null, clock: x.now, historyBytes: async () => 4096, handoff: bridge });
  dispatchers.push(automation); automation.attach(x.paseo);
  const pass = async () => { for (let n = 0; n < 4; n++) { x.advance(15_000); await automation.kick(); } await x.observer.poll(x.managed); };
  // The successor reads the whole record inside its running turn (each page a tool call its rollout records) and is observed.
  const pages = await fullRead(x, pass);
  await pass();
  const ids = [...new Set(pages.flatMap((page) => page.openIds))], revision = (await x.read()).revision;
  expect(pages.at(-1)!.complete).toBe(true); expect(pages[0].revision).toBe(revision);
  // The dispatcher's minute watch really measured the running session (its samples stay in memory below 64 MiB).
  expect(measured).toContain("succ");
  const watched = measured.length;
  // Then a long command without output: 15 minutes of passes see the turn running and no new provider data.
  const before = await bytes(x.directory);
  for (let minute = 0; minute < 15; minute++) await pass();
  expect(await bytes(x.directory)).toEqual(before);
  expect((await x.read()).revision).toBe(revision);
  expect(measured.length).toBeGreaterThanOrEqual(watched + 15);
  const lastRunningPass = x.now();
  const result = await x.handoffs.update(x.identity, { handoffRevision: pages[0].revision, ack: { handoffRevision: pages[0].revision, heads: await x.heads(), understanding: "Read every page; heads verified.", items: ids.map((id) => ({ id, disposition: "doing" as const })) } });
  expect(result).toMatchObject({ ok: true, handoffRevision: revision + 1 }); expect(result.ackMissing).toBeUndefined();
  // The turn ends: one pass sees the session idle, then the turn-end hook arrives. Its active time runs from the turn's
  // start to the last pass that saw it running, which those quiet passes held in memory without writing it.
  x.turn(false); await x.minute();
  await x.observer.observe("card", "succ", { timeline: [{ type: "assistant_message", text: "Build finished." }], outcome: "completed" });
  const facts = await x.observer.measure({ taskId: "card", agentId: "succ" });
  expect(facts.completedTurns).toBe(1);
  expect(facts.activeMs).toBe(lastRunningPass - Date.parse("2026-10-25T02:00:00.000Z"));
  expect(failures).not.toHaveBeenCalled();
}, 60_000);
