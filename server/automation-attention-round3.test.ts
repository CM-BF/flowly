import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures } from "./automation-fixture";
import { attentionItems } from "../client/attention";

// AUTOMATION-SPEC §6 item 4: a failed job whose card someone moved afterwards leaves Needs attention, and stays out
// after the card's history (100 events per card) no longer holds that move.
afterEach(cleanupAutomationFixtures);

type Fixture = Awaited<ReturnType<typeof setup>>;
const needsYou = async (x: Fixture) => attentionItems(await x.store.read(), [], [], false).filter((i) => i.task.id === "a" && i.automation);

/** Card a's implementer gives up after silent turns: the job fails and rule AUTO moves the card to Blocked. */
async function failed(x: Fixture) {
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.turn(impl, "a");
  await x.turn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "failed", code: "no_delivery" });
  expect((await x.task("a")).status).toBe("blocked");
  expect(await needsYou(x)).toHaveLength(1);
  return impl;
}

/** Turns on the card that move nothing: the card's history fills up. */
async function laterTurns(x: Fixture, impl: string, n: number) {
  for (let i = 0; i < n; i++)
    await x.store.mutate((board) => {
      x.store.event(board, { taskId: "a", actor: "system", action: "agent.turn_started", agentId: impl });
      x.store.event(board, { taskId: "a", actor: "system", action: "agent.turn_ended", agentId: impl, outcome: "completed" });
    });
  await x.automation.kick();
}

test("a failed job a person took back stays out of Needs attention after the move left the card's history", async () => {
  const x = await setup({ enabled: true, nudgeLimit: 1 });
  const impl = await failed(x);
  // The person drags the card from Blocked back to Development.
  x.advance(1000);
  await x.store.mutate((board) => {
    board.tasks.find((t) => t.id === "a")!.status = "development";
    board.events.push({ id: "drag", taskId: "a", actor: "human", action: "status_changed", from: "blocked", to: "development", at: x.at() });
  });
  await x.automation.cardMoved("a", "blocked", "development");
  await x.automation.kick();
  expect(await needsYou(x)).toEqual([]);
  await laterTurns(x, impl, 60);
  expect((await x.store.read()).events.some((e) => e.id === "drag")).toBe(false);
  expect(await x.job("a")).toMatchObject({ state: "failed", code: "no_delivery" });
  expect(await needsYou(x)).toEqual([]);
});

test("a failed job whose card nobody moved keeps asking, also after its history moved on", async () => {
  const x = await setup({ enabled: true, nudgeLimit: 1 });
  const impl = await failed(x);
  await laterTurns(x, impl, 60);
  expect(await needsYou(x)).toHaveLength(1);
});

test("Run again after a take-back asks again when the new run fails", async () => {
  const x = await setup({ enabled: true, nudgeLimit: 1 });
  const impl = await failed(x);
  x.advance(1000);
  await x.store.mutate((board) => {
    board.tasks.find((t) => t.id === "a")!.status = "development";
    board.events.push({ id: "drag", taskId: "a", actor: "human", action: "status_changed", from: "blocked", to: "development", at: x.at() });
  });
  await x.automation.cardMoved("a", "blocked", "development");
  await x.automation.kick();
  expect(await needsYou(x)).toEqual([]);
  await laterTurns(x, impl, 60);
  await x.automation.queue("a");
  await x.automation.kick();
  await x.turn(impl, "a");
  await x.turn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "failed", generation: 2 });
  expect(await needsYou(x)).toHaveLength(1);
});
