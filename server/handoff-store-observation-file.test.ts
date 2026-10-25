import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HandoffStore, type HandoffContext } from "./handoff-store";
import { bodyReferences } from "./handoff-collect-fixture";
import type { CardHandoff } from "../shared/handoff";

// Observation state written in place goes to the card's observation file (handoffs/<card>/observation.json), which holds
// only what differs from the card file and names that file's bytes (SESSION-HANDOFF-SPEC §5.1). Every read applies it, a
// revision folds it into the card file, and any rewrite of the card file leaves it stale: it is then ignored, never applied
// over newer data. Temporary directories only.
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const flowly: HandoffContext = { by: { kind: "flowly" } };
const agent: HandoffContext = { by: { kind: "agent", agentId: "worker" } };
const at = "2026-10-25T02:00:00.000Z";
const session = { agentId: "worker", sourceId: "session:worker", n: 1, role: "implementer" as const, provider: "codex", reason: "replacement", startedAt: at, finalized: false, turns: [], background: [], live: [] };
const through = (offset: number) => ({ path: "rollout.jsonl", identity: "file:1", offset, size: offset, at, lagBytes: 0, gaps: 0 });
const observation = (offset: number) => ({ session: { ...session, measured: { C: 40_000 + offset, turns: 0 } }, cursor: { agentId: "worker", through: through(offset) } });
const git = (sha: string) => [{ repo: "/repo", sha, dirty: false, at }];
async function fixture(fault?: (point: string) => void | Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "flowly-handoff-observation-file-")); folders.push(dir);
  let tick = 0;
  const options = { fault, now: () => new Date(Date.parse(at) + 1000 * (++tick)).toISOString() };
  const store = new HandoffStore(dir, options);
  await store.setSession("card", "project", session, { ...flowly, sourceId: "session:worker" });
  const handoffs = join(dir, "handoffs"), card = join(handoffs, "card.json"), file = join(handoffs, "card", "observation.json");
  return { dir, store, handoffs, card, file, restart: () => new HandoffStore(dir, options), read: () => store.read("card", "project"), exists: async () => (await readdir(join(handoffs, "card"))).includes("observation.json") };
}

test("in-place writes go to the observation file; every reader sees them; the next revision folds them into the card file", async () => {
  const { store, card, exists, read, restart, handoffs } = await fixture();
  const before = await read(), bytes = await readFile(card, "utf8");
  for (let offset = 100; offset <= 500; offset += 100) await expect(store.capture("card", "project", { ...observation(offset), git: git(`sha${offset}`) }, flowly)).resolves.toMatchObject({ stored: "observation" });
  expect(await readFile(card, "utf8")).toBe(bytes);
  expect(await exists()).toBe(true);
  for (const reader of [store, restart()]) expect(await reader.read("card", "project")).toMatchObject({ revision: before.revision, ledger: [{ through: { offset: 500 }, measured: { C: 40_500 } }], git: [{ sha: "sha500" }] });
  // A revision: the card file holds everything and the observation file is gone.
  await store.appendNote("card", "project", { kind: "hazard", text: "Port 3000 is taken." }, { ...flowly, sourceId: "note:port" });
  expect(await exists()).toBe(false);
  expect(JSON.parse(await readFile(card, "utf8"))).toMatchObject({ revision: before.revision + 1, ledger: [{ through: { offset: 500 } }], git: [{ sha: "sha500" }] });
  expect((await bodyReferences(handoffs)).missing).toEqual([]);
});

