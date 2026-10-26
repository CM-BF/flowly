import { afterEach, expect, test, vi } from "vitest";
import { join } from "node:path";
import { HandoffStore } from "./handoff-store";
import { bodyReferences, tree } from "./handoff-collect-fixture";
import { cleanupRunningFixtures, fullRead, handedOver, type RunningCard } from "./handoff-running-fixture";

// A running turn with new provider data every minute (SESSION-HANDOFF-SPEC §5.1): each observer pass stores its observation
// in place, and that is one write of the card's observation file. No entry body, pointer or unfinished-write file is written for it, so
// nothing is left in entries/ that no record, archive line, seal or pointer references; the turn's end is a revision, and
// its write removes the bodies it superseded. Production wiring on synthetic Codex rollouts and a real Git repository.
const fsCalls = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // Every rename (the last step of each atomic write) and every unlink, by path.
  return { ...actual, rename: async (from: string, to: string) => { fsCalls.push(`rename ${to}`); return actual.rename(from, to); }, unlink: async (path: string) => { fsCalls.push(`unlink ${path}`); return actual.unlink(path); } };
});
afterEach(async () => { vi.restoreAllMocks(); await cleanupRunningFixtures(); });

/** One minute of work in the successor's turn: a command and its output (and every fifth minute a line of narration), then an observer pass. */
async function busyMinute(x: RunningCard, minute: number) {
  const timestamp = new Date(x.now()).toISOString(), call = `busy-call-${minute}`;
  await x.raw([{ timestamp, type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: call, arguments: JSON.stringify({ cmd: `npm test -- --shard ${minute}/60` }) } },
    { timestamp, type: "response_item", payload: { type: "function_call_output", call_id: call, output: `Process exited with code 0\nOutput:\n${"ok\n".repeat(40)}` } },
    ...(minute % 5 ? [] : [{ timestamp, type: "event_msg", payload: { type: "agent_message", message: `Shard ${minute} passed; continuing with the next ones.` } }])]);
  await x.minute();
}
const handoffWrites = (x: RunningCard) => fsCalls.filter((call) => call.includes(join(x.directory, "handoffs"))).map((call) => call.replace(x.directory + "/", ""));

test("a 60-minute running turn writes only the card's observation file once a minute and leaves no unreferenced bodies; its end removes what it superseded", async () => {
  const failures = vi.spyOn(console, "error");
  const x = await handedOver({ notes: 6 });
  const folder = join(x.directory, "handoffs", "card"), handoffs = join(x.directory, "handoffs");
  // The successor's own full read at the start of its turn: its pages and the passes between them are in-place observation.
  const pages = await fullRead(x, async () => { await x.minute(); });
  expect(pages.at(-1)!.complete).toBe(true);
  // Everything under handoffs/card/ but the observation file (and the folder's own times, which a rename into it moves).
  const kept = async () => { const files = await tree(folder); delete files["."]; delete files["observation.json"]; return files; };
  const revision = (await x.read()).revision, before = await kept(), card = await tree(x.file), bodies = (await bodyReferences(handoffs)).bodies;
  for (let minute = 1; minute <= 60; minute++) {
    fsCalls.length = 0;
    await busyMinute(x, minute);
    // One write of the observation file; not the card file, no body, no pointer, no unfinished-write file, nothing removed.
    expect(handoffWrites(x)).toEqual(["rename handoffs/card/observation.json"]);
    expect(await kept()).toEqual(before); expect(await tree(x.file)).toEqual(card);
    const references = await bodyReferences(handoffs);
    expect(references.unreferenced).toEqual([]); expect(references.missing).toEqual([]);
  }
  const running = await x.read();
  expect(running.revision).toBe(revision);
  expect(running.ledger.find((session) => session.agentId === "succ")!.through!.offset).toBeGreaterThan(0);
  expect((await bodyReferences(handoffs)).bodies).toEqual(bodies);
  // The turn ends: one pass sees the session idle, then the hook. Those are revisions; each removes the bodies it superseded.
  x.turn(false); await x.minute();
  await x.observer.observe("card", "succ", { timeline: [{ type: "assistant_message", text: "All 60 shards pass." }], outcome: "completed" });
  const ended = await x.read(), after = await bodyReferences(handoffs);
  expect(ended.revision).toBeGreaterThan(revision);
  expect(ended.ledger.find((session) => session.agentId === "succ")!.turns.at(-1)).toMatchObject({ final: "All 60 shards pass." });
  expect(after.unreferenced).toEqual([]); expect(after.missing).toEqual([]);
  expect(handoffWrites(x).filter((call) => call.startsWith("unlink handoffs/card/entries/")).length).toBeGreaterThan(0);
  // What the successor reads next is all there: every page of a new full read completes.
  const reread = await fullRead(x);
  expect(reread.at(-1)!.complete).toBe(true);
  expect(failures).not.toHaveBeenCalled();
}, 120_000);

test("a reader paging archived versions keeps every page through a plugin restart's collection and the turn's revisions", async () => {
  // 104 notes: the four oldest are archived (the cap is 100), so the full read pages through archive lines and their bodies.
  const x = await handedOver({ notes: 104 });
  const handoffs = join(x.directory, "handoffs");
  const first = await fullRead(x, async () => { await busyMinute(x, 0); });
  const archived = first.flatMap((page) => page.items).filter((item) => item.origin === "archive");
  expect(archived.length).toBeGreaterThanOrEqual(4);
  // A second read starts; between its pages the turn goes on, and the plugin restarts (a new store collects at first touch).
  let restarted: HandoffStore | undefined, cursor: string | undefined;
  const items: unknown[] = [];
  for (let n = 0; ; n++) {
    const page = await (restarted ?? x.handoffs.records).page("card", cursor ? { cursor } : { scope: "all" });
    expect(page.viewChanged).toBeUndefined();
    items.push(...page.items.filter((item) => item.origin === "archive"));
    if (page.complete) break;
    cursor = page.nextCursor;
    await busyMinute(x, n + 1);
    if (n === 1) restarted = new HandoffStore(x.directory);
  }
  expect(items).toEqual(archived);
  // The turn ends (revisions that collect); the archived versions are still read in full.
  x.turn(false); await x.minute();
  await x.observer.observe("card", "succ", { timeline: [{ type: "assistant_message", text: "Done." }], outcome: "completed" });
  const after = await bodyReferences(handoffs);
  expect(after.unreferenced).toEqual([]); expect(after.missing).toEqual([]);
  // (The turn's end may archive more notes; every version archived before is still among them.)
  const reread = (await fullRead(x)).flatMap((page) => page.items).filter((item) => item.origin === "archive" && item.section === "notes");
  expect(reread).toEqual(expect.arrayContaining(archived.filter((item) => item.section === "notes")));
}, 120_000);
