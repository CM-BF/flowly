import { expect, test } from "vitest";
import type { Board, Link, Project, Status, Task } from "./model";
import {
  automationAllowed,
  automationSettingsSchema,
  dispatchPlan,
  parentShouldWake,
  providerCooling,
  subCardActive,
  subCardSignature,
  turnDecision,
  type AutomationJob,
} from "./automation";

const at = "2026-10-22T00:00:00.000Z";
const now = Date.parse(at);
const on = (extra: Record<string, unknown> = {}) => automationSettingsSchema.parse({ enabled: true, maxRunning: 2, ...extra });
const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id,
  title: id,
  description: "",
  paseoProjectId: `n-${id}`,
  primaryPath: "/p",
  repos: ["/p"],
  revision: 1,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  automation: on(),
  ...extra,
});
const task = (id: string, status: Status = "todo", extra: Partial<Task> = {}): Task => ({
  id,
  projectId: "p",
  workspaceId: `w-${id}`,
  sourcePath: "/p",
  repoPaths: [],
  title: id,
  description: "",
  status,
  priority: "normal",
  position: 0,
  revision: 1,
  operationId: `op-${id}`,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  ...extra,
});
const job = (taskId: string, extra: Partial<AutomationJob> = {}): AutomationJob => ({
  taskId,
  projectId: "p",
  state: "queued",
  role: "implementer",
  generation: 1,
  nudges: 0,
  failures: 0,
  reviewRounds: 0,
  queuedAt: at,
  updatedAt: at,
  ...extra,
});
const board = (over: Partial<Board> = {}) => ({ projects: [project("p")], tasks: [], links: [], events: [], automation: [], ...over }) as unknown as Board;
const blocks = (from: string, to: string): Link => ({ id: `${from}-blocks-${to}`, projectId: "p", kind: "blocks", from, to, createdBy: "human", createdAt: at });
const sub = (from: string, to: string): Link => ({ id: `${from}-sub-${to}`, projectId: "p", kind: "subtask", from, to, createdBy: "human", createdAt: at });
const jobIn = (b: Board, id: string) => b.automation.find((j) => j.taskId === id)!;
const taskIn = (b: Board, id: string) => b.tasks.find((t) => t.id === id)!;
const silentEnd = (b: Board, parent = "P", agentId = "pa") => turnDecision(b, { ...jobIn(b, parent), state: "working" }, agentId, { kind: "completed" }, on(), now);

test.each(["question", "blocked", "permission", "interrupted", "cooldown"] as const)("a sub-card waiting for a person (%s) still moves: its parent keeps waiting instead of being woken and nudged", (code) => {
  const b = board({
    tasks: [task("P", "development"), task("C", "development")],
    links: [sub("C", "P")],
    automation: [job("P", { state: "waiting", implementerId: "pa" }), job("C", { state: "working", implementerId: "ca" })],
  });
  jobIn(b, "P").subSeen = subCardSignature(b, "P");
  Object.assign(jobIn(b, "C"), { state: "needs_human", code });
  expect(subCardActive(b, "C")).toBe(true);
  expect(parentShouldWake(b, jobIn(b, "P"))).toBe(false);
  // A silent parent turn while the child waits for a person goes back to waiting, it is not nudged.
  expect(silentEnd(b)).toMatchObject({ kind: "await_children" });
  // The person answered and the child delivered: the parent wakes.
  Object.assign(jobIn(b, "C"), { state: "delivered", code: undefined });
  taskIn(b, "C").status = "in_review";
  expect(parentShouldWake(b, jobIn(b, "P"))).toBe(true);
});

