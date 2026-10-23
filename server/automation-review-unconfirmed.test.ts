import { afterEach, expect, test, vi } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures, underReview } from "./automation-fixture";

afterEach(cleanupAutomationFixtures);
const identity = (agentId: string) => ({ agentId, taskId: "a", workspaceId: "w-a" });
const approve = { verdict: "approve" as const, summary: "Checked" };
const unknown = () => Object.assign(new Error("The daemon cannot confirm the request"), { code: "agent_request_outcome_unknown" });

async function unknownReviewer() {
  const x = await setup({ enabled: true, reviewer: { provider: "codex", model: "gpt-6-luna" } });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  let attempts = 0;
  x.hooks.create = async () => { attempts++; throw unknown(); };
  await x.startTurn(impl, "a");
  await x.deliver(impl, "a");
  await x.endTurn(impl, "a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "needs_human", role: "reviewer", code: "interrupted", unconfirmed: true });
  const rev = (await x.job("a")).reviewerId!;
  return { x, impl, rev, attempts: () => attempts };
}

for (const newWork of [false, true]) test(`an unknown reviewer start keeps waiting across implementer ${newWork ? "new work" : "casual answers"}, including a mid-turn dispatcher pass`, async () => {
  const { x, impl, rev, attempts } = await unknownReviewer();
  const detail = (await x.job("a")).detail;
  await x.startTurn(impl, "a");
  await x.automation.kick();
  expect((await x.job("a")).unconfirmed).toBe(true);
  if (newWork) await x.deliver(impl, "a");
  await x.endTurn(impl, "a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "needs_human", role: "reviewer", code: "interrupted", detail, unconfirmed: true });
  expect(attempts()).toBe(1);
  // The original create finally produces its prepared session. It keeps its supervised identity.
  x.agents.set(rev, { id: rev, workspaceId: "w-a", status: "running", archivedAt: null });
  await x.startTurn(rev, "a");
  expect((await x.job("a")).unconfirmed).toBeUndefined();
  expect(await x.job("a")).toMatchObject({ state: "reviewing", role: "reviewer" });
  if (newWork) {
    // Its original prompt described older work. Present the new delivery before accepting a verdict on it.
    await expect(x.automation.submitReview(identity(rev), approve)).rejects.toMatchObject({ code: "REVIEW_CLOSED" });
    await x.endTurn(rev, "a");
    await vi.waitFor(() => expect(x.sent.filter((s) => s.agentId === rev)).toHaveLength(1));
    await x.startTurn(rev, "a");
  }
  await expect(x.automation.submitReview(identity(rev), approve)).resolves.toMatchObject({ accepted: true });
  expect(attempts()).toBe(1);
});

async function nextReview() {
  const { x, impl, rev } = await underReview();
  await x.automation.submitReview(identity(rev), { verdict: "changes", summary: "Add tests" });
  await x.endTurn(rev, "a");
  await vi.waitFor(() => expect(x.sent.at(-1)).toMatchObject({ agentId: impl }));
  await x.startTurn(impl, "a");
  await x.deliver(impl, "a");
  return { x, impl, rev };
}

test("a rejected review send cannot be confirmed by a later unrelated reviewer turn", async () => {
  const { x, impl, rev } = await nextReview();
  x.hooks.send = async () => { throw new Error("provider rejected the message"); };
  await x.endTurn(impl, "a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", code: "start_failed" });
  await x.startTurn(rev, "a");
  await expect(x.automation.submitReview(identity(rev), approve)).rejects.toMatchObject({ code: "REVIEW_CLOSED" });
});

test("a review send with unknown outcome waits for the matching reviewer's actual turn before accepting its verdict", async () => {
  const { x, impl, rev } = await nextReview();
  x.hooks.send = async () => { throw unknown(); };
  await x.endTurn(impl, "a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "interrupted" });
  await expect(x.automation.submitReview(identity(rev), approve)).rejects.toMatchObject({ code: "REVIEW_CLOSED" });
  await x.automation.kick();
  await expect(x.automation.submitReview(identity(rev), approve)).rejects.toMatchObject({ code: "REVIEW_CLOSED" });
  await x.startTurn(rev, "a");
  await expect(x.automation.submitReview(identity(rev), approve)).resolves.toMatchObject({ accepted: true });
});

test.each(["rejected", "unknown"] as const)("a review send that becomes %s during an implementer turn preserves that turn and resumes its own failure outcome afterwards", async (outcome) => {
  const { x, impl, rev } = await nextReview();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let sending = false;
  let attempts = 0;
  x.hooks.send = async () => { attempts++; sending = true; await gate; throw outcome === "unknown" ? unknown() : new Error("provider rejected the message"); };
  const ending = x.endTurn(impl, "a");
  try {
    await vi.waitFor(() => expect(sending).toBe(true));
    await x.startTurn(impl, "a");
  } finally {
    release();
    await ending;
  }
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "working", role: "implementer", failures: 0 });
  expect((await x.job("a")).retryAt).toBeUndefined();
  await x.endTurn(impl, "a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject(outcome === "unknown"
    ? { state: "needs_human", role: "reviewer", code: "interrupted", unconfirmed: true }
    : { state: "retry_wait", role: "reviewer", code: "start_failed" });
  expect(x.sent.filter((s) => s.agentId === rev)).toEqual([]);
  expect(attempts).toBe(1);
  x.hooks.send = undefined;
  if (outcome === "rejected") {
    x.advance(31_000);
    await x.automation.kick();
    expect(x.sent.filter((s) => s.agentId === rev)).toHaveLength(1);
  }
  await x.startTurn(rev, "a");
  await expect(x.automation.submitReview(identity(rev), approve)).resolves.toMatchObject({ accepted: true });
});