test("a card file rewritten by anyone else (an older version) leaves the observation file stale: it is ignored, then replaced", async () => {
  const { store, card, file, read } = await fixture();
  await store.capture("card", "project", { ...observation(100), git: git("observed") }, flowly);
  // An older version reads the card file alone and writes a new revision without the observation file's state.
  const older = JSON.parse(await readFile(card, "utf8")) as CardHandoff;
  await writeFile(card, JSON.stringify({ ...older, revision: older.revision + 1, state: { id: "state", rev: older.revision + 1, at, by: { kind: "flowly" }, text: "Written by an older version." } }));
  const reread = await read();
  expect(reread).toMatchObject({ revision: older.revision + 1, state: { text: "Written by an older version." } });
  expect(reread.git).toEqual(older.git); expect(reread.ledger[0].through).toEqual(older.ledger[0].through);
  // The next in-place write starts from the card file as it is now.
  await store.capture("card", "project", observation(200), flowly);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ revision: older.revision + 1 });
  expect(await read()).toMatchObject({ revision: older.revision + 1, state: { text: "Written by an older version." }, ledger: [{ through: { offset: 200 } }] });
});

// An in-place write with an explicit operation id rewrites the card file (its receipt rides an unfinished-write record).
// When that returns the card to exactly the bytes the observation file names, the observation file must still be gone,
// also after a crash at any point of that write: applied again, it would bring back the state the write replaced.
test.each(["none", "intent-synced", "archive-synced", "current-synced", "sources-synced", "intent-removed"])("a card file rewritten to the very bytes the observation file names (crash: %s) does not bring the observation back", async (point) => {
  let armed = false;
  const { store, card, read, restart } = await fixture((reached) => { if (armed && reached === point) { armed = false; throw new Error("crash"); } });
  await store.capture("card", "project", { git: git("aaa") }, { ...flowly, operationId: "observe:aaa" });
  const bytes = await readFile(card, "utf8");
  await store.capture("card", "project", { git: git("bbb") }, flowly);
  expect(await read()).toMatchObject({ git: [{ sha: "bbb" }] });
  armed = true;
  const back = store.capture("card", "project", { git: git("aaa") }, { ...flowly, operationId: "observe:back" });
  if (point === "none") await back; else await expect(back).rejects.toThrow("crash");
  const reader = point === "none" ? store : restart();
  expect(await reader.read("card", "project")).toMatchObject({ git: [{ sha: "aaa" }] });
  expect(await readFile(card, "utf8")).toBe(bytes);
});

test("markSeen is observation: it writes the observation file, never the card file", async () => {
  const { store, card, file, read, restart } = await fixture();
  await store.update("card", "project", { handoffRevision: (await read()).revision, state: "Working." }, agent);
  const revision = (await read()).revision, bytes = await readFile(card, "utf8");
  await store.markSeen("card", "project", "worker", revision, agent);
  expect(await readFile(card, "utf8")).toBe(bytes);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ fields: { seen: { worker: revision } } });
  expect(await restart().read("card", "project")).toMatchObject({ revision, seen: { worker: revision } });
});

test("a backup holds the record with its observation state and no observation file; the restored card reads the same", async () => {
  const { dir, store, read, restart } = await fixture();
  await store.capture("card", "project", { ...observation(300), git: git("observed") }, flowly);
  const record = await read(), backup = join(dir, "removed", "card");
  await store.exportCard("card", backup);
  expect(await readdir(join(backup, "data"))).not.toContain("observation.json");
  expect(JSON.parse(await readFile(join(backup, "current.json"), "utf8"))).toEqual(record);
  await store.removeCard("card");
  await expect(restart().restoreCard("card", backup)).resolves.toEqual(record);
  expect(await restart().read("card", "project")).toEqual(record);
});

test("an observation file that does not fit the card file it names is preserved and the card reports unavailable", async () => {
  const { store, file, read } = await fixture();
  await store.capture("card", "project", observation(100), flowly);
  const broken = JSON.parse(await readFile(file, "utf8")) as { entries: { id: string }[] };
  broken.entries[0].id = "s:not-on-this-card"; const text = JSON.stringify(broken);
  await writeFile(file, text);
  await expect(read()).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" });
  await expect(store.capture("card", "project", observation(200), flowly)).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" });
  expect(await readFile(file, "utf8")).toBe(text);
});
