import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures, underReview } from "./automation-fixture";
import { attentionItems } from "../client/attention";

afterEach(cleanupAutomationFixtures);

test("a new delivery is reviewed even when progress trims its event before the turn ends", async () => {
  const { x, impl, rev } = await underReview({ maxReviewRounds: 1 });
  await x.automation.submitReview({ agentId: rev, taskId: "a", workspaceId: "w-a" }, { verdict: "approve", summary: "Old work checked" });
  await x.endTurn(rev, "a");
  const old = (await x.job("a")).reviewedEvent;
  await x.startTurn(impl, "a");
  const delivery = await x.store.mutate((board) => {
    board.tasks.find((task) => task.id === "a")!.status = "in_review";
    return x.store.event(board, { taskId: "a", actor: "agent", agentId: impl, action: "status_changed", from: "development", to: "in_review" }).id;
  });
  await x.store.mutate((board) => {
    for (let i = 0; i < 105; i++) x.store.event(board, { taskId: "a", actor: "agent", agentId: impl, action: "progress_reported", note: `Check ${i}` });
  });
  expect((await x.store.read()).events.some((event) => event.id === delivery)).toBe(false);
  await x.endTurn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", role: "reviewer", deliveryEvent: delivery });
  expect(delivery).not.toBe(old);
  expect((await x.job("a")).verdict).toBeUndefined();
});

test("taking back a failed card is durable before the next dispatcher pass can read its move", async () => {
  const x = await setup({ enabled: true, nudgeLimit: 1 });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.turn(impl, "a");
  await x.turn(impl, "a");
  expect((await x.job("a")).state).toBe("failed");
  // No dispatcher or cardMoved callback gets to observe the move before its history is pruned.
  await x.store.mutate((board) => {
    board.tasks.find((task) => task.id === "a")!.status = "development";
    x.store.event(board, { taskId: "a", actor: "human", action: "status_changed", from: "blocked", to: "development" });
    for (let i = 0; i < 105; i++) x.store.event(board, { taskId: "a", actor: "system", action: "agent.turn_ended", agentId: impl, outcome: "completed" });
  });
  await x.automation.kick();
  const board = await x.store.read();
  expect(board.events.some((event) => event.actor === "human" && event.action === "status_changed")).toBe(false);
  expect(attentionItems(board, [], [], false).filter((item) => item.task.id === "a" && item.automation)).toEqual([]);
  expect(await x.job("a")).toMatchObject({ state: "failed", takenBack: true });
});
