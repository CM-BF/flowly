import { afterEach, expect, test, vi } from "vitest";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { handoffOpenIds } from "../shared/handoff";
import { HandoffStore } from "./handoff-store";
import { tree } from "./handoff-collect-fixture";
import { flowly, legacyGap, many, migrationFixture, session } from "./handoff-gap-migration-fixture";

// A card restored from removed/ brings back the legacy gaps its backup held (SESSION-HANDOFF-SPEC §21.17). Its migration
// is owed durably from before the restore starts until it committed and its index entry was synced, whatever stops it in
// between, before or after the one-time run was recorded. Temporary directories only.
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const cards = ["card-a", "card-b"];

/** card-b removed with a legacy backup; `recorded`: the one-time run then recorded its marker without it. */
async function fixture(recorded = true) {
  const x = await migrationFixture(cards); dirs.push(x.dir);
  for (const card of cards) await x.service.records.setSession(card, "project", session("w1", 1, "implementer"), { ...flowly, sourceId: "session:w1" });
  for (const card of cards) await x.write(card, [...many(30, (n) => legacyGap("w1", "type", "unknown_record_type", n, { hint: "token_usage_record" })), ...many(20, (n) => legacyGap("w1", "opaque", "opaque_tool_background", 100 + n))]);
  for (const card of cards) await x.service.syncIndex(card);
  x.board.handoffBackup = async (ids, destination) => { for (const id of ids) await x.service.records.exportCard(id, join(destination, id)); };
  const original = (await x.board.read()).tasks.find((task) => task.id === "card-b")!;
  await x.service.removeWithBackup(["card-b"], () => x.board.deleteTask({ id: "card-b", revision: original.revision }));
  if (recorded) await x.start().migrateGaps({ pauseMs: 0 });
  const marker = () => readFile(join(x.handoffs, ".gap-migration.json"), "utf8").then((text) => JSON.parse(text), () => null);
  if (recorded) expect(await marker()).toMatchObject({ version: 1, failed: [] });
  await x.board.mutate((board) => { board.tasks.push(original); });
  const removed = join(x.dir, "removed");
  const source = join(removed, (await readdir(removed)).find((name) => name.startsWith("task-card-b-") && name.endsWith(".handoffs"))!, "card-b");
  const migrated = async (service = x.start()) => {
    const record = await service.records.read("card-b", "project");
    return { open: handoffOpenIds(record).length, groups: record.gaps.filter((gap) => gap.sourceId?.startsWith("legacy-gaps:")).map((gap) => gap.count), index: (await x.board.read()).handoffIndex.find((entry) => entry.taskId === "card-b")?.open };
  };
  return { ...x, source, marker, migrated };
}

test("a restore cut off after its intent and finished by an ordinary read before the start's pass is still migrated", async () => {
  const x = await fixture();
  const crashing = new HandoffStore(x.dir, { fault: (point) => { if (point === "restore-intent") throw new Error("power cut"); } });
  await expect(crashing.restoreCard("card-b", x.source)).rejects.toThrow("power cut");
  // Next start: within the 90 s before the pass, the drawer, a poll or the automation reads the card and finishes the restore.
  const next = x.start();
  await next.records.read("card-b");
  expect(await readdir(x.handoffs)).not.toContain("card-b.restore.json");
  await expect(next.migrateGaps({ pauseMs: 0 })).resolves.toMatchObject({ cards: 1, migrated: 1, recorded: true });
  expect(await x.migrated(next)).toEqual({ open: 1, groups: [20], index: 1 });
  expect((await x.marker()).pending ?? []).toEqual([]);
});

test("a crash during a restored card's own migration, before its write was durable, is retried at the next start", async () => {
  const x = await fixture();
  // The restore completes; the process dies while that card's migration writes its bodies.
  const crashing = new HandoffStore(x.dir, { fault: (point) => { if (point === "bodies-synced") throw new Error("power cut"); } });
  await crashing.restoreCard("card-b", x.source);
  await expect(crashing.migrateLegacyGaps("card-b")).rejects.toThrow("power cut");
  expect((await x.marker()).pending).toEqual(["card-b"]);
  const next = x.start();
  await next.migrateGaps({ pauseMs: 0 });
  expect(await x.migrated(next)).toEqual({ open: 1, groups: [20], index: 1 });
  expect((await x.marker()).pending ?? []).toEqual([]);
  // A later start reads no card and writes nothing.
  const files = await tree(x.handoffs), later = x.start(), spy = vi.spyOn(later.records, "migrateLegacyGaps");
  await expect(later.migrateGaps({ pauseMs: 0 })).resolves.toMatchObject({ cards: 0, recorded: true });
  expect(spy).not.toHaveBeenCalled(); expect(await tree(x.handoffs)).toEqual(files);
});

test("a restore during the first run whose migration fails is retried at the next start, and the run's record keeps it", async () => {
  const x = await fixture(false);
  const service = x.start(), records = service.records, migrate = records.migrateLegacyGaps.bind(records);
  // While the first run is on card-a (card-b was not in its list), the person restores card-b; that migration fails once.
  vi.spyOn(records, "migrateLegacyGaps").mockImplementation(async (taskId, ...rest) => {
    if (taskId === "card-a") { const result = await migrate(taskId, ...rest); await service.restoreLocal(["card-b"]); return result; }
    throw new Error("transient failure");
  });
  await expect(service.migrateGaps({ pauseMs: 0 })).resolves.toMatchObject({ cards: 1, migrated: 1, recorded: true });
  vi.restoreAllMocks();
  expect(await x.marker()).toMatchObject({ version: 1, failed: [], pending: ["card-b"] });
  expect((await x.migrated(service)).open).toBe(50);
  const later = x.start();
  await expect(later.migrateGaps({ pauseMs: 0 })).resolves.toMatchObject({ cards: 1, migrated: 1 });
  expect(await x.migrated(later)).toEqual({ open: 1, groups: [20], index: 1 });
  expect((await x.marker()).pending ?? []).toEqual([]);
});

test("a restore that migrates its card settles what it owed; one with nothing to migrate leaves nothing owed", async () => {
  const x = await fixture();
  await x.service.restoreLocal(["card-b"]);
  expect(await x.migrated()).toEqual({ open: 1, groups: [20], index: 1 });
  expect((await x.marker()).pending ?? []).toEqual([]);
  // The next start has nothing left to do.
  const later = x.start(), spy = vi.spyOn(later.records, "migrateLegacyGaps");
  await expect(later.migrateGaps({ pauseMs: 0 })).resolves.toMatchObject({ cards: 0, recorded: true });
  expect(spy).not.toHaveBeenCalled();
});
