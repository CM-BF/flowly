import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HandoffStore, type HandoffContext } from "./handoff-store";
import { bodyReferences } from "./handoff-collect-fixture";
import type { HandoffPage } from "../shared/handoff";

// A second store on the same data directory whose card queue is not this one's (another module instance: another Flowly
// process, e.g. a second install under another id) collects the card at its first touch while this store's write is in
// flight: its bodies are durable, its unfinished-write record is not there yet (SESSION-HANDOFF-SPEC §5.1). Nothing that
// write names may go, or the version it archives later is unreadable for every full read. Temporary directories only.
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const flowly: HandoffContext = { by: { kind: "flowly" } };
const at = "2026-10-25T02:00:00.000Z";
const session = { agentId: "worker", sourceId: "session:worker", n: 1, role: "implementer" as const, provider: "codex", reason: "replacement", startedAt: at, finalized: false, turns: [], background: [], live: [] };
const through = (offset: number) => ({ path: "rollout.jsonl", identity: "file:1", offset, size: offset, at, lagBytes: 0, gaps: 0 });
async function pages(store: Pick<HandoffStore, "page">) {
  const result: HandoffPage[] = []; let cursor: string | undefined;
  do { const page = await store.page("card", cursor ? { cursor } : { scope: "all" }); result.push(page); cursor = page.nextCursor; } while (cursor && result.length < 500);
  return result;
}

test("another instance's first-touch collection keeps every body of a write in flight; the versions it archives later stay readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowly-handoff-race-")); folders.push(dir);
  const handoffs = join(dir, "handoffs");
  let armed = false, paused!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { paused = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  // Pauses the write once its bodies are durable and before its unfinished-write record (pending.json) is in place.
  const old = new HandoffStore(dir, { fault: async (point) => { if (armed && point === "bodies-synced") { armed = false; paused(); await gate; } } });
  await old.setSession("card", "project", session, { ...flowly, sourceId: "session:worker" });
  // Observation in place: the ledger entry keeps the body of its revision, so the write below also writes its current version.
  await old.capture("card", "project", { session: { ...session, measured: { C: 40_100, turns: 0 } }, cursor: { agentId: "worker", through: through(100) } }, flowly);
  armed = true;
  // The session ends (the ledger's previous version is archived, a new version written) and a note arrives: a new revision.
  const writing = old.capture("card", "project", { session: { ...session, measured: { C: 40_200, turns: 1 }, endedAt: at, endReason: "rotated" }, cursor: { agentId: "worker", through: through(200) }, entries: [{ section: "notes", value: { kind: "background", text: "Race note 0" } }] }, flowly);
  await reached;
  vi.resetModules();
  const { HandoffStore: Next } = await import("./handoff-store");
  const next = new Next(dir);
  await next.read("card", "project");
  release(); await expect(writing).resolves.toMatchObject({ stored: "revision" });
  expect((await bodyReferences(handoffs)).missing).toEqual([]);
  // 100 more notes through the other instance: the race note is archived (the cap is 100) under the body its write named.
  for (let n = 1; n <= 100; n++) await next.appendNote("card", "project", { kind: "background", text: `Note ${n}` }, { ...flowly, sourceId: `note:${n}` });
  for (const reader of [next, old, new HandoffStore(dir)]) {
    const all = await pages(reader);
    expect(all.at(-1)!.complete).toBe(true);
    const archived = all.flatMap((page) => page.items).filter((item) => item.origin === "archive");
    expect(archived).toEqual(expect.arrayContaining([expect.objectContaining({ section: "notes", value: expect.objectContaining({ text: "Race note 0" }) }), expect.objectContaining({ section: "ledger" })]));
  }
  const references = await bodyReferences(handoffs);
  expect(references.missing).toEqual([]); expect(references.unreferenced).toEqual([]);
});
