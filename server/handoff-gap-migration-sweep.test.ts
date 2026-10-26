import { afterEach, expect, test, vi } from "vitest";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { handoffOpenIds } from "../shared/handoff";
import { HandoffStore } from "./handoff-store";
import { tree } from "./handoff-collect-fixture";
import { flowly, legacyGap, many, migrationFixture, session } from "./handoff-gap-migration-fixture";

// Plugin start runs the one-time gap migration (SESSION-HANDOFF-SPEC §21.17) like the body sweep: card by card in the
// card's own queue, recorded in handoffs/.gap-migration.json so later starts do nothing, safe to stop and to crash. Each
// card is written at most once. Temporary directories only.
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const cards = ["card-a", "card-b", "card-c"];
async function fixture() {
  const x = await migrationFixture(cards); dirs.push(x.dir);
  for (const card of cards) await x.service.records.setSession(card, "project", session("w1", 1, "implementer"), { ...flowly, sourceId: "session:w1" });
  // card-a and card-b hold legacy gaps; card-c only a real one (nothing to migrate).
  for (const card of ["card-a", "card-b"]) await x.write(card, [...many(30, (n) => legacyGap("w1", "type", "unknown_record_type", n, { hint: "token_usage_record" })), ...many(20, (n) => legacyGap("w1", "opaque", "opaque_tool_background", 100 + n))]);
  await x.write("card-c", [legacyGap("w1", "long", "long_line", 5, { hint: "event_msg/item_completed", bytes: [5, 400000] })]);
  for (const card of cards) await x.service.syncIndex(card);
  const revision = async (card: string) => (await x.service.records.read(card, "project")).revision;
  const marker = () => readFile(join(x.handoffs, ".gap-migration.json"), "utf8").then((text) => JSON.parse(text), () => null);
  return { ...x, revision, marker };
}

test("a stopped sweep records nothing; the next start migrates what is left and writes no card twice; a later start does nothing", async () => {
  const x = await fixture(), before = Object.fromEntries(await Promise.all(cards.map(async (card) => [card, await x.revision(card)])));
  const card = (name: string) => tree(join(x.handoffs, name)).then(async (files) => ({ ...files, file: (await tree(join(x.handoffs, `${name}.json`)))["."] }));
  const untouchedC = await card("card-c");
  // The plugin stops after the first card's migration.
  const stopping = x.start(), migrate = stopping.records.migrateLegacyGaps.bind(stopping.records);
  vi.spyOn(stopping.records, "migrateLegacyGaps").mockImplementationOnce(async (taskId) => { const result = await migrate(taskId); stopping.stop(); return result; });
  await expect(stopping.migrateGaps({ pauseMs: 0 })).resolves.toMatchObject({ recorded: false });
  expect(await x.marker()).toBeNull();
  expect(await x.revision("card-a")).toBe(before["card-a"] + 1);
  expect(await x.revision("card-b")).toBe(before["card-b"]);
  const migratedA = await card("card-a");

  // Next start: card-a is not written again (no file under it changes), card-b once, card-c never.
  const next = x.start();
  await expect(next.migrateGaps({ pauseMs: 0 })).resolves.toMatchObject({ recorded: true });
  expect(await card("card-a")).toEqual(migratedA);
  expect(await x.revision("card-b")).toBe(before["card-b"] + 1);
  expect(await card("card-c")).toEqual(untouchedC);
  expect(await x.marker()).toMatchObject({ version: 1, rules: "capture rules v2", failed: [] });
  for (const name of ["card-a", "card-b"]) {
    const record = await x.service.records.read(name, "project");
    expect(handoffOpenIds(record)).toHaveLength(1);
    expect((await x.board.read()).handoffIndex.find((entry) => entry.taskId === name)?.open).toBe(1);
  }

  // A later start with the marker recorded reads no card and writes nothing.
  const files = await tree(x.handoffs), later = x.start(), spy = vi.spyOn(later.records, "migrateLegacyGaps");
  await expect(later.migrateGaps({ pauseMs: 0 })).resolves.toMatchObject({ recorded: true, cards: 0 });
  expect(spy).not.toHaveBeenCalled(); expect(await tree(x.handoffs)).toEqual(files);
});

