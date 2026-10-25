import { afterEach, expect, test, vi } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { cleanupRunningFixtures, handedOver, type RunningCard } from "./handoff-running-fixture";

// What Flowly's own observation writes cost on disk (SESSION-HANDOFF-SPEC §5.1): an in-place write (observation state under
// the same revision) is one atomic replacement of the card's observation file, which holds only what differs from the card
// file, and keeps no unfinished-write record or receipt, whoever calls it. Production wiring on synthetic Codex rollouts and
// a real Git repository (server/handoff-running-fixture.ts).
const { fsCalls, written } = vi.hoisted(() => ({ fsCalls: [] as string[], written: { bytes: 0 } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // Every rename (the last step of each atomic write), by destination, and the bytes of every new file's content.
  const open = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (args[1] === "wx") { const writeFile = handle.writeFile.bind(handle); handle.writeFile = async (data, options) => { written.bytes += Buffer.byteLength(data as string | Buffer); return writeFile(data, options); }; }
    return handle;
  };
  return { ...actual, open, rename: async (from: string, to: string) => { fsCalls.push(`rename ${to}`); return actual.rename(from, to); } };
});
afterEach(async () => { vi.restoreAllMocks(); await cleanupRunningFixtures(); });
const handoffWrites = (x: RunningCard) => fsCalls.filter((call) => call.includes(join(x.directory, "handoffs"))).map((call) => call.replace(x.directory + "/", ""));
const names = (path: string) => readdir(path).catch(() => [] as string[]);

test("a refused update's Git refresh is one in-place write: no unfinished-write record and no receipt nothing can replay", async () => {
  const x = await handedOver({ notes: 6 });
  // The successor's turn is over: an idle card's Git is read at turn ends and handoff writes only.
  x.turn(false); await x.minute();
  const before = await x.read(), ops = join(x.directory, "handoffs", "card", "ops"), receipts = await names(ops);
  for (let n = 0; n < 5; n++) {
    await x.elsewhere(n); // another card's commit in the shared project root
    fsCalls.length = 0;
    await expect(x.handoffs.update(x.identity, { handoffRevision: before.revision + 5, state: "Refused: a revision from the future." })).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    expect(handoffWrites(x)).toEqual(["rename handoffs/card/observation.json"]);
    // The reread the refusal asks for shows the head Flowly read, under the same revision.
    const reread = await x.read();
    expect(reread.revision).toBe(before.revision);
    expect(reread.git.map(({ repo, sha, dirty }) => ({ repo, sha, dirty }))).toEqual(await x.heads());
  }
  expect(await names(ops)).toEqual(receipts);
}, 60_000);

/** One minute of work in the successor's turn: a command and its output (and every fifth minute a line of narration), then an observer pass. */
async function busyMinute(x: RunningCard, minute: number) {
  const timestamp = new Date(x.now()).toISOString(), call = `busy-call-${minute}`;
  await x.raw([{ timestamp, type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: call, arguments: JSON.stringify({ cmd: `npm test -- --shard ${minute}/60` }) } },
    { timestamp, type: "response_item", payload: { type: "function_call_output", call_id: call, output: `Process exited with code 0\nOutput:\n${"ok\n".repeat(40)}` } },
    ...(minute % 5 ? [] : [{ timestamp, type: "event_msg", payload: { type: "agent_message", message: `Shard ${minute} passed; continuing with the next ones.` } }])]);
  await x.minute();
}

