import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HandoffStore, type HandoffContext } from "./handoff-store";
import { bodyName, bodyReferences, tree } from "./handoff-collect-fixture";
import type { CardHandoff, HandoffPage, HandoffSession } from "../shared/handoff";

// Entry bodies that nothing references any more are removed (SESSION-HANDOFF-SPEC §5.1): by the write that superseded them,
// once it is durable, and once per start for what older versions left. Nothing a current entry, overflow entry, archive
// line, seal, pointer, pending operation or unfinished write names is ever removed, nor a body an older version's reader
// at the current revision may still be paging. Temporary directories only.
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const flowly: HandoffContext = { by: { kind: "flowly" } };
const human: HandoffContext = { by: { kind: "human" } };
const agent: HandoffContext = { by: { kind: "agent", agentId: "worker" } };
const at = "2026-10-25T02:00:00.000Z";
const session = { agentId: "worker", sourceId: "session:worker", n: 1, role: "implementer" as const, provider: "codex", reason: "replacement", startedAt: at, finalized: false, turns: [], background: [], live: [] };
const through = (offset: number) => ({ path: "rollout.jsonl", identity: "file:1", offset, size: offset, at, lagBytes: 0, gaps: 0 });
const observation = (offset: number, extra: Partial<HandoffSession> = {}) => ({ session: { ...session, measured: { C: 40_000 + offset, turns: 0 }, ...extra }, cursor: { agentId: "worker", through: through(offset) } });
async function fixture(fault?: (point: string) => void | Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "flowly-handoff-collect-")); folders.push(dir);
  let tick = 0;
  const options = { fault, now: () => new Date(Date.parse(at) + 1000 * (++tick)).toISOString() };
  const store = new HandoffStore(dir, options);
  await store.setSession("card", "project", session, { ...flowly, sourceId: "session:worker" });
  return { dir, store, handoffs: join(dir, "handoffs"), folder: join(dir, "handoffs", "card"), restart: () => new HandoffStore(dir, options), read: () => store.read("card", "project") };
}
async function pages(store: HandoffStore, options: Parameters<HandoffStore["page"]>[1] = { scope: "all" }) {
  const result: HandoffPage[] = []; let cursor: string | undefined;
  do { const page = await store.page("card", cursor ? { cursor } : options); result.push(page); cursor = page.nextCursor; } while (cursor && result.length < 500);
  return result;
}
const clean = async (handoffs: string) => { const references = await bodyReferences(handoffs); expect(references.missing).toEqual([]); expect(references.unreferenced).toEqual([]); return references; };
const json = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** Writes a body the way the store names it and returns its name. */
async function body(folder: string, value: unknown) { const text = JSON.stringify(value), ref = bodyName(text); await writeFile(join(folder, "entries", `${ref}.json`), text); return ref; }

test("every body a current entry, overflow entry, archive line, seal or pointer names stays; what a revision supersedes goes once it is durable", async () => {
  const { store, handoffs, read, restart } = await fixture();
  // 41 open gaps: the oldest is moved to the overflow index (and archived). 101 notes: the oldest is archived.
  for (let n = 0; n < 41; n++) await store.appendGap("card", "project", { kind: "flowly", text: `Gap ${n}`, status: "open" }, { ...flowly, sourceId: `gap:${n}` });
  for (let n = 0; n < 101; n++) await store.appendNote("card", "project", { kind: "background", text: `Note ${n}` }, { ...flowly, sourceId: `note:${n}` });
  await store.update("card", "project", { handoffRevision: (await read()).revision, set: [{ section: "done", id: "dn:tests", text: "Tests pass" }] }, agent);
  await store.update("card", "project", { handoffRevision: (await read()).revision, set: [{ section: "done", id: "dn:tests", text: "Tests and typecheck pass" }] }, agent);
  const explicit = await store.update("card", "project", { handoffRevision: (await read()).revision, operationId: "op:state", state: "Working on the store." }, agent);
  await clean(handoffs);
  const record = await read();
  expect(record.overflow.map((entry) => entry.id)).toHaveLength(1);
  const overflowId = record.overflow[0].id, sealed = await store.seal("card", "rotation:1", "project");
  // Observation in place, then revisions that supersede the ledger body the seal names and the ones after it.
  await store.capture("card", "project", observation(100), flowly);
  await store.capture("card", "project", { ...observation(200), entries: [{ section: "notes", value: { kind: "hazard", text: "The deploy failed." } }] }, flowly);
  await store.capture("card", "project", observation(300, { turns: [{ n: 1, startedAt: at, endedAt: at, outcome: "completed", final: "Turn one.", wroteHandoff: false }] }), flowly);
  await store.capture("card", "project", observation(400, { endedAt: at, endReason: "rotated" }), flowly);
  const references = await clean(handoffs);
  expect(references.referenced.has(sealed.record.ledger[0].contentRef!)).toBe(true);
  // Everything is still read: the full read, the overflow entry by id, the seal's replay, the archived ledger version, a receipt.
  for (const reader of [store, restart()]) {
    const all = await pages(reader);
    expect(all.at(-1)!.complete).toBe(true);
    expect(all.flatMap((page) => page.items).filter((item) => item.origin === "archive").map((item) => item.section).sort()).toEqual(expect.arrayContaining(["done", "gaps", "ledger", "notes"]));
    await expect(pages(reader, { entryId: overflowId })).resolves.toMatchObject([{ items: [{ id: overflowId, value: { text: "Gap 0" } }] }]);
    await expect(reader.seal("card", "rotation:1", "project")).resolves.toMatchObject({ replayed: true, revision: sealed.revision });
    await expect(reader.update("card", "project", { handoffRevision: explicit.handoffRevision - 1, operationId: "op:state", state: "Working on the store." }, agent)).resolves.toMatchObject({ replayed: true, handoffRevision: explicit.handoffRevision });
  }
  await clean(handoffs);
});

