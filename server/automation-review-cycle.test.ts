import { afterEach, expect, test, vi } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures, underReview } from "./automation-fixture";

// AUTOMATION-SPEC §4.2-§5: which delivery a verdict belongs to, and whose turns can end or reopen a job.
afterEach(cleanupAutomationFixtures);

const as = (agentId: string) => ({ agentId, taskId: "a", workspaceId: "w-a" });
const toReviewer = (x: Awaited<ReturnType<typeof setup>>, rev: string) => x.sent.filter((s) => s.agentId === rev);

test("feedback after a final-round approval: the reworked delivery is reviewed again and loses the old approval", async () => {
  const { x, impl, rev } = await underReview({ maxReviewRounds: 1 });
  await x.automation.submitReview(as(rev), { verdict: "approve", summary: "Checked" });
  await x.endTurn(rev, "a");
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved" });
  // The person asks the implementer for more; it reworks and delivers again.
  await x.startTurn(impl, "a");
  expect((await x.task("a")).status).toBe("development");
  await x.deliver(impl, "a");
  await x.endTurn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", role: "reviewer", reviewRounds: 1 });
  expect((await x.job("a")).verdict).toBeUndefined();
  await vi.waitFor(() => expect(toReviewer(x, rev).at(-1)?.text).toMatch(/review round 1 of 1/));
  expect(x.created).toHaveLength(2);
});

test("a rework delivered after the reviewer was turned off keeps no stale approval", async () => {
  const { x, impl, rev } = await underReview();
  await x.automation.submitReview(as(rev), { verdict: "approve", summary: "Checked" });
  await x.endTurn(rev, "a");
  await x.startTurn(impl, "a");
  await x.store.mutate((b) => { delete b.projects[0].automation!.reviewer; });
  await x.deliver(impl, "a");
  await x.endTurn(impl, "a");
  const job = await x.job("a");
  expect(job.state).toBe("delivered");
  expect(job.verdict).toBeUndefined();
});

test("a casual implementer turn during a review does not settle the card unreviewed; the reviewer's verdict still counts", async () => {
  const { x, impl, rev } = await underReview();
  // The person says something to the implementer while the reviewer works; nothing new is delivered.
  await x.startTurn(impl, "a");
  await x.endTurn(impl, "a");
  expect((await x.task("a")).status).toBe("in_review");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", role: "reviewer" });
  expect((await x.job("a")).verdict).toBeUndefined();
  // The reviewer, still in its turn, gives its verdict: it is recorded, not refused as a closed round.
  await expect(x.automation.submitReview(as(rev), { verdict: "approve", summary: "Checked" })).resolves.toMatchObject({ accepted: true });
  await x.endTurn(rev, "a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved" });
  expect(toReviewer(x, rev)).toHaveLength(0);
});

test("a person moving a delivered card between work stages keeps it revivable, and the rework is reviewed", async () => {
  const { x, impl, rev } = await underReview();
  await x.automation.submitReview(as(rev), { verdict: "approve", summary: "Checked" });
  await x.endTurn(rev, "a");
  await x.store.mutate((b) => { b.tasks[0].status = "development"; });
  await x.automation.cardMoved("a", "in_review", "development");
  expect((await x.job("a")).state).toBe("delivered");
  await x.startTurn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "working", reopened: true });
  await x.deliver(impl, "a");
  await x.endTurn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 1 });
});

test.each(["todo", "backlog", "blocked"] as const)("a delivered card a person takes back to %s stops; the implementer's next turn does not reopen it", async (lane) => {
  const x = await setup();
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  expect((await x.job("a")).state).toBe("delivered");
  await x.store.mutate((b) => { b.tasks[0].status = lane; });
  await x.automation.cardMoved("a", "in_review", lane);
  expect(await x.job("a")).toMatchObject({ state: "stopped", code: "card_moved" });
  await x.startTurn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "stopped", code: "card_moved" });
  expect((await x.store.read()).events.some((e) => e.action === "automation_resumed")).toBe(false);
});

test("the job's own reviewer talking after an approval leaves the job and the card alone", async () => {
  const { x, rev } = await underReview();
  await x.automation.submitReview(as(rev), { verdict: "approve", summary: "Checked" });
  await x.endTurn(rev, "a");
  // "Why did you approve?"
  await x.startTurn(rev, "a");
  await x.endTurn(rev, "a");
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved" });
  expect((await x.task("a")).status).toBe("in_review");
});

test("the job's own reviewer talking during the rework does not stop supervising the implementer", async () => {
  const { x, impl, rev } = await underReview();
  await x.automation.submitReview(as(rev), { verdict: "changes", summary: "Tests missing", findings: ["no test"] });
  await x.endTurn(rev, "a");
  await vi.waitFor(() => expect(x.sent.at(-1)).toMatchObject({ agentId: impl, text: expect.stringMatching(/requested changes/) }));
  await x.startTurn(rev, "a");
  await x.endTurn(rev, "a");
  expect(await x.job("a")).toMatchObject({ state: "working", role: "implementer" });
  await x.deliver(impl, "a");
  await x.endTurn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 2 });
  await vi.waitFor(() => expect(toReviewer(x, rev).at(-1)?.text).toMatch(/review round 2 of 3/));
});

test("another managed session taking over the card stops the job and says so", async () => {
  const x = await setup();
  await x.automation.queue("a");
  await x.automation.kick();
  await x.automation.turnStarted("someone-else", "a");
  expect(await x.job("a")).toMatchObject({ state: "stopped", code: "card_moved" });
  expect((await x.store.read()).events.filter((e) => e.action === "automation_stopped")).toHaveLength(1);
});

test("Run again reuses the earlier reviewer session, and talking to it does not stop the new run", async () => {
  const { x, impl, rev } = await underReview();
  await x.automation.stopJob("a");
  await x.store.mutate((b) => { b.tasks[0].status = "development"; });
  x.agents.get(impl)!.status = "idle";
  x.agents.get(rev)!.status = "idle";
  await x.automation.queue("a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "working", generation: 2, reviewerId: rev });
  await x.startTurn(rev, "a");
  await x.endTurn(rev, "a");
  expect((await x.job("a")).state).toBe("working");
  await x.startTurn(impl, "a");
  await x.deliver(impl, "a");
  await x.endTurn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewerId: rev });
  await vi.waitFor(() => expect(toReviewer(x, rev).at(-1)?.text).toMatch(/review round 1 of 3/));
  expect(x.created).toHaveLength(2);
});
