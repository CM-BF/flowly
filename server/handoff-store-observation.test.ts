import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HandoffStore, type HandoffContext } from "./handoff-store";
import { handoffLimits, type CardHandoff } from "../shared/handoff";

// Observation state (a session's cursor, measurements and narration preview, calls in flight, progress events, Git
// snapshots) is written in place, under the revision that page cursors, ACKs and entry conflicts pin (SESSION-HANDOFF-SPEC
// §5.1). Temporary directories only.
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const flowly: HandoffContext = { by: { kind: "flowly" } };
const at = "2026-10-25T02:00:00.000Z";
const session = { agentId: "worker", n: 1, role: "implementer" as const, provider: "codex", reason: "replacement", startedAt: at, finalized: false, turns: [], background: [], live: [] };
const through = (offset: number) => ({ path: "rollout.jsonl", identity: "file:1", offset, size: offset, at, lagBytes: 0, gaps: 0 });
async function fixture(fault?: (point: string) => void | Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "flowly-handoff-observation-")); folders.push(dir);
  let tick = 0;
  const store = new HandoffStore(dir, { fault, now: () => new Date(Date.parse(at) + 1000 * (++tick)).toISOString() });
  await store.setSession("card", "project", session, { ...flowly, sourceId: "session:worker" });
  await store.appendGap("card", "project", { kind: "flowly", text: "One repository was not inspected.", status: "open" }, { ...flowly, sourceId: "gap:1" });
  return { dir, store, read: () => store.read("card", "project") };
}
const files = async (dir: string, folder: string) => (await readdir(join(dir, "handoffs", "card", folder)).catch(() => [] as string[])).sort();
const observation = (offset: number, extra: Partial<CardHandoff["ledger"][number]> = {}) => ({ session: { ...session, measured: { C: 40_000 + offset, turns: 0 }, ...extra }, cursor: { agentId: "worker", through: through(offset) } });

test("observation keeps the revision, write time and entry stamps; a pinned change in the same write takes one revision", async () => {
  const { dir, store, read } = await fixture();
  const before = await read(), receipts = await files(dir, "ops");
  const written = await store.capture("card", "project", { ...observation(100), git: [{ repo: "/repo", sha: "aaa", dirty: false, at }] }, flowly);
  const observed = await read();
  expect(written).toMatchObject({ stored: "observation", handoffRevision: before.revision });
  expect(observed).toMatchObject({ revision: before.revision, updatedAt: before.updatedAt, updatedBy: before.updatedBy, ops: before.ops, archivedCount: before.archivedCount, git: [{ sha: "aaa" }] });
  expect(observed.ledger[0]).toMatchObject({ rev: before.ledger[0].rev, at: before.ledger[0].at, measured: { C: 40_100 }, through: { offset: 100 } });
  expect(observed.ledger[0].contentRef).not.toBe(before.ledger[0].contentRef);
  expect(await files(dir, "ops")).toEqual(receipts); // Flowly's own passes use fresh ids: no receipt for them
  // A call caught in flight and a running task's progress event are observation too; a call that ended without a result is not.
  const flying = { id: "bg:call", callId: "c1", kind: "exec_session" as const, ref: "unknown:c1", label: "npm test", startedAt: at, status: "unknown" as const, source: "live" as const, inFlight: true as const };
  await expect(store.capture("card", "project", observation(200, { background: [flying] }), flowly)).resolves.toMatchObject({ stored: "observation", handoffRevision: before.revision });
  await expect(store.capture("card", "project", observation(300, { background: [{ ...flying, event: "step 3/4: health check failing" }] }), flowly)).resolves.toMatchObject({ stored: "observation", handoffRevision: before.revision });
  const { inFlight: _, ...settled } = flying;
  await expect(store.capture("card", "project", observation(400, { background: [settled] }), flowly)).resolves.toMatchObject({ stored: "revision", handoffRevision: before.revision + 1 });
  // A requirement and observation in one write: one new revision, both stored.
  const mixed = await store.capture("card", "project", { ...observation(500, { background: [settled] }), entries: [{ section: "notes", value: { kind: "hazard", text: "The deploy failed." } }] }, flowly);
  expect(mixed).toMatchObject({ stored: "revision", handoffRevision: before.revision + 2 });
  expect(await read()).toMatchObject({ revision: before.revision + 2, ledger: [{ through: { offset: 500 } }], notes: [{ text: "The deploy failed." }] });
  // Nothing new: nothing written.
  const bytes = await readFile(join(dir, "handoffs", "card.json"), "utf8");
  await expect(store.capture("card", "project", observation(500, { background: [settled] }), flowly)).resolves.toMatchObject({ stored: "none" });
  expect(await readFile(join(dir, "handoffs", "card.json"), "utf8")).toBe(bytes);
});

