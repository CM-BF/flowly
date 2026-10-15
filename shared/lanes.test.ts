import { expect, test } from "vitest";
import { enabledStatuses, laneName, laneProblem, projectLanes } from "./lanes";

test("lanes default to the built-in workflow and honour order, names and toggles", () => {
  expect(enabledStatuses(undefined)).toEqual(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]);
  const project = {
    lanes: [
      { status: "todo" as const, enabled: true, name: "Ready" },
      { status: "in_progress" as const, enabled: true },
      { status: "done" as const, enabled: true },
      { status: "backlog" as const, enabled: false },
      { status: "in_review" as const, enabled: false },
      { status: "blocked" as const, enabled: false },
      { status: "cancelled" as const, enabled: false },
    ],
  };
  expect(enabledStatuses(project)).toEqual(["todo", "in_progress", "done"]);
  expect(laneName(project, "todo")).toBe("Ready");
  expect(laneName(project, "done")).toBe("Done");
  expect(laneProblem(project, "blocked")).toMatch(/not a lane/);
  expect(laneProblem(project, "todo")).toBe("");
  expect(projectLanes(project)).toHaveLength(7);
});
