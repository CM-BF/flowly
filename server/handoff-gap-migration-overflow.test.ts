import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { handoffOpenIds, type HandoffGap } from "../shared/handoff";
import { handoffView } from "../shared/handoff-view";
import { bodyReferences } from "./handoff-collect-fixture";
import { flowly, legacyGap, many, migrationFixture, session } from "./handoff-gap-migration-fixture";

// The legacy noise filled the 40-entry gap list and pushed the real gaps into the overflow index, where the drawer and the
// agent's default view count them as omitted. The migration empties the list, so in the same transaction it moves the open
// gaps the overflow holds back into it while it has room, unchanged (SESSION-HANDOFF-SPEC §21.17). Temporary directories only.
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const real = (n: number) => ({ section: "gaps" as const, value: { id: `g:real-${n}`, sourceId: `git-coverage:card-a:${n}`, kind: "flowly", agentId: "w1", text: `${n + 1} repository locations were not inspected. Git coverage is partial; verify the remaining directories.`, status: "open" } });

async function fixture(reals: number) {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  await x.service.records.setSession("card-a", "project", session("w1", 1, "implementer"), { ...flowly, sourceId: "session:w1" });
  // The real gaps first, then the noise of the polls that followed: the real ones are the oldest and leave the list first.
  await x.write("card-a", [...Array.from({ length: reals }, (_, n) => real(n)) as never[], ...many(60, (n) => legacyGap("w1", "type", "unknown_record_type", n, { hint: "token_usage_record" })), ...many(10, (n) => legacyGap("w1", "opaque", "opaque_tool_background", 1000 + n))]);
  const bodies = async () => {
    const record = await x.service.records.read("card-a", "project"), all = new Map<string, HandoffGap>(record.gaps.map((gap) => [gap.id, gap]));
    for (const entry of record.overflow.filter((e) => e.section === "gaps")) all.set(entry.id, (await x.service.records.page("card-a", { entryId: entry.id })).items[0].value as HandoffGap);
    return { record, all };
  };
  return { ...x, bodies };
}

test("the open gaps the overflow holds come back into the list the migration emptied, byte for byte, and the view lists them", async () => {
  const x = await fixture(30), before = await x.bodies();
  const parked = before.record.overflow.filter((entry) => entry.section === "gaps" && entry.id.startsWith("g:real-")).map((entry) => entry.id);
  expect(parked.length).toBe(30);
  await x.service.migrateGaps({ pauseMs: 0 });
  const after = await x.bodies();
  expect(after.record.revision).toBe(before.record.revision + 1);
  expect(after.record.overflow.filter((entry) => entry.section === "gaps")).toEqual([]);
  // Unchanged entries (same rev, time, body and content reference); only their place changed.
  for (const id of parked) { expect(after.record.gaps.find((gap) => gap.id === id)).toEqual(before.all.get(id)); }
  expect(handoffOpenIds(after.record).sort()).toEqual([...parked, ...after.record.gaps.filter((gap) => gap.sourceId?.startsWith("legacy-gaps:")).map((gap) => gap.id)].sort());
  // The agent's default view and the drawer read the current list: every open gap is there, nothing is omitted.
  const view = handoffView(after.record);
  expect(view.record.gaps.map((gap) => gap.id).sort()).toEqual(handoffOpenIds(after.record).sort());
  expect(view.omitted).toBe(0);
  expect((await bodyReferences(x.handoffs, "card-a")).missing).toEqual([]);
  expect((await x.board.read()).handoffIndex.find((entry) => entry.taskId === "card-a")?.open).toBe(handoffOpenIds(after.record).length);
});

test("past the list's room the oldest open gaps stay in the overflow, and the card still needs checking once the list is settled", async () => {
  const x = await fixture(45);
  await x.service.migrateGaps({ pauseMs: 0 });
  let record = await x.service.records.read("card-a", "project");
  // 40 entries: the one grouped script gap and 39 real ones; the six oldest real ones stay where they were.
  expect(record.gaps).toHaveLength(40);
  expect(record.overflow.filter((entry) => entry.section === "gaps").map((entry) => entry.id)).toEqual(Array.from({ length: 6 }, (_, n) => `g:real-${n}`));
  // The successor settles everything in the list: the overflow's open gaps still count.
  for (;;) {
    const open = record.gaps.filter((gap) => gap.status === "open").slice(0, 10);
    if (!open.length) break;
    await x.service.records.update("card-a", "project", { handoffRevision: record.revision, gaps: open.map((gap) => ({ id: gap.id, status: "closed" as const, note: "checked" })) }, { by: { kind: "agent", agentId: "w1" } });
    record = await x.service.records.read("card-a", "project");
  }
  await x.service.syncIndex("card-a");
  expect((await x.board.read()).handoffIndex.find((entry) => entry.taskId === "card-a")).toMatchObject({ open: 6, fresh: false });
});
