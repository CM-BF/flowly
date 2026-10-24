import { expect, test } from "vitest";
import { laneRows } from "./lane-rows";

const card = (id: string) => ({ id });
const shape = (rows: ReturnType<typeof laneRows<{ id: string }>>) => rows.map((r) => (r.kind === "task" ? r.task.id : r.kind));

test("recent cards come first, then the older toggle, then older cards only when shown", () => {
  expect(shape(laneRows([card("a"), card("b")], [card("o")], false))).toEqual(["a", "b", "older"]);
  expect(shape(laneRows([card("a")], [card("o1"), card("o2")], true))).toEqual(["a", "older", "o1", "o2"]);
  expect(shape(laneRows([card("a")], [], true))).toEqual(["a"]);
});

test("an empty lane has one placeholder that knows whether older cards exist", () => {
  expect(laneRows([], [], false)).toEqual([{ key: "empty", kind: "empty", hasOlder: false, hidden: 0 }]);
  const rows = laneRows([], [card("o")], false);
  expect(rows).toEqual([
    { key: "empty", kind: "empty", hasOlder: true, hidden: 0 },
    { key: "older", kind: "older" },
  ]);
});

test("row keys are unique, so a card never shares a key with a placeholder", () => {
  const keys = laneRows([card("a")], [card("o")], true).map((r) => r.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("rows that did not change keep their identity", async () => {
  const { sameRows } = await import("./lane-rows");
  const a = card("a"),
    b = card("b");
  const first = laneRows([a, b], [], false);
  expect(sameRows(first, laneRows([a, b], [], false))).toBe(first);
  const edited = laneRows([a, { id: "b" }], [], false);
  expect(sameRows(first, edited)).toBe(edited);
  const shorter = laneRows([a], [], false);
  expect(sameRows(first, shorter)).toBe(shorter);
  const first2 = laneRows([], [], false);
  const withOlder = laneRows([], [a], false);
  expect(sameRows(first2, withOlder)).toBe(withOlder);
  expect(sameRows(undefined, first)).toBe(first);
});

test("the Levels footer sits after the current cards and before the older toggle (CARD-TREE-SPEC §2.3)", () => {
  expect(shape(laneRows([card("a")], [card("o")], false, { count: 2, shown: false }))).toEqual(["a", "levels", "older"]);
  expect(shape(laneRows([card("a"), card("s")], [card("o")], true, { count: 1, shown: true }))).toEqual(["a", "s", "levels", "older", "o"]);
  expect(shape(laneRows([card("a")], [], false, { count: 0, shown: false }))).toEqual(["a"]);
});

test("a lane left with only hidden sub-cards says so above its footer", () => {
  expect(laneRows([], [], false, { count: 3, shown: false })).toEqual([
    { key: "empty", kind: "empty", hasOlder: false, hidden: 3 },
    { key: "levels", kind: "levels", count: 3, shown: false },
  ]);
});

test("a changed Levels count or footer state hands the list new rows", async () => {
  const { sameRows } = await import("./lane-rows");
  const a = card("a");
  const first = laneRows([a], [], false, { count: 2, shown: false });
  expect(sameRows(first, laneRows([a], [], false, { count: 2, shown: false }))).toBe(first);
  const more = laneRows([a], [], false, { count: 3, shown: false });
  expect(sameRows(first, more)).toBe(more);
  const shown = laneRows([a], [], false, { count: 2, shown: true });
  expect(sameRows(first, shown)).toBe(shown);
  const empty = laneRows([], [], false, { count: 2, shown: false });
  const emptier = laneRows([], [], false, { count: 1, shown: false });
  expect(sameRows(empty, emptier)).toBe(emptier);
});