test("an observation write rewrites only the card file and keeps the entry's body until the next revision", async () => {
  const { store, handoffs, folder, read } = await fixture();
  await store.appendGap("card", "project", { kind: "flowly", text: "One repository was not inspected.", status: "open" }, { ...flowly, sourceId: "gap:1" });
  const before = await read(), files = await tree(folder);
  for (let offset = 100; offset <= 1000; offset += 100) await expect(store.capture("card", "project", observation(offset), flowly)).resolves.toMatchObject({ stored: "observation" });
  const observed = await read();
  expect(observed).toMatchObject({ revision: before.revision, ledger: [{ through: { offset: 1000 }, contentRef: before.ledger[0].contentRef }] });
  expect(await tree(folder)).toEqual(files);
  await clean(handoffs);
  // The next revision writes the body of the version in the record and removes the one it supersedes.
  await store.appendNote("card", "project", { kind: "hazard", text: "Port 3000 is taken." }, { ...flowly, sourceId: "note:port" });
  const revised = await read(), { contentRef: ref, ...plain } = revised.ledger[0];
  expect(ref).not.toBe(before.ledger[0].contentRef);
  expect(await readFile(join(folder, "entries", `${ref}.json`), "utf8")).toBe(JSON.stringify(plain));
  await clean(handoffs);
});

test("an older version's bodies go once at the next start; one a reader at this revision may still be paging waits for the next revision", async () => {
  const { store, handoffs, folder, read, restart } = await fixture();
  // A ledger entry big enough to be paged in pieces by body reference.
  await store.capture("card", "project", observation(10, { anchors: Array.from({ length: 60 }, (_, n) => `anchor ${n}: ${"a decision worth finding again; ".repeat(48)}`) }), flowly);
  await store.appendNote("card", "project", { kind: "hazard", text: "Port 3000 is taken." }, { ...flowly, sourceId: "note:port" });
  const first = await store.page("card", { scope: "all" }), second = await store.page("card", { cursor: first.nextCursor });
  expect(second.items).toMatchObject([{ section: "ledger", field: "json", complete: false }]);
  const record = await read(), ledger = record.ledger[0], paged = ledger.contentRef!;
  // What an older version left: its in-place write of the ledger (a new body, the record and both pointers moved to it, the
  // paged body left behind), a body of an earlier revision, and the temporary file of a write that crashed.
  const { contentRef: _, ...plain } = ledger, moved = { ...plain, through: through(20), measured: { C: 40_020, turns: 0 } };
  const ref = await body(folder, moved), older = await body(folder, { ...plain, rev: ledger.rev - 1, through: through(5) });
  await writeFile(join(folder, "entries", `${ref}.json.0c6c6f1e-7d5c-4a43-9ad0-4c3c2f5ad7b1.tmp`), "{\"partial\":");
  const current = await json<CardHandoff>(join(handoffs, "card.json"));
  current.ledger[0] = { ...moved, contentRef: ref } as HandoffSession; await writeFile(join(handoffs, "card.json"), JSON.stringify(current));
  for (const [index, key] of [["latest", ledger.id], ["sources", ledger.sourceId!]] as const) {
    const path = join(folder, index, `${sha(key)}.json`); await writeFile(path, JSON.stringify({ ...await json<object>(path), ref }));
  }
  // And a body only a latest-version pointer names (an entry no record or archive line holds any more): a reference too.
  const pointed = await body(folder, { id: "nt:legacy", rev: 1, at, by: { kind: "flowly" }, kind: "background", text: "Only the pointer names this." });
  await writeFile(join(folder, "latest", `${sha("nt:legacy")}.json`), JSON.stringify({ section: "notes", id: "nt:legacy", ref: pointed, rev: 1, at }));
  expect((await bodyReferences(handoffs)).unreferenced.sort()).toEqual([older, paged].sort());
  // The next start: the earlier body and the temporary file go; the paged one stays while the reader's revision stands.
  const started = restart();
  const third = await started.page("card", { cursor: second.nextCursor });
  expect(third.viewChanged).toBeUndefined(); expect(third.items).toMatchObject([{ section: "ledger", field: "json", offset: second.items[0].text!.length }]);
  expect((await bodyReferences(handoffs)).unreferenced).toEqual([paged]);
  expect((await readdir(join(folder, "entries"))).some((name) => name.endsWith(".tmp"))).toBe(false);
  let page = third; while (page.nextCursor && !page.complete) page = await started.page("card", { cursor: page.nextCursor });
  expect(page.complete).toBe(true);
  // A start after that finds nothing more to remove and writes nothing.
  const files = await tree(folder); await restart().read("card"); expect(await tree(folder)).toEqual(files);
  // The next revision ends that reader's view (viewChanged) and removes the body it was paging.
  await started.appendNote("card", "project", { kind: "hazard", text: "The staging database is shared." }, { ...flowly, sourceId: "note:db" });
  await expect(started.page("card", { cursor: page.nextCursor ?? second.nextCursor })).resolves.toMatchObject({ viewChanged: true, items: [] });
  expect((await clean(handoffs)).bodies.has(pointed)).toBe(true);
  await expect(started.page("card", { entryId: "nt:legacy" })).resolves.toMatchObject({ items: [{ id: "nt:legacy", value: { text: "Only the pointer names this." } }] });
});

