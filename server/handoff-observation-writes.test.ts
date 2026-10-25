import { afterEach, expect, test, vi } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupRunningFixtures, handedOver, type RunningCard } from "./handoff-running-fixture";

// What Flowly's own observation writes cost on disk (SESSION-HANDOFF-SPEC §5.1): an in-place write (observation state under
// the same revision) is one atomic replacement and keeps no unfinished-write record or receipt, whoever calls it. Production
// wiring on synthetic Codex rollouts and a real Git repository (server/handoff-running-fixture.ts).
const fsCalls = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // Every rename (the last step of each atomic write), by destination.
  return { ...actual, rename: async (from: string, to: string) => { fsCalls.push(`rename ${to}`); return actual.rename(from, to); } };
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
    expect(handoffWrites(x)).toEqual(["rename handoffs/card.json"]);
    // The reread the refusal asks for shows the head Flowly read, under the same revision.
    const reread = await x.read();
    expect(reread.revision).toBe(before.revision);
    expect(reread.git.map(({ repo, sha, dirty }) => ({ repo, sha, dirty }))).toEqual(await x.heads());
  }
  expect(await names(ops)).toEqual(receipts);
}, 60_000);