test("a crash inside a card's migration is finished once by the next start: one revision, one archive line per gap, the index in step", async () => {
  const x = await fixture(), before = await x.revision("card-a");
  const crashing = new HandoffStore(x.dir, { fault: (point) => { if (point === "current-synced") throw new Error("power cut"); } });
  await expect(crashing.migrateLegacyGaps("card-a")).rejects.toThrow("power cut");
  expect(await readdir(join(x.handoffs, "card-a"))).toContain("pending.json");
  await x.start().migrateGaps({ pauseMs: 0 });
  const record = await x.service.records.read("card-a", "project");
  expect(record.revision).toBe(before + 1);
  expect(record.gaps.filter((gap) => gap.sourceId?.startsWith("legacy-gaps:"))).toHaveLength(1);
  const lines = (await readFile(join(x.handoffs, "card-a", "archive.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { id: string; rev: number });
  const closed = lines.filter((line) => line.rev === record.revision);
  expect(closed).toHaveLength(50); expect(new Set(closed.map((line) => line.id)).size).toBe(50);
  expect((await x.board.read()).handoffIndex.find((entry) => entry.taskId === "card-a")?.open).toBe(handoffOpenIds(record).length);
});

test("a card restored from removed/ after the migration was recorded is migrated by its restore; an interrupted restore by the next start", async () => {
  const x = await fixture();
  x.board.handoffBackup = async (ids, destination) => { for (const id of ids) await x.service.records.exportCard(id, join(destination, id)); };
  const original = (await x.board.read()).tasks.find((task) => task.id === "card-b")!;
  // card-b is deleted (with its backup, still legacy) before the migration runs.
  await x.service.removeWithBackup(["card-b"], () => x.board.deleteTask({ id: "card-b", revision: original.revision }));
  await x.start().migrateGaps({ pauseMs: 0 });
  expect(await x.marker()).toMatchObject({ version: 1 });
  const removed = join(x.dir, "removed"), backup = await tree(removed);
  await x.board.mutate((board) => { board.tasks.push(original); });
  await x.service.restoreLocal(["card-b"]);
  let record = await x.service.records.read("card-b", "project");
  expect(handoffOpenIds(record)).toHaveLength(1);
  expect(record.gaps.filter((gap) => gap.sourceId?.startsWith("legacy-gaps:"))).toMatchObject([{ count: 20, status: "open" }]);
  expect((await x.board.read()).handoffIndex.find((entry) => entry.taskId === "card-b")?.open).toBe(1);
  expect(await tree(removed)).toEqual(backup);

  // The same backup restored again, this time cut off after its restore intent: the next start finishes and migrates it.
  await x.service.removeWithBackup(["card-b"], () => x.board.deleteTask({ id: "card-b", revision: original.revision }));
  await x.board.mutate((board) => { board.tasks.push(original); });
  const source = join(removed, (await readdir(removed)).find((name) => name.startsWith("task-card-b-") && name.endsWith(".handoffs"))!, "card-b");
  const crashing = new HandoffStore(x.dir, { fault: (point) => { if (point === "restore-intent") throw new Error("power cut"); } });
  await expect(crashing.restoreCard("card-b", source)).rejects.toThrow("power cut");
  expect(await readdir(x.handoffs)).toContain("card-b.restore.json");
  await x.start().migrateGaps({ pauseMs: 0 });
  record = await x.service.records.read("card-b", "project");
  expect(handoffOpenIds(record)).toHaveLength(1);
  expect(await readdir(x.handoffs)).not.toContain("card-b.restore.json");
});
