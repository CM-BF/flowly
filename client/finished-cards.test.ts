import { expect, test } from "vitest";
import { olderFinished } from "./finished-cards";
import type { BoardEvent, Task } from "../shared/model";

const now = Date.parse("2026-10-16T12:00:00.000Z");
const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
const task = (id: string, status: Task["status"], updatedAt: string): Task => ({
  id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/r", repoPaths: ["/r"], title: id, description: "",
  status, priority: "normal", position: 0, revision: 1, operationId: id, createdAt: daysAgo(90), updatedAt, archivedAt: null,
});
const moved = (taskId: string, to: Task["status"], at: string): BoardEvent => ({
  id: `${taskId}-${at}`, taskId, actor: "human", action: "status_changed", from: "development", to, at,
});

test("hides only Done/Cancelled cards older than the cutoff", () => {
  const tasks = [task("old-done", "done", daysAgo(10)), task("new-done", "done", daysAgo(2)), task("old-cancel", "cancelled", daysAgo(30)), task("old-dev", "development", daysAgo(40))];
  expect([...olderFinished(tasks, [], 7, now)].sort()).toEqual(["old-cancel", "old-done"]);
});

test("the move into the lane wins over a later edit", () => {
  const tasks = [task("a", "done", daysAgo(1))];
  expect([...olderFinished(tasks, [moved("a", "done", daysAgo(9))], 7, now)]).toEqual(["a"]);
  // A move into another lane does not count.
  expect([...olderFinished(tasks, [moved("a", "cancelled", daysAgo(9))], 7, now)]).toEqual([]);
  // Reopened and finished again: the latest move counts.
  expect([...olderFinished(tasks, [moved("a", "done", daysAgo(20)), moved("a", "done", daysAgo(2))], 7, now)]).toEqual([]);
});

test("0 days hides nothing and the open card stays", () => {
  const tasks = [task("a", "done", daysAgo(10)), task("b", "done", daysAgo(10))];
  expect(olderFinished(tasks, [], 0, now).size).toBe(0);
  expect([...olderFinished(tasks, [], 7, now, "a")]).toEqual(["b"]);
});
