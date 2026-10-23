import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures, underReview } from "./automation-fixture";

// AUTOMATION-SPEC §4.4: a host hiccup is not the card's failure. Seen live on 2026-10-23: another plugin's
// before agent.create hook timed out on every other session, and the review gave up after two quick tries.
afterEach(cleanupAutomationFixtures);

const hook = "Plugin next-workspace before agent.create failed: Plugin RPC timed out: next-workspace.hook";

test("an implementer session the host fails to create (another plugin's hook timed out) is retried patiently, not given up", async () => {
  const x = await setup({ enabled: true });
  let refusals = 3;
  x.hooks.create = async () => { if (refusals-- > 0) throw new Error(hook); };
  await x.automation.queue("a");
  await x.automation.kick();
  for (let attempt = 1; attempt <= 3; attempt++) {
    expect(await x.job("a")).toMatchObject({ state: "retry_wait", code: "start_failed", failures: 0, detail: hook });
    x.advance(16 * 60_000);
    await x.automation.kick();
    await x.automation.kick();
  }
  expect(await x.job("a")).toMatchObject({ state: "working", failures: 0 });
  expect(x.created).toHaveLength(1);
});

test("a reviewer session the host fails to create keeps the review going instead of handing an unreviewed delivery over", async () => {
  const { x, impl } = await underReview();
  // The next review round's reviewer is created twice more and refused by the host each time.
  const rev = (await x.job("a")).reviewerId!;
  await x.automation.submitReview({ agentId: rev, taskId: "a", workspaceId: "w-a" }, { verdict: "changes", summary: "One more test" });
  await x.endTurn(rev, "a");
  x.agents.delete(rev);
  let refusals = 2;
  x.hooks.create = async () => { if (refusals-- > 0) throw new Error(hook); };
  await x.automation.kick();
  await x.startTurn(impl, "a");
  await x.deliver(impl, "a");
  await x.endTurn(impl, "a");
  await x.automation.kick();
  for (let attempt = 1; attempt <= 2; attempt++) {
    expect(await x.job("a")).toMatchObject({ role: "reviewer", state: "retry_wait", code: "start_failed" });
    x.advance(16 * 60_000);
    await x.automation.kick();
    await x.automation.kick();
  }
  expect(await x.job("a")).toMatchObject({ role: "reviewer", state: "reviewing", reviewRounds: 2 });
  expect((await x.job("a")).verdict).toBeUndefined();
});

test("an ordinary failure to start still counts against the failure limit", async () => {
  const x = await setup({ enabled: true, failureLimit: 2 });
  x.failNextCreates(2);
  await x.automation.queue("a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", code: "start_failed", failures: 1 });
  x.advance(60_000);
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "failed", code: "start_failed" });
});
