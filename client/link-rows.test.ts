import { expect, test } from "vitest";
import type { Link, Task } from "../shared/model";
import { linksOf } from "../shared/links";
import { groupFor, groupOf, linkCandidates } from "./link-rows";

const now = "2026-10-16T00:00:00.000Z";
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/p", repoPaths: ["/p"], title: `Card ${id}`,
  description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: `o-${id}`,
  createdAt: now, updatedAt: now, archivedAt: null, ...extra,
});
const link = (kind: Link["kind"], from: string, to: string): Link => ({
  id: `${kind}-${from}-${to}`, projectId: "p", kind, from, to, createdBy: "human", createdAt: now,
});

test("blockers sit under Waiting on until resolved, then under Was waiting on", () => {
  const tasks = [task("a"), task("b"), task("c", { status: "done" })];
  const links = [link("blocks", "b", "a"), link("blocks", "c", "a"), link("derived", "a", "b")];
  expect(linksOf({ tasks, links }, "a").map(groupOf)).toEqual(["waiting", "waited", "follow_up_of"]);
  expect(linksOf({ tasks, links }, "b").map(groupOf)).toEqual(["blocks", "follow_up"]);
});

test("the picker lists live cards of the project and marks those linked that way", () => {
  const tasks = [task("a"), task("b"), task("c"), task("x", { projectId: "q" }), task("z", { archivedAt: now })];
  const links = [link("related", "b", "a"), link("blocks", "a", "c")];
  const shown = (relation: Parameters<typeof linkCandidates>[3], query = "") =>
    linkCandidates(tasks, links, tasks[0], relation, query).map((c) => `${c.task.id}${c.linked ? "*" : ""}`);
  // Related is refused once any link exists; Blocks / Blocked by once a blocks link exists either way.
  expect(shown("related")).toEqual(["b*", "c*"]);
  expect(shown("blocks")).toEqual(["b", "c*"]);
  expect(shown("blocked_by")).toEqual(["b", "c*"]);
  expect(shown("follow_up_of")).toEqual(["b", "c"]);
  expect(shown("follow_up_of", " CARD C")).toEqual(["c"]);
});

test("a Cancelled or archived blocker of a queued card holds it, so it stays under Waiting on (CARD-TREE-SPEC §2.6)", () => {
  const tasks = [task("a"), task("x", { status: "cancelled" }), task("y", { archivedAt: now }), task("d", { status: "done" })];
  const links = [link("blocks", "x", "a"), link("blocks", "y", "a"), link("blocks", "d", "a")];
  const views = linksOf({ tasks, links }, "a");
  expect(views.map(groupFor(true))).toEqual(["waiting", "waiting", "waited"]);
  // Without a queued job the dispatcher does not care: they count as resolved, as before.
  expect(views.map(groupFor(false))).toEqual(["waited", "waited", "waited"]);
});