test.each(["bodies-synced", "intent-synced", "archive-synced", "current-synced", "sources-synced", "collected", "intent-removed"])("a crash after %s removes nothing referenced: the pending operation, its original and every archived version stay", async (point) => {
  let armed = false;
  const { store, handoffs, read, restart } = await fixture((reached) => { if (armed && reached === point) { armed = false; throw new Error("crash"); } });
  await store.appendInput("card", "project", { via: "comment", text: "Keep the old endpoint." }, { ...human, sourceId: "comment:1", operationId: "op:comment", unconfirmed: true });
  for (let n = 0; n < 3; n++) await store.appendNote("card", "project", { kind: "background", text: `Note ${n}` }, { ...flowly, sourceId: `note:${n}` });
  await store.capture("card", "project", observation(100), flowly);
  const before = await read();
  armed = true;
  // A turn ends: the ledger's history changes (its previous version archived), a note arrives, the cursor moves.
  await expect(store.capture("card", "project", { ...observation(200, { turns: [{ n: 1, startedAt: at, endedAt: at, outcome: "completed", final: "Turn one.", wroteHandoff: false }] }), entries: [{ section: "notes", value: { kind: "hazard", text: "The deploy failed." } }] }, flowly)).rejects.toThrow("crash");
  const reopened = restart(), recovered = await reopened.read("card", "project");
  expect(recovered.revision).toBe(point === "bodies-synced" ? before.revision : before.revision + 1);
  expect((await bodyReferences(handoffs)).missing).toEqual([]);
  expect(recovered.pendingOperations).toMatchObject([{ id: "op:comment", sourceId: "comment:1" }]);
  await expect(reopened.inputText("card", "comment:1")).resolves.toBe("Keep the old endpoint.");
  await expect(reopened.confirmSource("card", "project", "comment:1", { ...human, operationId: "confirm:comment" })).resolves.toMatchObject({ ok: true });
  expect((await pages(reopened)).at(-1)!.complete).toBe(true);
  await reopened.capture("card", "project", { ...observation(300, { turns: [{ n: 1, startedAt: at, endedAt: at, outcome: "completed", final: "Turn one.", wroteHandoff: false }] }), entries: [{ section: "notes", value: { kind: "hazard", text: "The deploy failed." } }] }, flowly);
  await clean(handoffs);
});

test("a card restored from removed/ keeps every body its record, archive and seal name; bodies only its backup held go", async () => {
  const { store, dir, handoffs, folder, read, restart } = await fixture();
  for (let n = 0; n < 101; n++) await store.appendNote("card", "project", { kind: "background", text: `Note ${n}` }, { ...flowly, sourceId: `note:${n}` });
  await store.seal("card", "rotation:1", "project");
  await store.capture("card", "project", observation(100, { endedAt: at, endReason: "rotated" }), flowly);
  // An older version's leftover body, then the backup Delete permanently writes and the removal.
  const record = await read(), { contentRef: _, ...plain } = record.ledger[0];
  const leftover = await body(folder, { ...plain, rev: record.ledger[0].rev - 1, through: through(50) });
  const expected = await pages(store), backup = join(dir, "removed", "card");
  await store.exportCard("card", backup); await store.removeCard("card");
  await expect(restart().restoreCard("card", backup)).resolves.toEqual(record);
  const restored = restart();
  expect(await pages(restored)).toEqual(expected);
  const references = await clean(handoffs);
  expect(references.bodies.has(leftover)).toBe(false);
  expect(JSON.parse(await readFile(join(backup, "data", "entries", `${leftover}.json`), "utf8"))).toMatchObject({ rev: record.ledger[0].rev - 1 });
});
