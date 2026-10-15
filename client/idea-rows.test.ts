import { expect, test } from "vitest";
import { exitRows } from "./idea-rows";

const a = { id: "a" }, b = { id: "b" }, c = { id: "c" }, d = { id: "d" };

test("a leaving idea keeps its slot while it collapses", () => {
  expect(exitRows([a, c], [{ item: b, index: 1 }], new Set(["a", "b", "c"]))).toEqual([
    { item: a, leaving: false, entering: false },
    { item: b, leaving: true, entering: false },
    { item: c, leaving: false, entering: false },
  ]);
});

test("only ideas that arrive after the drawer opened rise in", () => {
  expect(exitRows([a, d], [], new Set(["a"])).map((r) => r.entering)).toEqual([false, true]);
});

test("an idea that came back is not also shown as leaving; out-of-range slots go last", () => {
  expect(exitRows([a, b], [{ item: b, index: 0 }, { item: c, index: 9 }], new Set(["a", "b", "c"]))).toEqual([
    { item: a, leaving: false, entering: false },
    { item: b, leaving: false, entering: false },
    { item: c, leaving: true, entering: false },
  ]);
});
