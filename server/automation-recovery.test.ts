import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures } from "./automation-fixture";
import type { AutomationJob } from "../shared/automation";

// AUTOMATION-SPEC §4.4/§10: restart recovery, lost turn ends and provider-limit budgets.
afterEach(cleanupAutomationFixtures);

const claude = { provider: "claude", model: "claude-haiku-4-5" } as const;
const job = (at: string, extra: Partial<AutomationJob> = {}): AutomationJob => ({
  taskId: "a",
  projectId: "p",
  state: "starting",
  role: "implementer",
  generation: 1,
  nudges: 0,
  failures: 0,
  reviewRounds: 0,
  queuedAt: at,
  startedAt: at,
  turnAt: at,
  updatedAt: at,
  ...extra,
});
const start = { id: "instruction-1", role: "implementer" as const, text: "[Flowly automation] start", fresh: "[Flowly automation] start" };

test("a session left closed by a lost turn end releases its slot and waits for a person", async () => {
  const x = await setup({ enabled: true, maxRunning: 1 });
  await x.automation.queue("a");
  await x.automation.kick();
  await x.automation.queue("b");
  const impl = x.created[0].agentId;
  // The turn started; its turn_ended hook never reached Flowly, and the session cannot continue.
  await x.startTurn(impl, "a");
  Object.assign(x.agents.get(impl)!, { status: "closed" });
  await x.automation.kick();
  expect((await x.job("a")).state).toBe("working");
  x.advance(121_000);
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "interrupted", detail: expect.stringMatching(/closed/) });
  expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a", "w-b"]);
  expect((await x.store.read()).events.filter((e) => e.action === "agent.turn_ended")).toHaveLength(0);
});

test("a session left in error status by a lost turn end is a failed turn: recorded and retried, so the card goes on", async () => {
  const x = await setup({ enabled: true, maxRunning: 1 });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.startTurn(impl, "a");
  Object.assign(x.agents.get(impl)!, { status: "error", lastError: "provider process exited" });
  x.advance(121_000);
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", code: "failed", failures: 1, detail: "provider process exited" });
  expect((await x.store.read()).events.filter((e) => e.action === "agent.turn_ended")).toEqual([expect.objectContaining({ agentId: impl, outcome: "failed", note: "provider process exited" })]);
});

test("a reload between the claim and the first send creates exactly one session from the stored instruction", async () => {
  const x = await setup({ enabled: true });
  await x.reload((board) => void board.automation.push(job(x.at(), { instruction: start })));
  expect(x.created).toMatchObject([{ workspaceId: "w-a", prompt: start.text }]);
  await x.automation.kick();
  expect(x.created).toHaveLength(1);
  expect(await x.job("a")).toMatchObject({ state: "working", implementerId: x.created[0].agentId });
});

test("a reload during a session creation prepares the same session again and never a second one", async () => {
  const x = await setup({ enabled: true });
  await x.reload((board) => void board.automation.push(job(x.at(), { instruction: start, pendingOp: "op-1", pendingRole: "implementer" })));
  expect(x.created.map((c) => c.agentId)).toEqual([x.preparedFor("op-1")]);
  // The create reached the daemon before the reload, only its reply was lost: the prepared id is found, nothing is created.
  const y = await setup({ enabled: true });
  y.agents.set("a-agent-1", { id: "a-agent-1", workspaceId: "w-a", archivedAt: null, status: "idle" });
  await y.reload((board) => void board.automation.push(job(y.at(), { instruction: start, pendingOp: "op-1", pendingRole: "implementer" })));
  expect(y.preparedFor("op-1")).toBe("a-agent-1");
  expect(y.created).toHaveLength(0);
  expect(await y.job("a")).toMatchObject({ state: "working", implementerId: "a-agent-1" });
  expect((await y.job("a")).pendingOp).toBeUndefined();
});

test("a starting job saved without an instruction (older plugin data) starts its session once it is stale", async () => {
  const x = await setup({ enabled: true });
  await x.reload((board) => void board.automation.push(job(x.at())));
  expect(x.created).toHaveLength(0);
  x.advance(121_000);
  await x.automation.kick();
  await x.automation.kick();
  expect(x.created).toMatchObject([{ workspaceId: "w-a", prompt: expect.stringMatching(/Flowly automation/) }]);
});

test("a stale preparation that belongs to the other role is dropped, never used for this role's session", async () => {
  const x = await setup({ enabled: true });
  const ops: string[] = [];
  x.hooks.prepare = async (_, op) => void ops.push(op);
  await x.reload((board) => void board.automation.push(job(x.at(), { state: "working", pendingOp: "op-reviewer", pendingRole: "reviewer" })));
  x.advance(121_000);
  await x.automation.kick();
  expect(x.created).toHaveLength(1);
  expect(ops.length).toBeGreaterThan(0);
  expect(ops).not.toContain("op-reviewer");
});

