import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures, underReview } from "./automation-fixture";
import { historyLimits } from "../shared/automation";

// AUTOMATION-SPEC §4.6: a session whose provider history is too large for Paseo to load is not continued.
afterEach(cleanupAutomationFixtures);

const big = historyLimits.rotate + 50 * 2 ** 20;
const events = async (x: Awaited<ReturnType<typeof setup>>, action: string) => (await x.store.read()).events.filter((e) => e.action === action);

test("an implementer with an oversized history gets its next instruction in a new session that takes over", async () => {
  const x = await setup({ enabled: true });
  await x.automation.queue("a");
  await x.automation.kick();
  const old = x.created[0].agentId;
  x.hooks.history = (id) => (id === old ? big : null);
  // A silent turn end: the reminder would go to the same session.
  await x.turn(old, "a");
  expect(x.created).toHaveLength(2);
  const next = x.created[1];
  expect(next.prompt).toContain("grew a 250 MB provider history");
  expect(next.prompt).toContain("Follow the Flowly skill");
  expect(next.prompt).toContain("reminder 1 of 2");
  expect(x.sent.filter((m) => m.agentId === old)).toHaveLength(0);
  expect(await x.job("a")).toMatchObject({ state: "working", implementerId: next.agentId, nudges: 1 });
  expect((await events(x, "automation_rotated"))[0]?.note).toContain("250 MB");
  // The new session's turns are supervised as usual; the old one's are not.
  const before = await x.job("a");
  await x.turn(old, "a");
  expect(await x.job("a")).toEqual(before);
});

test("a reviewer with an oversized history reviews the next round in a new session, which alone may judge it", async () => {
  const { x, impl, rev } = await underReview();
  await x.automation.submitReview({ agentId: rev, taskId: "a", workspaceId: "w-a" }, { verdict: "changes", summary: "Not yet", findings: ["a.ts: one"] });
  await x.endTurn(rev, "a");
  await x.automation.kick();
  x.hooks.history = (id) => (id === rev ? big : null);
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  const next = x.created.at(-1)!;
  expect(next.agentId).not.toBe(rev);
  expect(next.labels["flowly-automation"]).toBe("reviewer");
  expect(next.prompt).toContain("previous reviewer session");
  expect(next.prompt).toContain("review round 2 of");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewerId: next.agentId, reviewers: [rev] });
  await expect(x.automation.submitReview({ agentId: rev, taskId: "a", workspaceId: "w-a" }, { verdict: "approve", summary: "Late" })).rejects.toMatchObject({ code: "NOT_REVIEWER" });
  await x.automation.submitReview({ agentId: next.agentId, taskId: "a", workspaceId: "w-a" }, { verdict: "approve", summary: "Checked" });
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved" });
});

test("a session below the limit, or one Flowly cannot measure, keeps getting its instructions", async () => {
  const x = await setup({ enabled: true });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  x.hooks.history = () => historyLimits.rotate - 1;
  await x.turn(impl, "a");
  expect(x.created).toHaveLength(1);
  expect(x.sent.at(-1)).toMatchObject({ agentId: impl, text: expect.stringContaining("reminder 1 of 2") });
});

test("a running session past the warning size is flagged once on its card, and nothing interrupts it", async () => {
  const x = await setup({ enabled: true });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  x.agents.get(impl)!.status = "running";
  x.hooks.history = () => historyLimits.warn + 2 ** 20;
  x.advance(61_000);
  await x.automation.kick();
  x.advance(61_000);
  await x.automation.kick();
  const flagged = await events(x, "automation_history_large");
  expect(flagged).toHaveLength(1);
  expect(flagged[0].note).toContain("301 MB");
  expect(await x.job("a")).toMatchObject({ state: "working", implementerId: impl, historyWarning: { agentId: impl, bytes: historyLimits.warn + 2 ** 20 } });
  expect(x.created).toHaveLength(1);
});

test("Flowly does not read an oversized session's timeline at its turn end", async () => {
  const x = await setup({ enabled: true });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  const read: string[] = [];
  x.hooks.timeline = (id) => { read.push(id); return []; };
  x.hooks.history = (id) => (id === impl ? big : null);
  await x.turn(impl, "a");
  expect(read).not.toContain(impl);
});
