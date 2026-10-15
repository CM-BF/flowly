import { expect, test } from "vitest";
import { lastViewedProject, pickProject, rememberViewedProject } from "./project-memory";

const projects = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("cold start opens the first project", () => {
  expect(lastViewedProject()).toBe("");
  expect(pickProject(projects, "", lastViewedProject())?.id).toBe("a");
});

test("re-entering the board returns to the project viewed last in this run", () => {
  rememberViewedProject("c");
  rememberViewedProject(undefined);
  expect(pickProject(projects, "", lastViewedProject())?.id).toBe("c");
  expect(pickProject(projects, "b", lastViewedProject())?.id).toBe("b");
});

test("a removed or archived-away project falls back to the first", () => {
  expect(pickProject(projects.slice(0, 2), "", "c")?.id).toBe("a");
  expect(pickProject([], "", "c")).toBeUndefined();
});
