import { expect, test } from "vitest";
import type { Board, Link, Status, Task } from "./model";
import { automationSettingsSchema, motionOf, parentShouldWake, subCardSignature, turnDecision, type AutomationJob } from "./automation";

// SUB-CARDS-SPEC §5: a card moves while its own sub-cards do, at any depth, whatever its own job says.
const at = "2026-10-23T00:00:00.000Z";
const now = Date.parse(at);
const on = automationSettingsSchema.parse({ enabled: true, maxRunning: 2 });
const task = (id: string, status: Status = "development", extra: Partial<Task> = {}): Task => ({
  id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/p", repoPaths: [], title: id, description: "", status,
  priority: "normal", position: 0, revision: 1, operationId: `op-${id}`, createdAt: at, updatedAt: at, archivedAt: null, ...extra,
});
const job = (taskId: string, extra: Partial<AutomationJob> = {}): AutomationJob => ({
  taskId, projectId: "p", state: "working", role: "implementer", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: at, updatedAt: at, ...extra,
});
const sub = (from: string, to: string): Link => ({ id: `${from}-sub-${to}`, projectId: "p", kind: "subtask", from, to, createdBy: "human", createdAt: at });
const blocks = (from: string, to: string): Link => ({ id: `${from}-blocks-${to}`, projectId: "p", kind: "blocks", from, to, createdBy: "human", createdAt: at });
const board = (over: Partial<Board>) =>
  ({ projects: [{ id: "p", title: "p", description: "", paseoProjectId: "n", primaryPath: "/p", repos: ["/p"], revision: 1, createdAt: at, updatedAt: at, archivedAt: null, automation: on }], tasks: [], links: [], events: [], automation: [], ...over }) as unknown as Board;
const jobIn = (b: Board, id: string) => b.automation.find((j) => j.taskId === id)!;
const taskIn = (b: Board, id: string) => b.tasks.find((t) => t.id === id)!;
const silentEnd = (b: Board) => turnDecision(b, { ...jobIn(b, "P"), state: "working" }, "pa", { kind: "completed" }, on, now);

/** The 2026-10-23 incident: P's sub-card C failed its own coordination, and C's sub-card G is still being reviewed. */
const incident = () =>
  board({
    tasks: [task("P"), task("C"), task("G", "in_review")],
    links: [sub("C", "P"), sub("G", "C")],
    automation: [job("P", { implementerId: "pa" }), job("C", { state: "failed", code: "failed", implementerId: "ca" }), job("G", { state: "reviewing", role: "reviewer", implementerId: "ga", reviewerId: "gr" })],
  });

test("a sub-card whose own job failed still moves while its sub-cards move: the parent waits instead of being nudged", () => {
  const b = incident();
  expect(motionOf(b, now).has("C")).toBe(true);
  const decision = silentEnd(b);
  expect(decision).toMatchObject({ kind: "await_children" });
  Object.assign(jobIn(b, "P"), { state: "waiting", subSeen: decision.kind === "await_children" ? decision.signature : "" });
  expect(parentShouldWake(b, jobIn(b, "P"), motionOf(b, now))).toBe(false);
  // The grandchild's review settles: nothing moves C any more, so P is told once.
  Object.assign(jobIn(b, "G"), { state: "delivered", role: "implementer", verdict: "approved" });
  expect(motionOf(b, now).has("C")).toBe(false);
  expect(parentShouldWake(b, jobIn(b, "P"), motionOf(b, now))).toBe(true);
  jobIn(b, "P").subSeen = subCardSignature(b, "P", motionOf(b, now));
  expect(parentShouldWake(b, jobIn(b, "P"), motionOf(b, now))).toBe(false);
});

test("motion climbs every level, also through a card nobody automates", () => {
  const b = board({
    tasks: [task("P"), task("C"), task("M"), task("G")],
    links: [sub("C", "P"), sub("M", "C"), sub("G", "M")],
    automation: [job("P", { implementerId: "pa" }), job("G", { implementerId: "ga" })],
  });
  expect([...motionOf(b, now)].sort()).toEqual(["C", "G", "M", "P"]);
  expect(silentEnd(b)).toMatchObject({ kind: "await_children" });
  jobIn(b, "G").state = "stopped";
  expect(motionOf(b, now).has("C")).toBe(false);
  expect(silentEnd(b)).toMatchObject({ kind: "nudge" });
});

test.each([
  ["Done", (x: Task): void => { x.status = "done"; }],
  ["Cancelled", (x: Task): void => { x.status = "cancelled"; }],
  ["archived", (x: Task): void => { x.archivedAt = at; }],
] as const)("a %s sub-card does not move, whatever is still running under it", (_, end) => {
  const b = incident();
  end(taskIn(b, "C"));
  expect(motionOf(b, now).has("C")).toBe(false);
  expect(silentEnd(b)).toMatchObject({ kind: "nudge" });
});

test("a blocker kept moving by its own sub-cards keeps the card it holds moving", () => {
  const b = board({
    tasks: [task("P"), task("X"), task("Y", "todo"), task("XG")],
    links: [sub("X", "P"), sub("Y", "P"), sub("XG", "X"), blocks("X", "Y")],
    automation: [job("P", { implementerId: "pa" }), job("X", { state: "failed", implementerId: "xa" }), job("Y", { state: "queued" }), job("XG", { implementerId: "xga" })],
  });
  expect(motionOf(b, now).has("Y")).toBe(true);
  jobIn(b, "XG").state = "stopped";
  expect(motionOf(b, now).has("Y")).toBe(false);
});