test("a queued sub-card held by a card outside its parent's tree moves only while that blocker itself moves", () => {
  const b = board({
    tasks: [task("P", "development"), task("C"), task("X", "development")],
    links: [sub("C", "P"), blocks("X", "C")],
    automation: [job("P", { state: "working", implementerId: "pa" }), job("C"), job("X", { state: "working", implementerId: "xa" })],
  });
  expect(subCardActive(b, "C")).toBe(true);
  expect(silentEnd(b)).toMatchObject({ kind: "await_children" });
  // Delivered for a person, failed, stopped, or never run by automation: nothing moves it, so the parent is told.
  taskIn(b, "X").status = "in_review";
  for (const state of ["delivered", "failed", "stopped"] as const) {
    jobIn(b, "X").state = state;
    expect(subCardActive(b, "C"), state).toBe(false);
  }
  b.automation = b.automation.filter((j) => j.taskId !== "X");
  expect(subCardActive(b, "C")).toBe(false);
  expect(silentEnd(b)).toMatchObject({ kind: "nudge" });
  // Being reviewed by its own automation is moving, In review or not.
  b.automation.push(job("X", { state: "reviewing", role: "reviewer", implementerId: "xa", reviewerId: "xr" }));
  expect(subCardActive(b, "C")).toBe(true);
  // Done releases the sub-card, which then starts.
  taskIn(b, "X").status = "done";
  expect(subCardActive(b, "C")).toBe(true);
});

test("an outside blocker that is itself queued behind its own blockers is followed, and a dependency cycle ends", () => {
  const b = board({
    tasks: [task("P", "development"), task("C"), task("X"), task("Y", "development")],
    links: [sub("C", "P"), blocks("X", "C"), blocks("Y", "X")],
    automation: [job("P", { state: "waiting", implementerId: "pa" }), job("C"), job("X"), job("Y", { state: "working", implementerId: "ya" })],
  });
  expect(subCardActive(b, "C")).toBe(true);
  jobIn(b, "Y").state = "stopped";
  expect(subCardActive(b, "C")).toBe(false);
  // Stored data can hold a cycle (links added before the cycle checks): the walk stops instead of recursing forever.
  b.links.push(blocks("X", "Y"));
  jobIn(b, "Y").state = "queued";
  taskIn(b, "Y").status = "todo";
  expect(subCardActive(b, "C")).toBe(false);
});

test("a grandchild held by its parent's sibling no longer deadlocks both parents: the parent wakes and can ask a person", () => {
  // G splits into S and P; P splits into C1 and C2, and C2 needs S (in review, which only G can accept).
  const b = board({
    tasks: [task("G", "development"), task("S", "in_review"), task("P", "development"), task("C1", "in_review"), task("C2")],
    links: [sub("S", "G"), sub("P", "G"), sub("C1", "P"), sub("C2", "P"), blocks("S", "C2")],
    automation: [
      job("G", { state: "waiting", implementerId: "ga", subSeen: "old" }),
      job("S", { state: "delivered", implementerId: "sa" }),
      job("P", { state: "waiting", implementerId: "pa", subSeen: "old" }),
      job("C1", { state: "delivered", implementerId: "c1a" }),
      job("C2"),
    ],
  });
  expect(subCardActive(b, "C2")).toBe(false);
  expect(parentShouldWake(b, jobIn(b, "P"))).toBe(true);
  // G still waits while P works on it; once P is done with its turn and settles, G wakes and can accept S.
  expect(parentShouldWake(b, jobIn(b, "G"))).toBe(false);
  jobIn(b, "P").state = "failed";
  expect(parentShouldWake(b, jobIn(b, "G"))).toBe(true);
});

test.each([
  ["cancelled", (x: Task): void => { x.status = "cancelled"; }],
  ["archived", (x: Task): void => { x.archivedAt = at; }],
] as const)("a waiting parent wakes when its sub-card's outside blocker is %s", (_, end) => {
  const b = board({
    tasks: [task("P", "development"), task("C"), task("X", "development")],
    links: [sub("C", "P"), blocks("X", "C")],
    automation: [job("P", { state: "working", implementerId: "pa" }), job("C"), job("X", { state: "working", implementerId: "xa" })],
  });
  const decision = silentEnd(b);
  expect(decision).toMatchObject({ kind: "await_children" });
  Object.assign(jobIn(b, "P"), { state: "waiting", subSeen: decision.kind === "await_children" ? decision.signature : "" });
  expect(parentShouldWake(b, jobIn(b, "P"))).toBe(false);
  end(taskIn(b, "X"));
  jobIn(b, "X").state = "stopped";
  expect(subCardActive(b, "C")).toBe(false);
  expect(parentShouldWake(b, jobIn(b, "P"))).toBe(true);
});