test("a page cursor and an ACK of a revision survive observation, not a new requirement", async () => {
  const { store, read } = await fixture();
  for (let n = 0; n < 60; n++) await store.appendNote("card", "project", { kind: "background", text: `Note ${n}: ${"long enough to need pages; ".repeat(70)}`.slice(0, 1900) }, { ...flowly, sourceId: `note:${n}` });
  const first = await store.page("card", { scope: "all" });
  expect(first.nextCursor).toBeTruthy();
  await store.capture("card", "project", observation(100), flowly);
  const second = await store.page("card", { cursor: first.nextCursor });
  expect(second).toMatchObject({ revision: first.revision }); expect(second.viewChanged).toBeUndefined(); expect(second.items.length).toBeGreaterThan(0);
  const record = await read(), gap = record.gaps[0].id;
  await store.capture("card", "project", observation(200), flowly);
  const ack = (revision: number) => store.update("card", "project", { handoffRevision: revision, ack: { handoffRevision: revision, heads: [], understanding: "Read.", items: [{ id: gap, disposition: "doing" }] } }, { by: { kind: "agent", agentId: "worker" } }, { agentId: "worker", actualHeads: [] });
  await expect(ack(record.revision)).resolves.toMatchObject({ ok: true, handoffRevision: record.revision + 1 });
  // A new requirement still changes the view and refuses an ACK of the revision before it.
  const third = await store.page("card", { scope: "all" });
  await store.appendInput("card", "project", { via: "comment", text: "Also keep the old endpoint." }, { by: { kind: "human" }, sourceId: "comment:1" });
  await expect(store.page("card", { cursor: third.nextCursor })).resolves.toMatchObject({ viewChanged: true, items: [] });
  await expect(ack(third.revision)).rejects.toMatchObject({ code: "ACK_MISMATCH" });
});

test("an open grouped gap that grows is written in place; a new gap, a close and a reopen each take a revision", async () => {
  const { store, read } = await fixture();
  const grouped = (count: number, lastAt: string) => ({ gaps: [{ id: "g:tool", sourceId: "capture-gaps:worker:long_line", agentId: "worker", text: "Capture gap (long_line): response_item/function_call_output (tool output), first ones in bytes 10–300010.", count, firstAt: at, lastAt }] });
  const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
  const before = await read();
  await expect(store.capture("card", "project", grouped(1, at), flowly)).resolves.toMatchObject({ stored: "revision", handoffRevision: before.revision + 1 });
  const opened = await read();
  // The same obligation, counted further: the revision a page cursor or an ACK names stands, and nothing is archived.
  await expect(store.capture("card", "project", grouped(3, later(2)), flowly)).resolves.toMatchObject({ stored: "observation", handoffRevision: opened.revision });
  expect(await read()).toMatchObject({ revision: opened.revision, archivedCount: opened.archivedCount, gaps: expect.arrayContaining([expect.objectContaining({ id: "g:tool", status: "open", count: 3, lastAt: later(2), rev: opened.gaps.find((gap) => gap.id === "g:tool")!.rev })]) });
  const closed = await store.update("card", "project", { handoffRevision: opened.revision, gaps: [{ id: "g:tool", status: "closed", note: "My own test output; nothing of the card in it." }] }, { by: { kind: "agent", agentId: "worker" } }, { agentId: "worker" });
  expect(closed.handoffRevision).toBe(opened.revision + 1);
  // Growth past the acknowledged count reopens it: that is a requirement again.
  await expect(store.capture("card", "project", grouped(4, later(5)), flowly)).resolves.toMatchObject({ stored: "revision", handoffRevision: opened.revision + 2 });
  expect((await read()).gaps.find((gap) => gap.id === "g:tool")).toMatchObject({ status: "open", count: 4 });
});

