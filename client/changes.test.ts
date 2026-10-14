import { expect, test } from "vitest";
import { statusChanges } from "./changes";

test("only cards that existed before and changed status are reported", () => {
  const first = statusChanges(null, [{ id: "a", status: "todo" }]);
  expect(first.changed).toEqual([]);
  const second = statusChanges(first.next, [
    { id: "a", status: "in_progress" },
    { id: "b", status: "todo" },
  ]);
  expect(second.changed).toEqual(["a"]);
  expect(statusChanges(second.next, [{ id: "a", status: "in_progress" }]).changed).toEqual([]);
});
