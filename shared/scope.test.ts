import { expect, test } from "vitest";
import { sessionContext } from "./scope";
import type { Project, Task } from "./model";

const project = { id: "p", title: "P", primaryPath: "/r", repos: ["/r"] } as Project;
const task = { id: "t", title: "Fix login", description: "Steps", repoPaths: [] } as unknown as Task;

test("session context names the task type only when the card has one", () => {
  const paths = [{ repo: "/r", directory: "/r" }];
  expect(sessionContext(task, project, paths, "/r")).not.toContain("Task type:");
  expect(sessionContext({ ...task, type: "bugfix" }, project, paths, "/r")).toContain("Task ID: t\nTask type: Bug fix\nSteps");
});

test("session context lists the card's tags only when it has some", () => {
  const paths = [{ repo: "/r", directory: "/r" }];
  expect(sessionContext(task, project, paths, "/r")).not.toContain("Tags:");
  const tagged = { ...task, type: "bugfix", tags: [{ tag: "drawer", by: "human", at: "x" }, { tag: "perf", by: "agent", at: "x" }] } as Task;
  expect(sessionContext(tagged, project, paths, "/r")).toContain("Task type: Bug fix\nTags: drawer, perf\nSteps");
});
