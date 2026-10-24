import { expect, test } from "vitest";
import { levelOf, levelRecordLimit, withSubCardLevel } from "./card-levels";

// CARD-TREE-SPEC §2.3: one Levels value per project in the host-level board view; absent is All.
test("a missing, out-of-range or deeper-than-the-cap value reads as All", () => {
  expect(levelOf(undefined, "p")).toBeNull();
  expect(levelOf({}, "p")).toBeNull();
  expect(levelOf({ subCardLevels: { p: 2 } }, "p")).toBe(2);
  expect(levelOf({ subCardLevels: { p: 4 } }, "p")).toBeNull();
  expect(levelOf({ subCardLevels: { p: 0 } }, "p")).toBeNull();
  expect(levelOf({ subCardLevels: { q: 1 } }, "p")).toBeNull();
});

test("setting a level keeps other live projects, drops removed ones, and All removes the key", () => {
  const stored = { p: 1, q: 2, gone: 3 };
  const live = new Set(["p", "q", "r"]);
  expect(withSubCardLevel(stored, "r", 3, live)).toEqual({ p: 1, q: 2, r: 3 });
  expect(withSubCardLevel(stored, "p", null, live)).toEqual({ q: 2 });
  expect(withSubCardLevel(undefined, "p", 1, live)).toEqual({ p: 1 });
  expect(stored).toEqual({ p: 1, q: 2, gone: 3 });
});

test("at most the limit is kept, the changed project always among them", () => {
  const ids = Array.from({ length: levelRecordLimit + 5 }, (_, i) => `p${i}`);
  const record = Object.fromEntries(ids.map((id) => [id, 1]));
  const next = withSubCardLevel(record, "p0", 2, new Set(ids));
  expect(Object.keys(next)).toHaveLength(levelRecordLimit);
  expect(next.p0).toBe(2);
});
