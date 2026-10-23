import { afterEach, expect, test, vi } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures, underReview } from "./automation-fixture";

// AUTOMATION-SPEC §4.2/§10: what the turn hooks do with a person's turn, a busy session and a deferred instruction.
afterEach(cleanupAutomationFixtures);

const reviewer = { provider: "codex", model: "gpt-6-luna" } as const;
const as = (agentId: string) => ({ agentId, taskId: "a", workspaceId: "w-a" });

test("a person's turn during the retry wait replaces the stale retry; its question waits for them", async () => {
  const x = await setup({ enabled: true, failureLimit: 3 });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.turn(impl, "a", "failed");
  expect((await x.job("a")).state).toBe("retry_wait");
  await x.startTurn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "working", failures: 1 });
  expect((await x.job("a")).retryAt).toBeUndefined();
  await x.record("a", { actor: "agent", action: "progress_reported", agentId: impl, reportKind: "question", note: "Which endpoint?" });
  await x.endTurn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "question" });
  x.advance(60_000);
  await x.automation.kick();
  expect(x.sent).toHaveLength(0);
});

test("a retry falling due while a person's turn runs is not sent after it; the turn is judged instead", async () => {
  const x = await setup({ enabled: true, failureLimit: 3 });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.turn(impl, "a", "failed");
  await x.startTurn(impl, "a");
  x.advance(60_000);
  await x.automation.kick();
  expect(x.sent).toHaveLength(0);
  await x.endTurn(impl, "a");
  await x.automation.kick();
  expect(x.sent.map((s) => s.text)).toEqual([expect.stringMatching(/reminder 1 of 2/)]);
});

test("requested changes wait for the running reviewer and go out when its turn ends, without another pass", async () => {
  const { x, impl, rev } = await underReview();
  await x.automation.submitReview(as(rev), { verdict: "changes", summary: "Tests missing", findings: ["src/a.ts: no test"] });
  await x.automation.kick();
  // The reviewer is still in the turn that submitted the verdict: the implementer must not start beside it.
  expect(x.sent.filter((s) => s.agentId === impl)).toHaveLength(0);
  await x.endTurn(rev, "a");
  await vi.waitFor(() => expect(x.sent.at(-1)).toMatchObject({ agentId: impl, text: expect.stringMatching(/requested changes[\s\S]*no test/) }));
});

test("a review request waits while the implementer's session is still running", async () => {
  const x = await setup({ enabled: true, reviewer });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.deliver(impl, "a");
  await x.endTurn(impl, "a", "completed", { idle: false });
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "reviewing" });
  expect(x.created).toHaveLength(1);
  x.agents.get(impl)!.status = "idle";
  await x.automation.kick();
  expect(x.created).toHaveLength(2);
  expect(x.created[1].prompt).toMatch(/review round 1 of 3/);
});

test("a stored instruction reaches the session when the busy turn ends through the hook", async () => {
  const x = await setup();
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.automation.stopJob("a");
  await x.automation.queue("a");
  await x.automation.kick();
  const pending = (await x.job("a")).instruction!;
  expect(pending.text).toMatch(/queued this card again/);
  expect(x.sent).toHaveLength(0);
  await x.endTurn(impl, "a");
  expect(x.sent).toEqual([{ agentId: impl, text: pending.text, messageId: pending.id, images: undefined }]);
});

test("requested changes held while a person talks to the implementer reach it when that turn ends", async () => {
  const { x, impl, rev } = await underReview();
  await x.automation.submitReview(as(rev), { verdict: "changes", summary: "Tests missing", findings: ["src/a.ts: no test"] });
  const pending = (await x.job("a")).instruction!;
  await x.startTurn(impl, "a");
  await x.endTurn(rev, "a");
  await x.automation.kick();
  expect(x.sent.filter((s) => s.agentId === impl)).toHaveLength(0);
  await x.endTurn(impl, "a");
  await vi.waitFor(() => expect(x.sent.filter((s) => s.agentId === impl)).toEqual([{ agentId: impl, text: pending.text, messageId: pending.id, images: undefined }]));
});
