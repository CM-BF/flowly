import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures, underReview } from "./automation-fixture";
import type { AutomationJob } from "../shared/automation";

// AUTOMATION-SPEC §4.5: a role whose model reports a provider limit continues on the project's fallback model.
afterEach(cleanupAutomationFixtures);

const opus = { provider: "claude", model: "claude-opus-5-5" };
const sol = { provider: "codex", model: "gpt-6.1-sol" };
const notice = "You've hit your session limit · resets 2pm (America/Los_Angeles)";
const as = (agentId: string, taskId = "a") => ({ agentId, taskId, workspaceId: `w-${taskId}` });

type Fixture = Awaited<ReturnType<typeof setup>>;

/** What the turn hook records for a turn the provider failed with `message`, then hands to automation. */
async function limitEnd(x: Fixture, agentId: string, taskId: string, message: string) {
  x.advance(1000);
  await x.record(taskId, { actor: "system", action: "agent.turn_started", agentId });
  x.advance(1000);
  await x.record(taskId, { actor: "system", action: "agent.turn_ended", agentId, outcome: "failed", note: message });
  x.advance(1000);
  const ended = x.agents.get(agentId);
  if (ended) ended.status = "idle";
  await x.automation.turnEnded(agentId);
  await x.automation.kick();
}

async function implementerRun(settings: Record<string, unknown> = {}) {
  const x = await setup({ enabled: true, implementer: opus, implementerFallback: sol, ...settings });
  await x.automation.queue("a");
  await x.automation.kick();
  expect(x.created.map((c) => c.provider)).toEqual(["claude/claude-opus-5-5"]);
  return { x, impl: x.created[0].agentId };
}

test("a reviewer that hits a provider limit is replaced by a fallback reviewer for the same round; only it may judge", async () => {
  const { x, rev } = await underReview({ reviewer: opus, reviewerFallback: sol });
  await limitEnd(x, rev, "a", notice);
  const job = await x.job("a");
  expect(job).toMatchObject({ state: "reviewing", role: "reviewer", reviewRounds: 1, fallback: { reviewer: true }, providerLimit: { model: "claude/claude-opus-5-5" } });
  expect(x.created).toHaveLength(3);
  const fallback = x.created[2];
  expect(fallback).toMatchObject({ provider: "codex/gpt-6.1-sol", labels: { "flowly-automation": "reviewer", "paseo-rate-fallback": "off" } });
  expect(fallback.prompt).toContain("review round 1 of");
  expect(fallback.prompt).toContain("provider limit");
  expect(job.reviewerId).toBe(fallback.agentId);
  // The limited reviewer's late verdict is not this round's.
  await expect(x.automation.submitReview(as(rev), { verdict: "approve", summary: "Late" })).rejects.toMatchObject({ code: "NOT_REVIEWER" });
  await x.automation.submitReview(as(fallback.agentId), { verdict: "approve", summary: "Checked" });
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved" });
});

test("an implementer that hits a provider limit continues in a new session on the fallback, told to take over", async () => {
  const { x, impl } = await implementerRun();
  await limitEnd(x, impl, "a", "API Error: 429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit");
  expect(x.created).toHaveLength(2);
  const next = x.created[1];
  expect(next).toMatchObject({ provider: "codex/gpt-6.1-sol", modeId: "full-access", labels: { "flowly-automation": "implementer", "paseo-rate-fallback": "off" } });
  expect(next.prompt).toContain("take over its work");
  expect(next.prompt).toContain("unattended");
  expect(await x.job("a")).toMatchObject({ state: "working", role: "implementer", implementerId: next.agentId, fallback: { implementer: true }, cooldowns: 0 });
  // The limited session is no longer supervised: its later turn end changes nothing.
  const before = await x.job("a");
  await x.turn(impl, "a");
  expect(await x.job("a")).toEqual(before);
});

test("the takeover carries requested changes the limited implementer never finished", async () => {
  const { x, impl, rev } = await underReview({ implementer: opus, implementerFallback: sol });
  await x.automation.submitReview(as(rev), { verdict: "changes", summary: "Add the missing test", findings: ["test.js: assert divide(6, 3) === 2"] });
  // The reviewer's turn ends after its verdict; the requested changes then go to the implementer.
  await x.endTurn(rev, "a");
  await x.automation.kick();
  expect(x.sent.at(-1)).toMatchObject({ agentId: impl });
  await limitEnd(x, impl, "a", notice);
  const takeover = x.created.at(-1)!;
  expect(takeover.provider).toBe("codex/gpt-6.1-sol");
  expect(takeover.prompt).toContain("assert divide(6, 3) === 2");
});

test("without a fallback, a provider limit waits for the cooldown as before", async () => {
  const { x, impl } = await implementerRun({ implementerFallback: undefined });
  await limitEnd(x, impl, "a", notice);
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", code: "cooldown", cooldowns: 1 });
  expect(x.created).toHaveLength(1);
});