test.each(["intent-synced", "archive-synced", "current-synced", "sources-synced", "intent-removed"])("an observation write interrupted after %s recovers once, under the same revision", async (point) => {
  let armed = false;
  const { dir, store } = await fixture((reached) => { if (armed && reached === point) { armed = false; throw new Error("crash"); } });
  const before = await store.read("card", "project"), archive = await readFile(join(dir, "handoffs", "card", "archive.jsonl"), "utf8").catch(() => "");
  armed = true;
  await expect(store.capture("card", "project", observation(700), flowly)).rejects.toThrow("crash");
  const reopened = new HandoffStore(dir), recovered = await reopened.read("card", "project");
  expect(recovered).toMatchObject({ revision: before.revision, updatedAt: before.updatedAt, ledger: [{ through: { offset: 700 } }] });
  expect(await readFile(join(dir, "handoffs", "card", "archive.jsonl"), "utf8").catch(() => "")).toBe(archive);
  expect(await files(dir, "")).not.toContain("pending.json");
  await expect(reopened.capture("card", "project", observation(700), flowly)).resolves.toMatchObject({ stored: "none", handoffRevision: before.revision });
});

test("an explicit operation id keeps its receipt in place, so a replay is recognized", async () => {
  const { store } = await fixture();
  const first = await store.capture("card", "project", observation(100), { ...flowly, operationId: "observe:1" });
  expect(first.stored).toBe("observation");
  await expect(store.capture("card", "project", observation(100), { ...flowly, operationId: "observe:1" })).resolves.toMatchObject({ replayed: true, handoffRevision: first.handoffRevision });
  await expect(store.capture("card", "project", observation(200), { ...flowly, operationId: "observe:1" })).rejects.toMatchObject({ code: "OPERATION_REUSED" });
});

test("observation that pushes the record past its 1 MiB budget archives an entry, and that takes a revision", async () => {
  const { dir, store, read } = await fixture();
  // Built directly (with their bodies on disk) in linear time: open inputs and notes up to about 3 KB below the budget.
  const record = await read(), entries = join(dir, "handoffs", "card", "entries");
  await mkdir(entries, { recursive: true });
  let size = Buffer.byteLength(JSON.stringify(record));
  const add = async (section: "inputs" | "notes", entry: Record<string, unknown>) => {
    const text = JSON.stringify(entry), ref = createHash("sha256").update(text).digest("hex"), full = { ...entry, contentRef: ref };
    const grow = Buffer.byteLength(JSON.stringify(full)) + (record[section].length ? 1 : 0);
    if (size + grow > handoffLimits.currentBytes - 3_000) return false;
    await writeFile(join(entries, `${ref}.json`), text); (record[section] as unknown[]).push(full); size += grow; return true;
  };
  for (let n = 0; n < 200; n++) if (!await add("inputs", { id: `d:${n}`, rev: 1, at, by: { kind: "human" }, atSource: "typed", via: "comment", text: `Instruction ${n}: ${"keep it reversible; ".repeat(200)}`.slice(0, 4000), characters: 4000, status: "open" })) break;
  for (let n = 0; n < 99; n++) if (!await add("notes", { id: `nt:${n}`, rev: 1, at, by: { kind: "flowly" }, kind: "background", text: `Filler ${n}: ${"x".repeat(1880)}` })) break;
  await writeFile(join(dir, "handoffs", "card.json"), JSON.stringify(record));
  const file = async () => Buffer.byteLength(await readFile(join(dir, "handoffs", "card.json")));
  expect(handoffLimits.currentBytes - await file()).toBeGreaterThan(2_000);
  expect(handoffLimits.currentBytes - await file()).toBeLessThan(5_000);
  const before = await read();
  // About 8 KB of observation (narration preview and coverage text), more than the room left.
  const live = Array.from({ length: 8 }, (_, n) => ({ at, text: `${n}: ${"narration of the running turn ".repeat(26)}`.slice(0, 800) }));
  const written = await store.capture("card", "project", observation(100, { live, skeleton: `Current capture coverage: ${"partial; ".repeat(220)}`.slice(0, 2000) }), flowly);
  const after = await read();
  expect(written).toMatchObject({ stored: "revision", handoffRevision: before.revision + 1 });
  expect(after.archivedCount).toBeGreaterThan(before.archivedCount);
  expect(after.overflow.map((entry) => entry.id)).toContain("d:0");
  expect(after.ledger[0].live).toHaveLength(8);
  expect(await file()).toBeLessThanOrEqual(handoffLimits.currentBytes);
});