test("a casual implementer answer does not answer the reviewer's pending question", async () => {
  const { x, impl, rev } = await underReview();
  await x.startTurn(rev, "a");
  await x.store.mutate((board) => x.store.event(board, { taskId: "a", actor: "agent", agentId: rev, action: "progress_reported", reportKind: "question", note: "Which API compatibility target?" }));
  await x.endTurn(rev, "a");
  expect(await x.job("a")).toMatchObject({ role: "reviewer", state: "needs_human", code: "question" });
  await x.startTurn(impl, "a");
  await x.endTurn(impl, "a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ role: "reviewer", state: "needs_human", code: "question" });
  expect(x.sent.filter((s) => s.agentId === rev)).toEqual([]);
});

test.each(["rejected", "unknown"] as const)("a reviewer create that becomes %s during a casual answer keeps its session identity without an immediate retry", async (outcome) => {
  const x = await setup({ enabled: true, reviewer: { provider: "codex", model: "gpt-6-luna" } });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  x.hooks.create = async () => { attempts++; await gate; throw outcome === "unknown" ? unknown() : new Error("provider rejected the create"); };
  await x.deliver(impl, "a");
  const ending = x.turn(impl, "a");
  try {
    await vi.waitFor(() => expect(attempts).toBe(1));
    await x.startTurn(impl, "a");
  } finally {
    release();
    await ending;
  }
  const rev = (await x.job("a")).reviewerId!;
  expect(await x.job("a")).toMatchObject({ state: "working", role: "implementer", failures: 0 });
  await x.endTurn(impl, "a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject(outcome === "unknown"
    ? { state: "needs_human", role: "reviewer", code: "interrupted", unconfirmed: true }
    : { state: "retry_wait", role: "reviewer", code: "start_failed" });
  expect(attempts).toBe(1);
  x.hooks.create = undefined;
  if (outcome === "rejected") {
    x.advance(31_000);
    await x.automation.kick();
    expect(x.created[1].agentId).toBe(rev);
  } else x.agents.set(rev, { id: rev, workspaceId: "w-a", status: "running", archivedAt: null });
  await x.startTurn(rev, "a");
  await expect(x.automation.submitReview(identity(rev), approve)).resolves.toMatchObject({ accepted: true });
});