test("a fallback session that hits a limit too waits for the cooldown instead of switching again", async () => {
  const { x, impl } = await implementerRun();
  await limitEnd(x, impl, "a", notice);
  const fallback = x.created[1].agentId;
  await limitEnd(x, fallback, "a", "429 Too Many Requests");
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", code: "cooldown", implementerId: fallback });
  expect(x.created).toHaveLength(2);
});

test("a completed turn that ends with Claude's quota notice counts as a provider limit", async () => {
  const { x, impl } = await implementerRun();
  x.hooks.timeline = (id) => (id === impl ? [{ type: "user_message", text: "Continue" }, { type: "assistant_message", text: notice }] : []);
  await x.turn(impl, "a");
  expect(x.created.map((c) => c.provider)).toEqual(["claude/claude-opus-5-5", "codex/gpt-6.1-sol"]);
  expect((await x.job("a")).fallback).toEqual({ implementer: true });
});

test("prose that only quotes a limit notice is an ordinary silent turn", async () => {
  const { x, impl } = await implementerRun();
  x.hooks.timeline = () => [{ type: "user_message", text: "Why did it stop?" }, { type: "assistant_message", text: `Earlier the tool said "${notice}", so I paused; the work continues now.` }];
  await x.turn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "working", nudges: 1 });
  expect(x.created).toHaveLength(1);
});

test("a card queued while its implementer's model is limited starts on the fallback directly", async () => {
  const { x, impl } = await implementerRun({ maxRunning: 2 });
  await limitEnd(x, impl, "a", notice);
  await x.automation.queue("b");
  await x.automation.kick();
  const b = x.created.find((c) => c.labels["flowly-task"] === "b")!;
  expect(b.provider).toBe("codex/gpt-6.1-sol");
  expect((await x.job("b")).fallback).toEqual({ implementer: true });
  // After the hold, a new session tries the implementer's own model again.
  x.advance(31 * 60_000);
  await x.store.mutate((board) => { board.tasks.push({ ...board.tasks.find((t) => t.id === "b")!, id: "c", workspaceId: "w-c", operationId: "create-c", title: "Card c" }); });
  await x.automation.stopJob("a");
  await x.automation.queue("c");
  await x.automation.kick();
  expect(x.created.find((c) => c.labels["flowly-task"] === "c")?.provider).toBe("claude/claude-opus-5-5");
});

test("a provider cooling down on another card does not hold back a card whose implementer has a fallback", async () => {
  const x = await setup({ enabled: true, implementer: opus, implementerFallback: sol, maxRunning: 2 });
  await x.store.mutate((board) => {
    const cooling: AutomationJob = {
      taskId: "a", projectId: "p", state: "retry_wait", role: "implementer", code: "cooldown", provider: "claude",
      retryAt: new Date(Date.parse(x.at()) + 600_000).toISOString(), generation: 1, nudges: 0, failures: 0, reviewRounds: 0,
      cooldowns: 1, implementerId: "a-old", queuedAt: x.at(), updatedAt: x.at(),
    };
    board.automation.push(cooling);
  });
  await x.automation.queue("b");
  await x.automation.kick();
  expect(x.created.map((c) => [c.labels["flowly-task"], c.provider])).toEqual([["b", "codex/gpt-6.1-sol"]]);
});

test("a session create that hits a limit starts the same first instruction on the fallback model", async () => {
  const x = await setup({ enabled: true, implementer: opus, implementerFallback: sol });
  let refused = false;
  x.hooks.create = async () => {
    if (!refused) {
      refused = true;
      throw new Error("Request failed: 429 Too Many Requests");
    }
  };
  await x.automation.queue("a");
  await x.automation.kick();
  await x.automation.kick();
  expect(x.created.map((c) => c.provider)).toEqual(["codex/gpt-6.1-sol"]);
  expect(x.created[0].prompt).toContain("started this session to work on this card unattended");
  expect(x.created[0].prompt).not.toContain("take over");
  expect(await x.job("a")).toMatchObject({ state: "working", fallback: { implementer: true }, implementerId: x.created[0].agentId });
});

test("Run again after the hold reviews on the reviewer's own model; the fallback reviewer is not carried", async () => {
  const { x, impl, rev } = await underReview({ reviewer: opus, reviewerFallback: sol });
  await limitEnd(x, rev, "a", notice);
  const fallback = x.created[2].agentId;
  await x.automation.submitReview(as(fallback), { verdict: "approve", summary: "Checked" });
  x.advance(31 * 60_000);
  await x.automation.queue("a");
  expect((await x.job("a")).reviewerId).toBeUndefined();
  await x.automation.kick();
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  expect(x.created.at(-1)).toMatchObject({ provider: "claude/claude-opus-5-5", labels: { "flowly-automation": "reviewer" } });
  expect((await x.job("a")).fallback).toBeUndefined();
});
