import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures } from "./automation-fixture";
import type { AutomationJob } from "../shared/automation";

// AUTOMATION-SPEC §4.4: a start whose session creation was never confirmed waits for a person; a session that does
// not exist (yet) is not a lost one.
afterEach(cleanupAutomationFixtures);

const claude = { provider: "claude", model: "claude-haiku-4-5" };
type Fixture = Awaited<ReturnType<typeof setup>>;

async function passes(x: Fixture, n: number) {
  for (let i = 0; i < n; i++) {
    x.advance(121_000);
    await x.automation.kick();
  }
}

test("a create whose outcome is unknown keeps waiting for a person while its session does not exist, and a late session's turn is supervised", async () => {
  const x = await setup({ enabled: true });
  let creates = 0;
  x.hooks.create = async () => {
    creates++;
    throw Object.assign(new Error("The daemon lost the request"), { code: "agent_request_outcome_unknown" });
  };
  await x.automation.queue("a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "interrupted" });
  await passes(x, 4);
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "interrupted" });
  expect(creates).toBe(1);
  // The daemon finishes the slow create after all: the session starts on its prompt and supervision resumes.
  const agentId = (await x.job("a")).implementerId!;
  x.agents.set(agentId, { id: agentId, workspaceId: "w-a", archivedAt: null, status: "idle" });
  await x.startTurn(agentId, "a");
  expect(await x.job("a")).toMatchObject({ state: "working", implementerId: agentId });
  expect(await x.job("a")).not.toHaveProperty("unconfirmed");
  await x.deliver(agentId, "a");
  await x.endTurn(agentId, "a");
  expect((await x.job("a")).state).toBe("delivered");
});

test("a provider limit that used up the budget while creating the session keeps the job waiting for a person", async () => {
  const x = await setup({ enabled: true, implementer: claude });
  x.hooks.create = async () => {
    throw new Error("429 rate limit exceeded");
  };
  await x.automation.queue("a");
  await x.automation.kick();
  for (let i = 0; i < 10 && (await x.job("a")).state !== "needs_human"; i++) {
    x.advance(16 * 60_000);
    await x.automation.kick();
  }
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "cooldown", implementerId: expect.any(String) });
  await passes(x, 3);
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "cooldown" });
  const events = (await x.store.read()).events.filter((e) => e.taskId === "a" && e.action === "automation_failed");
  expect(events).toEqual([]);
});

test("a job left by an older version, waiting with a session preparation that never became a session, keeps waiting", async () => {
  const x = await setup({ enabled: true });
  const job: AutomationJob = {
    taskId: "a", projectId: "p", state: "needs_human", code: "interrupted", role: "implementer", implementerId: "a-never-created",
    pendingOp: "op-old", pendingRole: "implementer", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: x.at(), updatedAt: x.at(),
  };
  await x.reload((board) => void board.automation.push(job));
  await passes(x, 2);
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "interrupted" });
  expect(x.created).toHaveLength(0);
});

test("a waiting job whose confirmed session was archived still settles as unavailable", async () => {
  const x = await setup({ enabled: true });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.startTurn(impl, "a");
  await x.endTurn(impl, "a", "canceled");
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "interrupted" });
  x.agents.get(impl)!.archivedAt = x.at();
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "failed", code: "session_unavailable" });
});