test("a parent wakes only with a free slot, its automation on, and no archived or cancelled ancestor", () => {
  const settled = () =>
    board({
      tasks: [task("G", "development"), task("P", "development"), task("C", "in_review"), task("other", "development")],
      links: [sub("P", "G"), sub("C", "P")],
      automation: [job("P", { state: "waiting", implementerId: "pa", subSeen: "stale" }), job("C", { state: "delivered" })],
      projects: [project("p", { automation: on({ maxRunning: 1 }) })],
    });
  const base = settled();
  expect(parentShouldWake(base, jobIn(base, "P"))).toBe(true);
  const cases: [string, (b: Board) => void][] = [
    ["full slots", (b) => void b.automation.push(job("other", { state: "working" }))],
    ["automation off", (b) => void delete b.projects[0].automation],
    ["automation disabled", (b) => void (b.projects[0].automation = on({ enabled: false }))],
    ["parent archived", (b) => void (taskIn(b, "P").archivedAt = at)],
    ["grandparent cancelled", (b) => void (taskIn(b, "G").status = "cancelled")],
    ["grandparent archived", (b) => void (taskIn(b, "G").archivedAt = at)],
  ];
  for (const [name, change] of cases) {
    const b = settled();
    change(b);
    expect(parentShouldWake(b, jobIn(b, "P")), name).toBe(false);
  }
});

test.each([
  ["its parent is cancelled", (b: Board): void => { taskIn(b, "child").status = "cancelled"; }],
  ["its parent is archived", (b: Board): void => { taskIn(b, "child").archivedAt = at; }],
  ["the top card is cancelled", (b: Board): void => { taskIn(b, "top").status = "cancelled"; }],
  ["the top card is archived", (b: Board): void => { taskIn(b, "top").archivedAt = at; }],
] as const)("a queued grandchild is not dispatched when %s", (_, change) => {
  const b = board({ tasks: [task("top", "development"), task("child", "development"), task("grand")], links: [sub("child", "top"), sub("grand", "child")], automation: [job("grand")] });
  expect(automationAllowed(b, jobIn(b, "grand"))).toBe(true);
  expect(dispatchPlan(b, now).start.map((j) => j.taskId)).toEqual(["grand"]);
  change(b);
  expect(automationAllowed(b, jobIn(b, "grand"))).toBe(false);
  expect(dispatchPlan(b, now).start).toEqual([]);
});

test("a provider cooldown holds back that provider's cards only; an unknown provider never holds back other projects", () => {
  const cooling = (taskId: string, projectId: string, provider?: string) =>
    job(taskId, { projectId, state: "retry_wait", code: "cooldown", retryAt: new Date(now + 600_000).toISOString(), ...(provider ? { provider } : {}) });
  const claude = { provider: "claude", model: "claude-haiku-4-5" };
  const codex = { provider: "codex", model: "gpt-6-luna" };
  const b = board({
    projects: [project("A", { automation: on({ implementer: codex }) }), project("B"), project("C", { agentModel: claude }), project("D", { agentModel: codex })],
    tasks: [task("a1", "development", { projectId: "A" }), task("a2", "todo", { projectId: "A" }), task("b1", "todo", { projectId: "B" }), task("c1", "todo", { projectId: "C" }), task("d1", "todo", { projectId: "D" })],
    automation: [cooling("a1", "A", "codex"), job("a2", { projectId: "A" }), job("b1", { projectId: "B" }), job("c1", { projectId: "C" }), job("d1", { projectId: "D" })],
  });
  const started = (fallback?: string) => dispatchPlan(b, now, fallback).start.map((j) => j.taskId).sort();
  // Codex cools down: A and D (codex) wait; C (claude) and B (provider unknown) start.
  expect(started()).toEqual(["b1", "c1"]);
  // B follows the global default model: codex waits too, claude does not.
  expect(started("codex")).toEqual(["c1"]);
  expect(providerCooling(b, b.projects[1], now, "claude")).toBe(false);
  // A cooling job whose provider was never recorded holds back its own project only.
  delete jobIn(b, "a1").provider;
  expect(started()).toEqual(["b1", "c1", "d1"]);
});
