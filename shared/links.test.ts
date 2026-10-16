import { expect, test } from "vitest";
import type { Link, Task } from "./model";
import { linkContextLines, linkFor, linksOf, originLinks, relationOf, waitingOn, wouldCycle } from "./links";

const now = "2026-10-16T00:00:00.000Z";
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/p", repoPaths: ["/p"], title: id.toUpperCase(),
  description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: `o-${id}`,
  createdAt: now, updatedAt: now, archivedAt: null, ...extra,
});
const link = (kind: Link["kind"], from: string, to: string): Link => ({
  id: `${kind}-${from}-${to}`, projectId: "p", kind, from, to, createdBy: "human", createdAt: now,
});

test("each relation reads from both cards and maps back to the stored link", () => {
  expect(relationOf(link("derived", "a", "b"), "a")).toBe("follow_up_of");
  expect(relationOf(link("derived", "a", "b"), "b")).toBe("follow_up");
  expect(relationOf(link("blocks", "a", "b"), "a")).toBe("blocks");
  expect(relationOf(link("blocks", "a", "b"), "b")).toBe("blocked_by");
  expect(relationOf(link("related", "a", "b"), "b")).toBe("related");
  for (const relation of ["blocked_by", "blocks", "follow_up_of", "follow_up", "related"] as const) {
    const stored = linkFor(relation, "a", "b");
    expect(relationOf(stored, "a")).toBe(relation);
  }
});

test("blockers stop holding a card once done, cancelled or archived", () => {
  const tasks = [task("a"), task("b"), task("c", { status: "done" }), task("d", { archivedAt: now }), task("e", { status: "cancelled" })];
  const links = ["b", "c", "d", "e"].map((id) => link("blocks", id, "a"));
  expect(waitingOn({ tasks, links }, "a").map((t) => t.id)).toEqual(["b"]);
  expect(waitingOn({ tasks, links }, "b")).toEqual([]);
});

test("cycles are found per kind, with the path that closes them", () => {
  const links = [link("blocks", "a", "b"), link("blocks", "b", "c"), link("derived", "c", "a")];
  expect(wouldCycle(links, "blocks", "c", "a")).toEqual(["c", "a", "b", "c"]);
  expect(wouldCycle(links, "blocks", "b", "a")).toEqual(["b", "a", "b"]);
  expect(wouldCycle(links, "blocks", "a", "c")).toBeUndefined();
  // A derived link does not count toward a blocks cycle, and related never cycles.
  expect(wouldCycle(links, "derived", "b", "c")).toBeUndefined();
  expect(wouldCycle(links, "derived", "a", "c")).toEqual(["a", "c", "a"]);
  expect(wouldCycle(links, "related", "c", "a")).toBeUndefined();
});

test("idea origins become derived links, skipping missing sources", () => {
  const tasks = [task("a"), task("b", { origin: { taskId: "a", ideaId: "i" } }), task("c", { origin: { taskId: "gone", ideaId: "j" } })];
  expect(originLinks(tasks)).toEqual([
    { id: "origin-b", projectId: "p", kind: "derived", from: "b", to: "a", ideaId: "i", createdBy: "system", createdAt: now },
  ]);
});

test("session context lines list links by relation, unresolved blockers only, with a cap", () => {
  const tasks = [task("a"), task("b"), task("c", { status: "done" }), ...Array.from({ length: 3 }, (_, i) => task(`r${i}`))];
  const links = [
    link("blocks", "b", "a"),
    link("blocks", "c", "a"),
    link("derived", "a", "b"),
    ...[0, 1, 2].map((i) => link("related", "a", `r${i}`)),
  ];
  const lines = linkContextLines(linksOf({ tasks, links }, "a"), (t) => t.status, 2);
  expect(lines).toEqual([
    "Follow-up of: B (b) [todo]",
    "Blocked by: B (b) [todo]",
    "Related: R0 (r0) [todo]",
    "Related: R1 (r1) [todo]",
    "Related: …and 1 more",
  ]);
});
