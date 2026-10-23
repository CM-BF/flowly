import { afterEach, expect, test, vi } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures, underReview } from "./automation-fixture";

afterEach(cleanupAutomationFixtures);
const identity = (agentId: string) => ({ agentId, taskId: "a", workspaceId: "w-a" });
const approve = { verdict: "approve" as const, summary: "Checked" };

test("the old review cannot approve new work before its new review prompt reaches the reviewer", async () => {
  const { x, impl, rev } = await underReview();
  await x.startTurn(impl, "a");
  await x.deliver(impl, "a");
  await x.endTurn(impl, "a");
  await x.automation.kick();
  expect(x.sent.filter((s) => s.agentId === rev)).toEqual([]);
  // A different new turn in the same session is not proof that this still-held instruction arrived.
  await x.startTurn(rev, "a");
  await expect(x.automation.submitReview(identity(rev), approve)).rejects.toMatchObject({ code: "REVIEW_CLOSED" });
  await x.endTurn(rev, "a");
  await vi.waitFor(() => expect(x.sent.filter((s) => s.agentId === rev)).toHaveLength(1));
  await x.startTurn(rev, "a");
  await expect(x.automation.submitReview(identity(rev), approve)).resolves.toMatchObject({ accepted: true });
});

test("a new reviewer's turn can approve before its create response returns", async () => {
  const x = await setup({ enabled: true, reviewer: { provider: "codex", model: "gpt-6-luna" } });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  x.hooks.created = async (rev) => {
    await x.startTurn(rev, "a");
    await expect(x.automation.submitReview(identity(rev), approve)).resolves.toMatchObject({ accepted: true });
  };
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved" });
});

test("an existing reviewer's new turn can approve before its send response returns", async () => {
  const { x, impl, rev } = await underReview();
  await x.automation.submitReview(identity(rev), { verdict: "changes", summary: "Add tests" });
  await x.endTurn(rev, "a");
  await vi.waitFor(() => expect(x.sent.at(-1)).toMatchObject({ agentId: impl }));
  await x.startTurn(impl, "a");
  await x.deliver(impl, "a");
  x.hooks.send = async () => {
    await x.startTurn(rev, "a");
    await expect(x.automation.submitReview(identity(rev), approve)).resolves.toMatchObject({ accepted: true });
  };
  await x.endTurn(impl, "a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved", reviewRounds: 2 });
});

test("a reminder waiting to be sent does not invalidate a verdict on the round already presented", async () => {
  const { x, rev } = await underReview();
  await x.endTurn(rev, "a", "completed", { idle: false });
  expect(await x.job("a")).toMatchObject({ state: "reviewing", nudges: 1 });
  expect(x.sent.filter((s) => s.agentId === rev)).toEqual([]);
  await expect(x.automation.submitReview(identity(rev), approve)).resolves.toMatchObject({ accepted: true });
});
