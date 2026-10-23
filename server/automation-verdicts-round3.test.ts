import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures, underReview } from "./automation-fixture";
import type { AutomationJob } from "../shared/automation";

// AUTOMATION-SPEC §3, §4.2: a casual answer keeps the verdict also after the card's history (100 events per card)
// no longer holds the delivery the verdict was given on.
afterEach(cleanupAutomationFixtures);

const as = (agentId: string) => ({ agentId, taskId: "a", workspaceId: "w-a" });
type Fixture = Awaited<ReturnType<typeof setup>>;
const toReviewer = (x: Fixture, rev: string) => x.sent.filter((s) => s.agentId === rev);
const deliveryKept = async (x: Fixture, id: string | undefined) => (await x.store.read()).events.some((e) => e.id === id);

/** The person asks the implementer something; it answers without changing anything (rules A1, then A1r). */
async function casualTurn(x: Fixture, impl: string) {
  await x.startTurn(impl, "a");
  await x.endTurn(impl, "a");
  await x.automation.kick();
}

/** Fill the bounded history through the real event writer, without hundreds of unrelated disk commits. */
async function fillHistory(x: Fixture, impl: string) {
  await x.store.mutate((board) => {
    for (let i = 0; i < 105; i++) x.store.event(board, { taskId: "a", actor: "agent", agentId: impl, action: "progress_reported", note: `History ${i}` });
  });
}

test("casual turns after an approval keep it after the delivery has left the card's history, and start no review", async () => {
  const { x, impl, rev } = await underReview({ maxReviewRounds: 1 });
  await x.automation.submitReview(as(rev), { verdict: "approve", summary: "Checked" });
  await x.endTurn(rev, "a");
  const delivery = (await x.job("a")).reviewedEvent;
  expect(delivery).toBeDefined();
  await fillHistory(x, impl);
  expect(await deliveryKept(x, delivery)).toBe(false);
  for (let i = 0; i < 3; i++) {
    await casualTurn(x, impl);
    expect(await x.job("a"), `casual turn ${i + 1}`).toMatchObject({ state: "delivered", verdict: "approved", reviewRounds: 1 });
  }
  expect(toReviewer(x, rev)).toEqual([]);
  expect((await x.store.read()).events.some((e) => e.action === "automation_review_started")).toBe(false);
  expect((await x.task("a")).status).toBe("in_review");
});

test("a card that reached In review without an agent delivery keeps its verdict through later casual turns", async () => {
  const x = await setup({ enabled: true, reviewer: { provider: "codex", model: "gpt-6-luna" } });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  // A person moves the card to In review during the implementer's turn: no delivery event of the agent exists.
  await x.turn(impl, "a", "completed", x.setStatus("in_review"));
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 1 });
  const rev = x.created[1].agentId;
  await x.automation.submitReview(as(rev), { verdict: "approve", summary: "Checked" });
  await x.endTurn(rev, "a");
  for (let i = 0; i < 3; i++) {
    await casualTurn(x, impl);
    expect(await x.job("a"), `casual turn ${i + 1}`).toMatchObject({ state: "delivered", verdict: "approved", reviewRounds: 1 });
  }
  expect(toReviewer(x, rev)).toEqual([]);
});

test("new work after the history moved on is still reviewed again", async () => {
  const { x, impl, rev } = await underReview({ maxReviewRounds: 1 });
  await x.automation.submitReview(as(rev), { verdict: "approve", summary: "Checked" });
  await x.endTurn(rev, "a");
  const delivery = (await x.job("a")).reviewedEvent;
  await fillHistory(x, impl);
  expect(await deliveryKept(x, delivery)).toBe(false);
  // The person asks for more; the implementer reworks and delivers again.
  await x.startTurn(impl, "a");
  await x.deliver(impl, "a");
  await x.endTurn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", role: "reviewer", reviewRounds: 1 });
  expect((await x.job("a")).verdict).toBeUndefined();
});

test.each([
  ["a verdict on a delivery the history no longer has", { reviewedEvent: "pruned-delivery", deliveryEvent: "pruned-delivery" }],
  ["a verdict recorded before deliveries were kept on the job", {}],
] as const)("an older job with %s keeps it through a casual turn", async (_, recorded) => {
  const x = await setup({ enabled: true, reviewer: { provider: "codex", model: "gpt-6-luna" } });
  const job: AutomationJob = {
    taskId: "a", projectId: "p", state: "delivered", role: "implementer", implementerId: "impl", reviewerId: "rev", verdict: "approved",
    generation: 1, nudges: 0, failures: 0, reviewRounds: 1, turnAt: x.at(), queuedAt: x.at(), updatedAt: x.at(), ...recorded,
  };
  await x.reload((board) => {
    board.tasks[0].status = "in_review";
    board.automation.push(job);
  });
  x.agents.set("impl", { id: "impl", workspaceId: "w-a", archivedAt: null, status: "idle" });
  x.agents.set("rev", { id: "rev", workspaceId: "w-a", archivedAt: null, status: "idle" });
  await casualTurn(x, "impl");
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved" });
  expect(toReviewer(x, "rev")).toEqual([]);
});
