import { expect, test } from "vitest";
import { sortTasks } from "./sort";
import type { Task } from "./model";

const task = (id: string, extra: Partial<Task>): Task =>
  ({ id, title: id, position: 0, priority: "normal", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...extra }) as Task;
const ids = (tasks: Task[]) => tasks.map((t) => t.id);

test("each sort mode orders a column and falls back to the manual order", () => {
  const tasks = [
    task("b", { position: 1, priority: "urgent", title: "beta", createdAt: "2026-10-03T00:00:00Z" }),
    task("a", { position: 0, priority: "low", title: "Alpha 10", updatedAt: "2026-10-05T00:00:00Z" }),
    task("c", { position: 2, priority: "urgent", title: "alpha 9", createdAt: "2026-10-02T00:00:00Z" }),
  ];
  expect(ids(sortTasks(tasks, "manual"))).toEqual(["a", "b", "c"]);
  expect(ids(sortTasks(tasks, "priority"))).toEqual(["b", "c", "a"]);
  expect(ids(sortTasks(tasks, "created"))).toEqual(["b", "c", "a"]);
  expect(ids(sortTasks(tasks, "title"))).toEqual(["c", "a", "b"]);
  // Session activity counts as well as task edits.
  expect(ids(sortTasks(tasks, "activity"))).toEqual(["a", "b", "c"]);
  expect(ids(sortTasks(tasks, "activity", new Map([["c", "2026-10-09T00:00:00Z"]])))).toEqual(["c", "a", "b"]);
  expect(ids(tasks)).toEqual(["b", "a", "c"]); // input untouched
});