test("once the provider-limit budget is used up creating the session, recovery stops creating until a person acts", async () => {
  const x = await setup({ enabled: true, implementer: claude });
  let prepares = 0;
  let limited = true;
  x.hooks.prepare = async () => {
    prepares++;
    if (limited) throw new Error("429 rate limit exceeded");
  };
  await x.automation.queue("a");
  await x.automation.kick();
  for (let i = 0; i < 10 && (await x.job("a")).state !== "needs_human"; i++) {
    x.advance(16 * 60_000);
    await x.automation.kick();
  }
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "cooldown", cooldowns: 6 });
  expect(await x.job("a")).not.toHaveProperty("pendingOp");
  expect(await x.job("a")).not.toHaveProperty("instruction");
  const used = prepares;
  for (let i = 0; i < 3; i++) {
    x.advance(121_000);
    await x.automation.kick();
  }
  expect(prepares).toBe(used);
  limited = false;
  x.advance(121_000);
  await x.automation.kick();
  expect(x.created).toHaveLength(0);
  expect((await x.job("a")).state).toBe("needs_human");
});

test("a session create whose outcome is unknown waits for a person; recovery neither prepares nor creates it again", async () => {
  const x = await setup({ enabled: true });
  let creates = 0;
  let prepares = 0;
  let lookups = 0;
  x.hooks.prepare = async () => void prepares++;
  x.hooks.create = async () => {
    creates++;
    throw Object.assign(new Error("The daemon lost the request"), { code: "agent_request_outcome_unknown" });
  };
  // The daemon finishes the lost request a moment later: the session shows up after the failed create's own check.
  x.hooks.refresh = async (id) => {
    if (creates && ++lookups > 1) x.agents.set(id, { id, workspaceId: "w-a", archivedAt: null, status: "idle" });
  };
  await x.automation.queue("a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "interrupted" });
  expect(await x.job("a")).not.toHaveProperty("pendingOp");
  expect(await x.job("a")).not.toHaveProperty("instruction");
  for (let i = 0; i < 3; i++) {
    x.advance(121_000);
    await x.automation.kick();
  }
  expect({ prepares, creates }).toEqual({ prepares: 1, creates: 1 });
  // The person checks the session and answers it: supervision resumes on the same session.
  const agentId = (await x.job("a")).implementerId!;
  await x.startTurn(agentId, "a");
  expect(await x.job("a")).toMatchObject({ state: "working", implementerId: agentId });
});

test("recovery never re-creates the session of a job that waits for a person (data left by an older version)", async () => {
  const x = await setup({ enabled: true });
  let prepares = 0;
  x.hooks.prepare = async () => void prepares++;
  await x.reload((board) => void board.automation.push(job(x.at(), { state: "needs_human", code: "cooldown", cooldowns: 6, instruction: start, pendingOp: "op-old", pendingRole: "implementer" })));
  x.advance(121_000);
  await x.automation.kick();
  await x.automation.kick();
  expect({ prepares, created: x.created.length }).toEqual({ prepares: 0, created: 0 });
  expect((await x.job("a")).state).toBe("needs_human");
});

test("provider-limit retries are logged and prompted against their own budget, not the failure limit", async () => {
  const x = await setup({ enabled: true, failureLimit: 2 });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  for (let i = 1; i <= 3; i++) {
    await x.startTurn(impl, "a");
    x.advance(1000);
    await x.record("a", { actor: "system", action: "agent.turn_ended", agentId: impl, outcome: "failed", note: "429 rate limit reached" });
    x.agents.get(impl)!.status = "idle";
    await x.automation.turnEnded(impl);
    expect(await x.job("a")).toMatchObject({ state: "retry_wait", code: "cooldown", cooldowns: i, failures: 0 });
    x.advance(20 * 60_000);
    await x.automation.kick();
  }
  const notes = (await x.store.read()).events.filter((e) => e.action === "automation_retry").map((e) => e.note);
  expect(notes).toEqual([
    "Provider limit (1 of 5); retrying in 1 min: 429 rate limit reached",
    "Provider limit (2 of 5); retrying in 2 min: 429 rate limit reached",
    "Provider limit (3 of 5); retrying in 4 min: 429 rate limit reached",
  ]);
  const retries = x.sent.filter((s) => s.agentId === impl).map((s) => s.text);
  expect(retries).toHaveLength(3);
  for (const text of retries) expect(text).not.toMatch(/of 2\)/);
  expect(retries[2]).toMatch(/provider limit[\s\S]*retry 3 of 5/);
});
