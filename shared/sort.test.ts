import { expect, test } from "vitest";
import { latestTurnEnds, sortTasks, turnEndActivity } from "./sort";
import type { BoardEvent, Task } from "./model";

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
  // Without turn ends a card counts from its creation; task edits do not move it.
  expect(ids(sortTasks(tasks, "activity"))).toEqual(["b", "c", "a"]);
  expect(ids(sortTasks(tasks, "activity", new Map([["c", "2026-10-09T00:00:00Z"]])))).toEqual(["c", "b", "a"]);
  expect(ids(tasks)).toEqual(["b", "a", "c"]); // input untouched
});

const event = (taskId: string, action: string, at: string, agentId = "s-" + taskId) =>
  ({ id: `${taskId}-${at}`, taskId, actor: "system", action, agentId, at }) as BoardEvent;

test("recent activity follows turn ends only", () => {
  const tasks = [
    task("a", { position: 0, workspaceId: "wa", updatedAt: "2026-10-09T00:00:00Z" }),
    task("b", { position: 1, workspaceId: "wb" }),
    task("c", { position: 2, workspaceId: "wc" }),
  ];
  const ends = latestTurnEnds([
    event("b", "agent.turn_ended", "2026-10-04T00:00:00Z"),
    event("b", "agent.turn_ended", "2026-10-03T00:00:00Z"),
    event("a", "agent.turn_ended", "2026-10-02T00:00:00Z"),
    // A turn that started later but has not ended does not count.
    event("a", "agent.turn_started", "2026-10-08T00:00:00Z"),
  ]);
  expect(ends.agents).toEqual(new Set(["s-b", "s-a"]));
  expect(ends.byTask.get("b")).toBe("2026-10-04T00:00:00Z");
  // a's newer task edit (updatedAt) does not count.
  expect(ids(sortTasks(tasks, "activity", turnEndActivity(tasks, ends.byTask)))).toEqual(["b", "a", "c"]);
  // A settled non-Kanban session in c's workspace is newest.
  const settled = new Map([["wc", "2026-10-05T00:00:00Z"], ["wb", "2026-10-01T00:00:00Z"]]);
  const activity = turnEndActivity(tasks, ends.byTask, settled);
  expect(activity.get("b")).toBe("2026-10-04T00:00:00Z");
  expect(ids(sortTasks(tasks, "activity", activity))).toEqual(["c", "b", "a"]);
});
