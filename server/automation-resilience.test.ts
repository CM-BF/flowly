import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures } from "./automation-fixture";
import type { Link } from "../shared/model";

// AUTOMATION-SPEC §4.4, §4.5, SUB-CARDS-SPEC §5: what a live pipeline hit on 2026-10-23, and resuming after a reload.
afterEach(cleanupAutomationFixtures);

const link = (kind: Link["kind"], from: string, to: string): Link => ({ id: `${kind}-${from}-${to}`, projectId: "p", kind, from, to, createdBy: "human", createdAt: "2026-10-22T00:00:00.000Z" });
const capacity = "Selected model is at capacity. Please try a different model.";

type Fixture = Awaited<ReturnType<typeof setup>>;
async function failedTurn(x: Fixture, agentId: string, taskId: string, note: string) {
  x.advance(1000);
  await x.record(taskId, { actor: "system", action: "agent.turn_started", agentId });
  x.advance(1000);
  await x.record(taskId, { actor: "system", action: "agent.turn_ended", agentId, outcome: "failed", note });
  x.advance(1000);
  const ended = x.agents.get(agentId);
  if (ended) ended.status = "idle";
  await x.automation.turnEnded(agentId);
  await x.automation.kick();
}

test("a model at capacity is a provider limit: the card retries patiently instead of failing after two quick attempts", async () => {
  const x = await setup({ enabled: true });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await failedTurn(x, impl, "a", capacity);
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", code: "cooldown", cooldowns: 1, failures: 0 });
  x.advance(61_000);
  await x.automation.kick();
  await failedTurn(x, impl, "a", capacity);
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", code: "cooldown", cooldowns: 2 });
  expect((await x.task("a")).status).not.toBe("blocked");
});

test("a model at capacity switches to the role's fallback model when the project set one", async () => {
  const x = await setup({ enabled: true, implementer: { provider: "codex", model: "gpt-6-astra" }, implementerFallback: { provider: "claude", model: "claude-opus-5-5" } });
  await x.automation.queue("a");
  await x.automation.kick();
  await failedTurn(x, x.created[0].agentId, "a", capacity);
  expect(x.created.map((c) => c.provider)).toEqual(["codex/gpt-6-astra", "claude/claude-opus-5-5"]);
});

test("a parent waits for a sub-card a person is working on outside automation, and wakes when that turn ends", async () => {
  const x = await setup({ enabled: true });
  await x.store.mutate((board) => void board.links.push(link("subtask", "b", "a")));
  await x.automation.queue("a");
  await x.automation.kick();
  const parent = x.created[0].agentId;
  // b's automation failed earlier; a person then messaged its (Flowly-managed) session, which is now mid-turn.
  await x.store.mutate((board) => {
    board.automation.push({ taskId: "b", projectId: "p", state: "failed", role: "implementer", code: "failed", implementerId: "b-session", generation: 1, nudges: 0, failures: 2, reviewRounds: 0, queuedAt: x.at(), updatedAt: x.at() });
  });
  await x.record("b", { actor: "system", action: "agent.turn_started", agentId: "b-session" });
  await x.turn(parent, "a");
  expect(await x.job("a")).toMatchObject({ state: "waiting", code: "sub_cards", nudges: 0 });
  expect(x.sent.filter((s) => s.agentId === parent)).toEqual([]);
  // The person's turn on b ends: the parent is told.
  x.advance(1000);
  await x.record("b", { actor: "system", action: "agent.turn_ended", agentId: "b-session", outcome: "completed" });
  await x.automation.kick();
  expect((await x.job("a")).state).toBe("working");
  expect(x.sent.filter((s) => s.agentId === parent)).toEqual([expect.objectContaining({ text: expect.stringMatching(/sub-cards changed/) })]);
});

test("a turn left open for hours (a missed end hook) no longer holds the parent", async () => {
  const x = await setup({ enabled: true });
  await x.store.mutate((board) => void board.links.push(link("subtask", "b", "a")));
  await x.automation.queue("a");
  await x.automation.kick();
  const parent = x.created[0].agentId;
  await x.record("b", { actor: "system", action: "agent.turn_started", agentId: "b-session" });
  x.advance(7 * 3600_000);
  await x.turn(parent, "a");
  expect(await x.job("a")).toMatchObject({ state: "working", nudges: 1 });
});

test("a turn end missed during a reload is recovered from the session's attention and judged as usual", async () => {
  const x = await setup({ enabled: true });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  // The agent delivered; the turn_ended hook never reached Flowly. The daemon marked the session finished.
  await x.record("a", { actor: "system", action: "agent.turn_started", agentId: impl });
  await x.deliver(impl, "a");
  x.advance(1000);
  Object.assign(x.agents.get(impl)!, { status: "idle", attentionReason: "finished", attentionTimestamp: x.at() });
  x.advance(121_000);
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "delivered" });
  const board = await x.store.read();
  expect(board.events.filter((e) => e.taskId === "a" && e.action === "agent.turn_ended")).toEqual([expect.objectContaining({ agentId: impl, outcome: "completed" })]);
});

test("a session that errored during a reload is a failed turn; its capacity message cools down like any limit", async () => {
  const x = await setup({ enabled: true });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.record("a", { actor: "system", action: "agent.turn_started", agentId: impl });
  Object.assign(x.agents.get(impl)!, { status: "error", lastError: capacity });
  x.advance(121_000);
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", code: "cooldown", detail: capacity });
});

test("without the daemon's record of the turn (the session was read since), the card still waits for a person", async () => {
  const x = await setup({ enabled: true });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.record("a", { actor: "system", action: "agent.turn_started", agentId: impl });
  Object.assign(x.agents.get(impl)!, { status: "idle", attentionReason: null, attentionTimestamp: null });
  x.advance(121_000);
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "interrupted" });
});
