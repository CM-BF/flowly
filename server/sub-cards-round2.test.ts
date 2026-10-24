import { afterEach, expect, test, vi } from "vitest";
import { rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { AutomationService } from "./automation";
import type { Task } from "../shared/model";
import type { AutomationJob } from "../shared/automation";

// A parent card's agent managing its sub-cards through flowly_update_card (SUB-CARDS-SPEC §4, §8).
// The AutomationService has no Paseo connection: it records jobs and never dispatches.
const roots: string[] = [];
const automations: AutomationService[] = [];
afterEach(async () => {
  await Promise.all(automations.splice(0).map((service) => service.stop()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const job = (taskId: string, extra: Partial<AutomationJob> = {}): AutomationJob => ({
  taskId, projectId: "p", role: "implementer", state: "queued", generation: 1,
  nudges: 0, failures: 0, reviewRounds: 0,
  queuedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra,
});

/** Card t is the parent (this session's card); `child` is its direct sub-card with the given lane and job. */
async function setup(status: Task["status"], childJob?: Partial<AutomationJob>) {
  const x = await agentFixture();
  roots.push(x.root);
  await x.store.mutate((board) => {
    board.projects[0].automation = { enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 };
    board.tasks.push({ ...board.tasks[0], id: "child", title: "Child", workspaceId: "child-workspace", operationId: "child-operation", status });
    board.links.push({ id: "parent-link", kind: "subtask", projectId: "p", from: "child", to: "t", createdBy: "human", createdAt: new Date().toISOString() });
    if (childJob) board.automation.push(job("child", { implementerId: "child-session", ...childJob }));
  });
  const automation = new AutomationService(x.store, { prepare: async () => { throw new Error("must not prepare"); }, globalModel: async () => null });
  automations.push(automation);
  x.service.automation = automation;
  const onStatusChange = vi.fn();
  x.service.onStatusChange = onStatusChange;
  const request = async () => {
    const context = await x.service.get(x.identity);
    return { expectedRevision: context.revision, request: context.request };
  };
  const start = async (note?: string) => x.service.updateCard(x.identity, { ...(await request()), cardId: "child", action: "start", ...(note === undefined ? {} : { note }) });
  const childJob_ = async () => (await x.store.read()).automation.find((j) => j.taskId === "child");
  /** The child's implementer delivers the rework again: In review, job delivered. */
  const redeliver = () =>
    x.store.mutate((board) => {
      const child = board.tasks.find((t) => t.id === "child")!;
      child.status = "in_review";
      child.revision++;
      Object.assign(board.automation.find((j) => j.taskId === "child")!, { state: "delivered", reviewRounds: 3, code: "review_rounds" });
    });
  return { ...x, automation, onStatusChange, request, start, childJob: childJob_, redeliver };
}

test("restarting a delivered sub-card carries the parent's note to its implementer", async () => {
  const x = await setup("in_review", { state: "delivered", reviewRounds: 3, code: "review_rounds" });
  const answer = await x.start("Handle the empty input case");
  expect(answer).toMatchObject({ queued: true, status: "development" });
  expect(answer.replayed).toBeUndefined();
  expect(await x.childJob()).toMatchObject({ state: "queued", generation: 2, implementerId: "child-session", feedback: "Handle the empty input case" });
  expect((await x.store.read()).events.filter((e) => e.taskId === "child" && e.note === "Handle the empty input case")).toHaveLength(1);
});

test.each(["", "   "])("restarting a delivered sub-card without a note (%j) is refused and changes nothing", async (note) => {
  const x = await setup("in_review", { state: "delivered" });
  const before = await x.store.read();
  await expect(x.start(note)).rejects.toMatchObject({ code: "FEEDBACK_REQUIRED" });
  expect(await x.store.read()).toEqual(before);
  expect(x.onStatusChange).not.toHaveBeenCalled();
});

test.each([
  { lane: "development", state: "needs_human", code: "question", role: "implementer", refusal: "NEEDS_PERSON" },
  { lane: "in_review", state: "needs_human", code: "question", role: "reviewer", refusal: "NEEDS_PERSON" },
  { lane: "development", state: "working", role: "implementer", refusal: "CHILD_BUSY" },
  { lane: "in_review", state: "reviewing", role: "reviewer", refusal: "CHILD_BUSY" },
  { lane: "todo", state: "queued", role: "implementer", refusal: "CHILD_BUSY" },
] as const)("a note for a sub-card whose job is $state ($lane) is refused as $refusal, never acknowledged and dropped", async ({ lane, state, role, refusal, ...rest }) => {
  const x = await setup(lane, { state, role, reviewerId: "child-reviewer", ...("code" in rest ? { code: rest.code } : {}) });
  const before = await x.store.read();
  await expect(x.start("Use the v2 endpoint")).rejects.toMatchObject({ code: refusal, message: expect.stringMatching(/note was not delivered/) });
  // Nothing was recorded: no receipt, no event, no feedback; the job goes on as it was.
  expect(await x.store.read()).toEqual(before);
  expect(x.onStatusChange).not.toHaveBeenCalled();
});

test("start without a note on a sub-card that is already running is acknowledged and changes nothing", async () => {
  const x = await setup("development", { state: "working" });
  const before = (await x.store.read()).automation;
  expect(await x.start()).toMatchObject({ queued: true, replayed: true, status: "development" });
  expect((await x.store.read()).automation).toEqual(before);
});

test.each(["finished", "archived"] as const)("a retried accept after the parent was %s returns the recorded result", async (change) => {
  const x = await setup("in_review", { state: "delivered" });
  const input = { ...(await x.request()), cardId: "child", action: "accept" as const };
  expect(await x.service.updateCard(x.identity, input)).toMatchObject({ status: "done" });
  await x.store.mutate((board) => {
    const parent = board.tasks.find((t) => t.id === "t")!;
    if (change === "finished") parent.status = "done";
    else parent.archivedAt = new Date().toISOString();
    parent.revision++;
  });
  const before = await x.store.read();
  // The first response was lost: the same request again gets its receipt, not TASK_FINISHED or ARCHIVED.
  expect(await x.service.updateCard(x.identity, input)).toMatchObject({ cardId: "child", status: "done", replayed: true });
  expect(await x.store.read()).toEqual(before);
  // A new request is still refused.
  await expect(x.service.updateCard(x.identity, { ...(await x.request()), cardId: "child", action: "cancel" })).rejects.toMatchObject({ code: change === "finished" ? "TASK_FINISHED" : "ARCHIVED" });
});

test("a parent's agent restarts a delivered sub-card at most twice until a person runs it again", async () => {
  const x = await setup("in_review", { state: "delivered", reviewRounds: 3, code: "review_rounds" });
  await x.start("Make the tests pass (1)");
  await x.redeliver();
  await x.start("Make the tests pass (2)");
  await x.redeliver();
  const before = await x.store.read();
  await expect(x.start("Make the tests pass (3)")).rejects.toMatchObject({ code: "NEEDS_PERSON" });
  expect(await x.store.read()).toEqual(before);
  // A person's Run again gives the agent its restarts back.
  await x.automation.queue("child");
  expect((await x.childJob())?.generation).toBe(4);
  await x.redeliver();
  expect(await x.start("Make the tests pass (4)")).toMatchObject({ queued: true });
  expect(await x.childJob()).toMatchObject({ state: "queued", generation: 5, feedback: "Make the tests pass (4)" });
});

test("a person moving a delivered sub-card gives the parent's agent its restarts back", async () => {
  const x = await setup("in_review", { state: "delivered" });
  await x.start("Rework (1)");
  await x.redeliver();
  await x.start("Rework (2)");
  await x.redeliver();
  await expect(x.start("Rework (3)")).rejects.toMatchObject({ code: "NEEDS_PERSON" });
  // The person drags it back to Development: the job stays delivered (AUTOMATION-SPEC §4.3), the budget resets.
  const child = (await x.store.read()).tasks.find((t) => t.id === "child")!;
  await x.store.editTask({ id: "child", revision: child.revision, status: "development", actor: "human" });
  await x.automation.cardMoved("child", "in_review", "development");
  expect(await x.childJob()).toMatchObject({ state: "delivered" });
  expect(await x.start("Rework (3)")).toMatchObject({ queued: true });
  await x.redeliver();
  await x.start("Rework (4)");
  await x.redeliver();
  await expect(x.start("Rework (5)")).rejects.toMatchObject({ code: "NEEDS_PERSON" });
});

test.each(["cancelled", "archived"] as const)("under a %s ancestor, the parent's agent cannot start a sub-card but can still cancel it", async (root) => {
  const x = await setup("backlog");
  await x.store.mutate((board) => {
    board.tasks.push({ ...board.tasks[0], id: "root", title: "Root", workspaceId: "root-workspace", operationId: "root-operation", status: root === "cancelled" ? "cancelled" : "development", archivedAt: root === "archived" ? new Date().toISOString() : null });
    board.links.push({ id: "root-link", kind: "subtask", projectId: "p", from: "t", to: "root", createdBy: "human", createdAt: new Date().toISOString() });
  });
  await expect(x.start()).rejects.toMatchObject({ code: "ANCESTOR_FINISHED", message: expect.stringContaining("Root") });
  expect(await x.childJob()).toBeUndefined();
  expect((await x.store.read()).tasks.find((t) => t.id === "child")!.status).toBe("backlog");
  await expect(x.service.updateCard(x.identity, { ...(await x.request()), cardId: "child", action: "cancel" })).resolves.toMatchObject({ status: "cancelled" });
});

test.each([
  { state: "reviewing", code: undefined },
  { state: "needs_human", code: "question" },
  { state: "retry_wait", code: "failed" },
] as const)("accepting a sub-card while its own review is still open ($state) is refused and changes nothing", async ({ state, code }) => {
  const x = await setup("in_review", { state, role: "reviewer", reviewerId: "child-reviewer", reviewRounds: 1, ...(code ? { code } : {}) });
  const before = await x.store.read();
  await expect(x.service.updateCard(x.identity, { ...(await x.request()), cardId: "child", action: "accept" })).rejects.toMatchObject({ code: "REVIEW_RUNNING", message: expect.stringMatching(/woken/) });
  expect(await x.store.read()).toEqual(before);
  expect(x.onStatusChange).not.toHaveBeenCalled();
  // The verdict is in: the delivery can be accepted, and cancelling was never blocked.
  await x.store.mutate((board) => { Object.assign(board.automation.find((j) => j.taskId === "child")!, { state: "delivered", role: "implementer", verdict: "approved", code: undefined }); });
  expect(await x.service.updateCard(x.identity, { ...(await x.request()), cardId: "child", action: "accept" })).toMatchObject({ status: "done" });
});

test("cancelling a sub-card under review stays possible", async () => {
  const x = await setup("in_review", { state: "reviewing", role: "reviewer", reviewerId: "child-reviewer", reviewRounds: 1 });
  expect(await x.service.updateCard(x.identity, { ...(await x.request()), cardId: "child", action: "cancel" })).toMatchObject({ status: "cancelled" });
});
