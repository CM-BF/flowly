import { afterEach, expect, test, vi } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures, underReview } from "./automation-fixture";

afterEach(cleanupAutomationFixtures);

const identity = (agentId: string) => ({ agentId, taskId: "a", workspaceId: "w-a" });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// A person's casual turn can reach Flowly at any await in the reviewer start. The pending round must resume
// with its original identity, whether its session has not been prepared, has been prepared, or is being created.
test.each(["prepare", "features", "create"] as const)("a reviewer paused during %s starts the same round after the implementer's casual answer", async (phase) => {
  const x = await setup({ enabled: true, reviewer: { provider: "codex", model: "gpt-6-luna", featureValues: { fast_mode: true } } });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  const gate = deferred();
  let paused = false;
  const pause = async () => { paused = true; await gate.promise; };
  if (phase === "prepare") x.hooks.prepare = pause;
  if (phase === "features") {
    const listFeatures = x.paseo.providers.listFeatures;
    x.paseo.providers.listFeatures = async (...args) => { await pause(); return listFeatures(...args); };
  }
  if (phase === "create") x.hooks.create = pause;
  await x.deliver(impl, "a");
  const ending = x.turn(impl, "a");
  try {
    await vi.waitFor(() => expect(paused).toBe(true));
    await x.startTurn(impl, "a");
  } finally {
    gate.release();
    await ending;
  }
  await x.endTurn(impl, "a");
  await x.automation.kick();
  // Recovery is immediate, with one reviewer for this delivery, and no extra round or reminder.
  expect(x.created.filter((a) => a.labels["flowly-automation"] === "reviewer")).toEqual([
    expect.objectContaining({ prompt: expect.stringMatching(/review round 1 of 3/) }),
  ]);
  expect(await x.job("a")).toMatchObject({ state: "reviewing", role: "reviewer", reviewRounds: 1, nudges: 0 });
  expect(x.sent).toEqual([]);
  const rev = x.created[1].agentId;
  await expect(x.automation.submitReview(identity(rev), { verdict: "approve", summary: "Checked" })).resolves.toMatchObject({ accepted: true });
});

test("a round sent to an existing reviewer during a casual answer is confirmed once and does not reuse the previous round's end", async () => {
  const { x, impl, rev } = await underReview();
  await x.automation.submitReview(identity(rev), { verdict: "changes", summary: "Add tests" });
  await x.endTurn(rev, "a");
  await vi.waitFor(() => expect(x.sent.at(-1)).toMatchObject({ agentId: impl }));
  await x.startTurn(impl, "a");
  await x.deliver(impl, "a");
  const gate = deferred();
  let paused = false;
  x.hooks.send = async () => { paused = true; await gate.promise; x.agents.get(rev)!.status = "running"; };
  const ending = x.endTurn(impl, "a");
  try {
    await vi.waitFor(() => expect(paused).toBe(true));
    await x.startTurn(impl, "a");
  } finally {
    gate.release();
    await ending;
  }
  await x.endTurn(impl, "a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "reviewing", role: "reviewer", reviewRounds: 2, nudges: 0 });
  expect(x.sent.filter((a) => a.agentId === rev)).toEqual([
    expect.objectContaining({ text: expect.stringMatching(/review round 2 of 3/) }),
  ]);
  await expect(x.automation.submitReview(identity(rev), { verdict: "approve", summary: "Checked" })).resolves.toMatchObject({ accepted: true });
});