test("a running hour's in-place passes write the card's observation state, not the whole card: bytes do not grow with the card", async () => {
  // The fixture's default card: 70 notes of about 1.9 KB, about 166 KB on disk, like most live cards (62–180 KB).
  const x = await handedOver();
  const card = (await stat(x.file)).size, bytes = await readFile(x.file);
  expect(card).toBeGreaterThan(150_000);
  const revision = (await x.read()).revision;
  written.bytes = 0;
  let offset = 0;
  for (let minute = 1; minute <= 60; minute++) {
    fsCalls.length = 0;
    await busyMinute(x, minute);
    // One write per pass, and not of the card file.
    expect(handoffWrites(x)).toEqual(["rename handoffs/card/observation.json"]);
    const succ = (await x.read()).ledger.find((session) => session.agentId === "succ")!;
    expect(succ.through!.offset).toBeGreaterThan(offset); offset = succ.through!.offset;
  }
  expect(await readFile(x.file)).toEqual(bytes);
  expect((await x.read()).revision).toBe(revision);
  // 60 passes of about 5.6 KB (the keys both sessions' ledger entries changed, mostly their cursors, and the Git snapshot):
  // about 335 KB, where rewriting the card file wrote 60 × 160 KB (9.6 MB). What a pass writes depends on the sessions, not
  // on the card.
  expect(written.bytes).toBeLessThan(60 * 10_000);
}, 120_000);

/** A turn's final of 1900 characters (a turn window keeps its first 800, as the live preview does). */
const final = (agentId: string, n: number) => `${agentId} turn ${n}: ${"what this turn did, what it found and what the next turn checks first; ".repeat(30)}`.slice(0, 1900);

/**
 * Both sessions mature (the reviewer's probe, cost-r2-1): a full 10-turn window of long finals each and live previews,
 * then the predecessor's trailing token count, so its entry changes in place once and then stays the same.
 */
async function mature(x: RunningCard) {
  for (let n = 1; n <= 10; n++) {
    await x.raw([{ timestamp: new Date(x.now()).toISOString(), type: "event_msg", payload: { type: "agent_message", message: `Turn ${n}: ${"checked the shard results and moved on to the next module; ".repeat(8)}`.slice(0, 480) } }]);
    x.turn(false); await x.minute();
    await x.observer.observe("card", "succ", { timeline: [{ type: "assistant_message", text: final("succ", n) }], outcome: "completed" });
    x.turn(true);
    await x.observer.observe("card", "pred", { timeline: [{ type: "assistant_message", text: final("pred", n) }], outcome: "completed" });
  }
  await x.raw([{ timestamp: new Date(x.now()).toISOString(), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 61_000 }, model_context_window: 258_400 } } }], "pred");
  await x.minute();
}

test("mature sessions (10-turn windows of long finals, live previews): a pass writes the keys changed since the revision, never the history", async () => {
  const x = await handedOver({ notes: 6 });
  await mature(x);
  const record = await x.read(), observation = join(x.directory, "handoffs", "card", "observation.json");
  for (const agentId of ["pred", "succ"]) {
    const session = record.ledger.find((value) => value.agentId === agentId)!;
    expect(session.turns).toHaveLength(10); expect(session.turns[0].final).toContain(`${agentId} turn 1:`);
    expect(session.live.length).toBeGreaterThan(4); expect(JSON.stringify(session.live)).not.toContain(`${agentId} turn 1:`);
  }
  const bytes = await readFile(x.file);
  const passes: number[] = [];
  for (let minute = 1; minute <= 60; minute++) {
    fsCalls.length = 0; written.bytes = 0;
    await busyMinute(x, minute);
    expect(handoffWrites(x)).toEqual(["rename handoffs/card/observation.json"]);
    passes.push(written.bytes);
    // A turn window is history, fixed for the whole turn: an old final (no longer in the live preview) is never written in place.
    const observed = await readFile(observation, "utf8");
    for (const agentId of ["pred", "succ"]) expect(observed).not.toContain(`${agentId} turn 1:`);
  }
  expect(await readFile(x.file)).toEqual(bytes);
  expect((await x.read()).revision).toBe(record.revision);
  // Whole entries were up to 34 KB a pass here (1.95 MB an hour on a 50 KB card). The keys that change are 5–10 KB: both
  // cursors (mostly the observer's resume state), measurements and growth, and the successor's coverage text and, once
  // narration changed it, its narration preview (up to 4,000 characters); about 475 KB an hour.
  expect(Math.max(...passes)).toBeLessThan(12_000);
  expect(passes.reduce((sum, value) => sum + value, 0)).toBeLessThan(600_000);
}, 180_000);
