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
  // 60 passes of about 6.4 KB (both sessions' ledger entries, mostly their cursors, and the Git snapshot): about 385 KB,
  // where rewriting the card file wrote 60 × 160 KB (9.6 MB). What a pass writes depends on the sessions, not on the card.
  expect(written.bytes).toBeLessThan(60 * 10_000);
}, 120_000);
