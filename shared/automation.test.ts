import { expect, test } from "vitest";
import type { Board, Project, Status, Task } from "./model";
import { automationSettingsSchema, subCardActive, dispatchPlan, readiness, reviewerJob, turnDecision, type AutomationJob, type AutomationSettings } from "./automation";

const at = "2026-10-22T00:00:00.000Z";
const now = Date.parse(at);
const project = (id: string, automation?: Project["automation"]): Project => ({
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
  ...(automation ? { automation } : {}),
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
const settings = (extra: Partial<AutomationSettings> = {}) => automationSettingsSchema.parse({ enabled: true, ...extra });
const board = (over: Partial<Board> = {}) =>
  ({ projects: [project("p", automationSettingsSchema.parse({ enabled: true, maxRunning: 2 }))], tasks: [], links: [], events: [], automation: [], ...over }) as unknown as Board;
const blocks = (from: string, to: string) => ({ id: `${from}-${to}`, projectId: "p", kind: "blocks" as const, from, to, createdBy: "human" as const, createdAt: at });

test("a queued card waits for every blocker to be Done; a cancelled blocker never releases it", () => {
  const b = board({ tasks: [task("a", "development"), task("b"), task("c", "cancelled")], links: [blocks("a", "b")] });
  expect(readiness(b, "b")).toMatchObject({ ready: false, reason: "blockers", waiting: [{ id: "a" }], cancelled: [] });
  b.tasks[0].status = "done";
  expect(readiness(b, "b")).toEqual({ ready: true });
  b.links.push(blocks("c", "b"));
  expect(readiness(b, "b")).toMatchObject({ ready: false, cancelled: [{ id: "c" }] });
  expect(readiness(b, "c")).toEqual({ ready: false, reason: "finished" });
});

test("the dispatcher fills free slots by priority, skips waiting cards and projects with automation off", () => {
  const b = board({
    projects: [project("p", automationSettingsSchema.parse({ enabled: true, maxRunning: 2 })), project("off")],
    tasks: [task("low", "todo", { priority: "low" }), task("urgent", "todo", { priority: "urgent" }), task("busy", "development"), task("waits"), task("x", "todo", { projectId: "off" })],
    links: [blocks("busy", "waits")],
    automation: [job("low"), job("urgent", { queuedAt: "2026-10-22T01:00:00.000Z" }), job("busy", { state: "working" }), job("waits"), job("x", { projectId: "off" })],
  });
  expect(dispatchPlan(b, now).start.map((j) => j.taskId)).toEqual(["urgent"]);
  b.automation.find((j) => j.taskId === "busy")!.state = "needs_human";
  // A session waiting for a person holds no slot (Hermes counts claimed work only).
  expect(dispatchPlan(b, now).start.map((j) => j.taskId)).toEqual(["urgent", "low"]);
});

test("a retry is due at its time, not before", () => {
  const b = board({ tasks: [task("a", "development")], automation: [job("a", { state: "retry_wait", retryAt: new Date(now + 1000).toISOString() })] });
  expect(dispatchPlan(b, now).retry).toEqual([]);
  expect(dispatchPlan(b, now + 1000).retry.map((j) => j.taskId)).toEqual(["a"]);
});

const ended = (b: Board, agentId: string) =>
  b.events.push({ id: `e${b.events.length}`, taskId: "a", actor: "system", action: "agent.turn_started", agentId, at });
const decide = (status: Status, j: Partial<AutomationJob>, s = settings(), outcome: Parameters<typeof turnDecision>[3] = { kind: "completed" }, b = board({ tasks: [task("a", status)] })) =>
  turnDecision(b, job("a", { state: "working", implementerId: "impl", reviewerId: "rev", ...j }), j.role === "reviewer" ? "rev" : "impl", outcome, s, now);

test("a delivery goes to review while rounds remain, otherwise to the user", () => {
  expect(decide("in_review", {})).toEqual({ kind: "deliver", unreviewed: true });
  const reviewed = settings({ reviewer: { provider: "claude", model: "m" }, maxReviewRounds: 2 });
  expect(decide("in_review", { reviewRounds: 1 }, reviewed)).toEqual({ kind: "review" });
  expect(decide("in_review", { reviewRounds: 2 }, reviewed)).toEqual({ kind: "deliver", code: "review_rounds" });
});

test("only a delivery with a verdict on it is settled again; new work after feedback gets fresh review rounds", () => {
  const reviewed = settings({ reviewer: { provider: "claude", model: "m" }, maxReviewRounds: 1 });
  const b = board({ tasks: [task("a", "in_review")] });
  b.events.push({ id: "d1", taskId: "a", actor: "agent", action: "status_changed", agentId: "impl", to: "in_review", at });
  const judge = (j: Partial<AutomationJob>) => decide("in_review", { reviewRounds: 1, ...j }, reviewed, { kind: "completed" }, b);
  // A casual answer after the verdict on d1 (also for jobs recorded before reviewedEvent existed).
  expect(judge({ verdict: "approved", reviewedEvent: "d1", deliveryEvent: "d1", reopened: true })).toEqual({ kind: "deliver" });
  expect(judge({ verdict: "approved", deliveryEvent: "d1", reopened: true })).toEqual({ kind: "deliver" });
  // d1 was under review but got no verdict before the person spoke to the implementer.
  expect(judge({ deliveryEvent: "d1", reopened: true })).toEqual({ kind: "review", delivery: "d1" });
  // New work after feedback on a final-round approval.
  b.events.push({ id: "d2", taskId: "a", actor: "agent", action: "status_changed", agentId: "impl", to: "in_review", at });
  expect(judge({ verdict: "approved", reviewedEvent: "d1", deliveryEvent: "d1", reopened: true })).toEqual({ kind: "review", delivery: "d2" });
  expect(judge({ verdict: "changes", reviewedEvent: "d1", deliveryEvent: "d1" })).toEqual({ kind: "deliver", code: "review_rounds" });
  expect(decide("in_review", { verdict: "approved", reviewedEvent: "d1", reopened: true }, settings(), { kind: "completed" }, b)).toEqual({ kind: "deliver", unreviewed: true });
});

test("questions and blockers wait for a person; a silent end is nudged, then blocks the card", () => {
  const blocked = board({ tasks: [task("a", "blocked")] });
  ended(blocked, "impl");
  blocked.events.push({ id: "b", taskId: "a", actor: "agent", action: "status_changed", agentId: "impl", from: "development", to: "blocked", at });
  expect(decide("blocked", {}, settings(), { kind: "completed" }, blocked)).toEqual({ kind: "wait", code: "blocked" });
  // Blocked by someone else (rule A1r restoring it after a silent turn on a re-run card) is a silent turn.
  const restored = board({ tasks: [task("a", "blocked")] });
  ended(restored, "impl");
  restored.events.push({ id: "r", taskId: "a", actor: "system", action: "status_changed", agentId: "impl", rule: "A1r", from: "design", to: "blocked", at });
  expect(decide("blocked", {}, settings(), { kind: "completed" }, restored)).toEqual({ kind: "nudge", count: 1 });
  const b = board({ tasks: [task("a", "development")] });
  ended(b, "impl");
  b.events.push({ id: "q", taskId: "a", actor: "agent", action: "progress_reported", agentId: "impl", reportKind: "question", at });
  expect(decide("development", {}, settings(), { kind: "completed" }, b)).toEqual({ kind: "wait", code: "question" });
  expect(decide("development", { nudges: 1 })).toEqual({ kind: "nudge", count: 2 });
  expect(decide("development", { nudges: 2 })).toEqual({ kind: "give_up", code: "no_delivery", blockCard: true });
});

test("failed turns retry with backoff up to the limit; an interrupted turn waits", () => {
  const failed = { kind: "failed" as const, message: "boom" };
  expect(decide("development", {}, settings({ failureLimit: 3 }), failed)).toEqual({ kind: "retry", count: 1, at: new Date(now + 30_000).toISOString() });
  expect(decide("development", { failures: 1 }, settings({ failureLimit: 3 }), failed)).toEqual({ kind: "retry", count: 2, at: new Date(now + 60_000).toISOString() });
  expect(decide("development", { failures: 2 }, settings({ failureLimit: 3 }), failed)).toEqual({ kind: "give_up", code: "failed", blockCard: true });
  expect(decide("development", {}, settings(), { kind: "canceled" })).toEqual({ kind: "wait", code: "interrupted" });
});

test("a reviewer without a verdict is nudged and never blocks the delivered card; other sessions are ignored", () => {
  expect(decide("in_review", { role: "reviewer", state: "reviewing" })).toEqual({ kind: "nudge", count: 1 });
  expect(decide("in_review", { role: "reviewer", state: "reviewing", nudges: 2 })).toEqual({ kind: "give_up", code: "review_incomplete", blockCard: false });
  expect(decide("development", { role: "reviewer", state: "reviewing" })).toEqual({ kind: "stop", code: "card_moved" });
  expect(decide("done", {})).toEqual({ kind: "stop", code: "card_finished" });
  const b = board({ tasks: [task("a", "development")] });
  expect(turnDecision(b, job("a", { state: "working", implementerId: "impl" }), "someone-else", { kind: "completed" }, settings(), now)).toEqual({ kind: "ignore" });
});

test("the job's reviewer session is exempt from rule A1 while the job runs or its delivery waits; not after the job ended", () => {
  const b = board({ automation: [job("a", { state: "reviewing", role: "reviewer", reviewerId: "rev", implementerId: "impl" })] });
  expect(reviewerJob(b, "rev")?.taskId).toBe("a");
  b.automation[0].state = "delivered";
  b.automation[0].role = "implementer";
  expect(reviewerJob(b, "rev")?.taskId).toBe("a");
  expect(reviewerJob(b, "impl")).toBeUndefined();
  b.automation[0].state = "stopped";
  expect(reviewerJob(b, "rev")).toBeUndefined();
});


test("a transitive sibling dependency can settle so its parent can accept the delivered prerequisite", () => {
  const sub = (from: string) => ({ id: `sub-${from}`, projectId: "p", kind: "subtask" as const, from, to: "parent", createdBy: "human" as const, createdAt: at });
  const b = board({ tasks: [task("parent"), task("a", "in_review"), task("b"), task("c")], links: [sub("a"), sub("b"), sub("c"), blocks("a", "b"), blocks("b", "c")], automation: [job("a", { state: "delivered" }), job("b"), job("c")] });
  expect(subCardActive(b, "b")).toBe(false);
  expect(subCardActive(b, "c")).toBe(false);
  b.tasks[1].status = "done";
  expect(subCardActive(b, "c")).toBe(true);
});
