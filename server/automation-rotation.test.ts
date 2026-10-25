import { afterEach, expect, test, vi } from "vitest";
import { automationFixture, cleanupAutomationFixtures } from "./automation-fixture";
import { automationSessionRole, historyLimits, type AutomationJob } from "../shared/automation";
import type { AutomationHandoffBridge, RotationContext } from "./automation-rotation";

afterEach(cleanupAutomationFixtures);
const big = historyLimits.rotate + 2 ** 20;
const opus = { provider: "claude", model: "claude-opus-5-5", modeId: "bypassPermissions", thinking: "high", featureValues: { fast_mode: true } };
function bridge(finalize = false) {
  return {
    prepare: vi.fn(async (_context: RotationContext) => finalize ? { finalize: "[Flowly automation] Record the handoff and end this turn." } : {}),
    seal: vi.fn(async (_context: RotationContext) => ({ prompt: "CARD-HANDOFF: unfinished requirement HUMAN-EXACT; verify repository HEAD and active child ids.", revision: 7 })),
    committed: vi.fn(async (_context: RotationContext & { toAgentId: string }) => {}),
    abandoned: vi.fn(async (_context: RotationContext) => {}),
  } satisfies AutomationHandoffBridge;
}
type Fixture = Awaited<ReturnType<typeof automationFixture>>;
async function running(b = bridge(), settings = {}) {
  const x = await automationFixture({ enabled: true, ...settings }, b);
  await x.automation.queue("a"); await x.automation.kick();
  return { x, b, old: x.created[0].agentId };
}
const identity = (agentId: string) => ({ agentId, taskId: "a", workspaceId: "w-a" });
async function reviewerRun(b = bridge()) {
  const { x, old: impl } = await running(b, { reviewer: { provider: "codex", model: "gpt-6-luna" } });
  await x.deliver(impl, "a"); await x.turn(impl, "a");
  return { x, b, impl, rev: x.created[1].agentId };
}
async function requestIdle(x: Fixture, old: string) {
  x.agents.get(old)!.status = "idle";
  await x.automation.requestFresh("a"); await x.automation.kick();
}

test("history replacement seals before create, preserves full model, and does not inherit predecessor reminders", async () => {
  const { x, b, old } = await running(bridge(), { implementer: opus });
  x.hooks.history = id => id === old ? big : null;
  await x.store.mutate(board => { const j = board.automation[0]; j.pendingInputs = ["input-1", "input-2"]; j.subSeen = "child-a:working"; });
  x.hooks.create = async () => {
    expect(b.seal).toHaveBeenCalledOnce();
    const j = await x.job("a");
    expect(j.rotation).toMatchObject({ stage: "creating", fromAgentId: old, carry: { kind: "nudge" } });
    expect(j.retired).toContainEqual(expect.objectContaining({ agentId: old, role: "implementer" }));
  };
  await x.turn(old, "a");
  expect(x.created).toHaveLength(2);
  expect(x.created[1]).toMatchObject({ provider: "claude/claude-opus-5-5", modeId: "bypassPermissions", featureValues: { fast_mode: true } });
  expect(x.created[1].prompt).toContain("HUMAN-EXACT");
  expect(x.created[1].prompt).not.toContain("reminder 1 of");
  expect(await x.job("a")).toMatchObject({ launchModel: opus, sessionModels: { implementer: opus }, nudges: 0, pendingInputs: ["input-1", "input-2"], subSeen: "child-a:working" });
  expect((await x.job("a")).rotation).toBeUndefined();
  expect(b.committed).toHaveBeenCalledWith(expect.objectContaining({ fromAgentId: old, toAgentId: x.created[1].agentId }));
  const before = await x.job("a");
  await x.startTurn(old, "a"); await x.endTurn(old, "a"); await x.automation.kick();
  expect(await x.job("a")).toEqual(before);
  expect(automationSessionRole(await x.store.read(), old)?.role).toBe("retired");
});

test("a stale hot session finalizes once; a reload and lost end hook seal it without an ordinary no-delivery judgment", async () => {
  const { x, b, old } = await running(bridge(true));
  x.hooks.history = () => 1000;
  await requestIdle(x, old);
  expect(x.created).toHaveLength(1);
  expect(x.sent).toHaveLength(1);
  expect(x.sent[0].messageId).toContain(":finalize");
  expect(automationSessionRole(await x.store.read(), old)?.role).toBe("finalizing");
  await x.startTurn(old, "a");
  const rotation = (await x.job("a")).rotation!;
  x.advance(25 * 60_000);
  await x.reload();
  expect(x.created).toHaveLength(1);
  expect(x.sent).toHaveLength(1);
  expect((await x.job("a")).rotation?.id).toBe(rotation.id);
  // No turn-ended hook: the refreshed idle snapshot is enough for the finalization-specific recovery.
  x.agents.get(old)!.status = "idle";
  await x.automation.kick(); await x.automation.kick();
  expect(x.created).toHaveLength(2);
  expect(b.seal).toHaveBeenCalledOnce();
  const events = (await x.store.read()).events;
  expect(events.filter(e => e.action === "automation_nudged")).toHaveLength(0);
  expect(await x.job("a")).toMatchObject({ state: "working", nudges: 0, failures: 0 });
});

test("finalizing failed turn ends seal before ordinary fallback/reminder logic", async () => {
  const { x, old } = await running(bridge(true));
  x.hooks.history = () => 1000;
  await requestIdle(x, old);
  await x.startTurn(old, "a");
  await x.endTurn(old, "a", "failed"); await x.automation.kick();
  expect(x.created).toHaveLength(2);
  expect(x.created[1].prompt).toContain("CARD-HANDOFF");
  expect(await x.job("a")).toMatchObject({ state: "working", failures: 0, nudges: 0 });
});

test("seal errors survive reload with exact carry and identity and cannot cause an unsealed create", async () => {
  const b = bridge(); let failing = true;
  b.seal.mockImplementation(async () => { if (failing) throw new Error("disk unavailable"); return { prompt: "RECOVERED-CARD", revision: 8 }; });
  const { x, old } = await running(b);
  x.hooks.history = id => id === old ? big : null;
  await x.turn(old, "a");
  const rotation = (await x.job("a")).rotation!;
  expect(rotation.stage).toBe("sealing");
  expect(x.created).toHaveLength(1);
  await x.reload();
  expect((await x.job("a")).rotation).toEqual(rotation);
  expect(x.created).toHaveLength(1);
  failing = false; await x.automation.kick();
  expect(x.created).toHaveLength(2);
  expect(x.created[1].prompt).toContain("RECOVERED-CARD");
});

test("an unconfirmed successor only confirms its original prepared identity; no second create after reload", async () => {
  const { x, old } = await running();
  x.hooks.history = id => id === old ? big : null;
  let successor = "";
  x.hooks.create = async id => { successor = id; throw Object.assign(new Error("outcome unknown"), { code: "agent_request_outcome_unknown" }); };
  await x.turn(old, "a");
  const waiting = await x.job("a");
  expect(waiting).toMatchObject({ state: "needs_human", unconfirmed: true, rotation: { stage: "creating", toAgentId: successor } });
  const rotationId = waiting.rotation!.id;
  x.advance(3600_000); await x.reload();
  expect(x.created).toHaveLength(1);
  expect((await x.job("a")).rotation?.id).toBe(rotationId);
  x.hooks.create = undefined;
  // A late discovery of the first identity confirms it without a create or resending its prompt.
  x.agents.set(successor, { id: successor, workspaceId: "w-a", archivedAt: null, status: "running", provider: "claude" });
  await x.automation.kick(); await x.automation.kick();
  expect(x.created).toHaveLength(1);
  expect(x.sent).toHaveLength(0);
  expect(await x.job("a")).toMatchObject({ state: "working", implementerId: successor });
  expect((await x.job("a")).rotation).toBeUndefined();
});

test("a mid-round reviewer replacement retains the exact round plan, delivery and seat", async () => {
  const { x, rev } = await reviewerRun();
  await x.store.mutate(board => {
    const j = board.automation[0];
    j.review = { level: "deep", reason: { kind: "card" }, max: 4, size: 3 }; j.seat = "deep";
    j.risks = ["scale risk"]; j.risksFrom = { round: 1, delivery: j.deliveryEvent };
  });
  const before = await x.job("a");
  x.hooks.history = id => id === rev ? big : null;
  await x.turn(rev, "a");
  const after = await x.job("a");
  expect(after).toMatchObject({ state: "reviewing", reviewRounds: before.reviewRounds, review: before.review, seat: "deep", deliveryEvent: before.deliveryEvent, risks: ["scale risk"], risksFrom: before.risksFrom });
  expect(x.created[2].prompt).toContain("3 independent reviewers");
  expect(x.created[2].prompt).toContain("scale risk");
  await expect(x.automation.submitReview(identity(rev), { verdict: "approve", summary: "late" })).rejects.toMatchObject({ code: "NOT_REVIEWER" });
  await x.automation.submitReview(identity(x.created[2].agentId), { verdict: "approve", summary: "checked" });
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved" });
});

test("fallback uses the same rotation and keeps the unfinished wake payload, pending inputs and parent signature", async () => {
  const { x, b, old } = await running(bridge(), { implementer: opus, implementerFallback: { provider: "codex", model: "gpt-6-luna" } });
  await x.store.mutate(board => {
    const j = board.automation[0];
    j.subSeen = "child-1:in_review:delivered"; j.pendingInputs = ["human-99"];
    j.workInstructions = { implementer: { id: "wake-1", role: "implementer", text: "WAKE: child-1 needs independent review; do not recreate", fresh: "WAKE: child-1 needs independent review; do not recreate", kind: "wake" } };
  });
  x.advance(1000); await x.record("a", { action: "agent.turn_ended", actor: "system", agentId: old, outcome: "failed", note: "429 Too Many Requests" });
  x.agents.get(old)!.status = "idle";
  await x.automation.turnEnded(old); await x.automation.kick();
  expect(x.created).toHaveLength(2);
  expect(b.seal).toHaveBeenCalledWith(expect.objectContaining({ reason: "fallback" }));
  expect(x.created[1].provider).toBe("codex/gpt-6-luna");
  expect(x.created[1].prompt).toContain("WAKE: child-1 needs independent review; do not recreate");
  expect(await x.job("a")).toMatchObject({ subSeen: "child-1:in_review:delivered", pendingInputs: ["human-99"] });
});

test("human Run again makes a fresh implementer, keeps launch model, and retires the previous reviewer", async () => {
  const { x, old } = await running(bridge(), { implementer: opus });
  await x.store.mutate(board => {
    const j = board.automation[0]; j.reviewerId = "old-reviewer"; j.risks = ["unsettled risk"];
    j.subSeen = "child-2:done"; j.pendingInputs = ["unanswered-human"];
  });
  await x.automation.stopJob("a"); x.agents.get(old)!.status = "idle";
  await x.automation.queue("a"); await x.automation.kick();
  expect(x.created).toHaveLength(2);
  expect(x.created[1].agentId).not.toBe(old);
  expect(x.created[1].provider).toBe("claude/claude-opus-5-5");
  expect(await x.job("a")).toMatchObject({ generation: 2, risks: ["unsettled risk"], subSeen: "child-2:done", pendingInputs: ["unanswered-human"] });
  expect(automationSessionRole(await x.store.read(), "old-reviewer")?.role).toBe("retired");
});

test("a healthy soft replacement explicitly rejected on create rolls back the original instruction identity", async () => {
  const { x, b, old } = await running(bridge(), { failureLimit: 1 });
  x.hooks.create = async () => { throw new Error("known provider rejection"); };
  await requestIdle(x, old);
  const j = await x.job("a");
  expect(j).toMatchObject({ implementerId: old, state: "working", failures: 0 });
  expect(j.rotation).toBeUndefined();
  expect(j.rotationAbandoned?.instructionId).toBe(x.sent.at(-1)?.messageId);
  expect(b.abandoned).toHaveBeenCalledOnce();
  x.hooks.create = undefined;
  await x.automation.kick();
  expect(x.created).toHaveLength(1);
  expect(x.sent.at(-1)?.agentId).toBe(old);
});

test("committed bridge failure retains one confirmed successor and retries its card record without creating again", async () => {
  const b = bridge(); let fail = true;
  b.committed.mockImplementation(async () => { if (fail) throw new Error("handoff write failed"); });
  const { x, old } = await running(b);
  x.hooks.history = id => id === old ? big : null;
  await x.turn(old, "a");
  const j = await x.job("a");
  expect(j.rotation).toMatchObject({ stage: "creating", confirmed: true, toAgentId: x.created[1].agentId });
  await x.reload();
  expect(x.created).toHaveLength(2);
  fail = false; await x.automation.kick();
  expect((await x.job("a")).rotation).toBeUndefined();
  expect(x.created).toHaveLength(2);
});

test("a retired session which starts during seal defers create until a fresh idle snapshot", async () => {
  const b = bridge();
  const { x, old } = await running(b);
  b.seal.mockImplementationOnce(async () => { x.agents.get(old)!.status = "running"; return { prompt: "HANDOFF", revision: 1 }; });
  x.hooks.history = id => id === old ? big : null;
  await x.turn(old, "a");
  expect(x.created).toHaveLength(1);
  expect((await x.job("a")).rotation?.stage).toBe("sealing");
  x.agents.get(old)!.status = "idle"; await x.automation.kick();
  expect(x.created).toHaveLength(2);
});

test("a limit while creating a successor switches model within that same prepared rotation", async () => {
  const { x, b, old } = await running(bridge(), { implementer: opus, implementerFallback: { provider: "codex", model: "gpt-6-luna" } });
  x.hooks.history = id => id === old ? big : null;
  const attempts: string[] = [];
  x.hooks.create = async id => { attempts.push(id); if (attempts.length === 1) throw new Error("429 Too Many Requests"); };
  await x.turn(old, "a"); await x.automation.kick();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBe(attempts[1]);
  expect(x.created).toHaveLength(2);
  expect(x.created[1]).toMatchObject({ provider: "codex/gpt-6-luna", modeId: "full-access" });
  expect(b.seal).toHaveBeenCalledOnce();
  expect((await x.job("a")).retired?.map(s => s.agentId)).toEqual([old]);
});

test("a provider limit in the handover turn seals once and selects the fallback for its successor", async () => {
  const { x, b, old } = await running(bridge(true), { implementer: opus, implementerFallback: { provider: "codex", model: "gpt-6-luna" } });
  x.hooks.history = () => 1000;
  await requestIdle(x, old); await x.startTurn(old, "a");
  x.advance(1000); await x.record("a", { actor: "system", action: "agent.turn_ended", agentId: old, outcome: "failed", note: "429 Too Many Requests" });
  x.agents.get(old)!.status = "idle";
  await x.automation.turnEnded(old); await x.automation.kick();
  expect(x.created).toHaveLength(2);
  expect(x.created[1].provider).toBe("codex/gpt-6-luna");
  expect(b.seal).toHaveBeenCalledOnce();
  expect(await x.job("a")).toMatchObject({ fallback: { implementer: true }, failures: 0, nudges: 0 });
});

test("a waiting parent wakes through a new session without losing child identity or its pending wake instruction", async () => {
  const { x, old } = await running();
  await x.store.mutate(board => board.links.push({ id: "b-child-of-a", kind: "subtask", projectId: "p", from: "b", to: "a", createdBy: "human", createdAt: x.at() }));
  await x.automation.queue("b"); await x.automation.kick();
  const child = (await x.job("b")).implementerId!;
  await x.turn(old, "a");
  expect(await x.job("a")).toMatchObject({ state: "waiting", code: "sub_cards" });
  x.hooks.history = id => id === old ? big : null;
  await x.deliver(child, "b"); await x.turn(child, "b");
  const after = await x.job("a");
  expect(after.state).toBe("working");
  expect(after.implementerId).not.toBe(old);
  expect(after.subSeen).toContain("b:in_review:delivered");
  expect(x.created.at(-1)?.prompt).toContain("Card b");
  expect(x.created.at(-1)?.prompt).toContain("Card b (b): In review; automation delivered");
  expect((await x.store.read()).tasks.map(t => t.id)).toEqual(["a", "b"]);
  expect((await x.store.read()).links).toHaveLength(1);
});

test("consuming the first-launch attachment file does not lose the human-selected full model", async () => {
  const x = await automationFixture({ enabled: true, implementer: { provider: "codex", model: "gpt-6-luna" } }, bridge());
  await x.automation.queue("a", undefined, undefined, { operationId: "human-create", clientMessageId: "human-first-message", model: opus });
  await x.automation.kick();
  const old = x.created[0].agentId;
  expect(await x.job("a")).toMatchObject({ launchConsumed: true, launchModel: opus });
  x.hooks.history = id => id === old ? big : null;
  await x.turn(old, "a");
  expect(x.created[1]).toMatchObject({ provider: "claude/claude-opus-5-5", modeId: "bypassPermissions", featureValues: { fast_mode: true } });
  expect((await x.job("a")).launchModel).toEqual(opus);
});

test("a requested fresh session refuses to interrupt an active turn", async () => {
  const { x, old } = await running();
  const before = await x.job("a");
  await expect(x.automation.requestFresh("a")).rejects.toMatchObject({ code: "SESSION_BUSY" });
  expect(await x.job("a")).toEqual(before);
  expect(x.created).toHaveLength(1);
  expect(x.sent).toHaveLength(0);
  expect(x.agents.get(old)?.status).toBe("running");
});

test("a creating predecessor never regains ordinary write ownership, even before the new identity is recorded", async () => {
  const { x, old } = await running();
  const board = await x.store.read();
  board.automation[0].rotation = { id: "recovering", role: "implementer", fromAgentId: old, reason: "requested", stage: "creating", forced: false, at: x.at(), carry: { id: "original", role: "implementer", text: "continue", fresh: "continue" } };
  expect(automationSessionRole(board, old)?.role).toBe("finalizing");
  board.automation[0].implementerId = "confirmed-new-identity";
  expect(automationSessionRole(board, old)?.role).toBe("retired");
  expect(automationSessionRole(board, "confirmed-new-identity")?.role).toBe("implementer");
});

test("a stale fresh request cannot retire a different generation which changed during refresh", async () => {
  const { x, old } = await running();
  x.agents.get(old)!.status = "idle";
  x.hooks.refresh = async id => {
    if (id === old) {
      x.hooks.refresh = undefined;
      await x.store.mutate(board => { board.automation[0].generation++; });
    }
  };
  await expect(x.automation.requestFresh("a")).rejects.toThrow("session changed");
  expect((await x.job("a")).rotation).toBeUndefined();
  expect(x.created).toHaveLength(1);
});

test("a known forced-create failure keeps carry for a later human retry of the same identity", async () => {
  const { x, old } = await running(bridge(), { failureLimit: 1 });
  x.hooks.history = id => id === old ? big : null;
  let attempted = "";
  x.hooks.create = async id => { attempted = id; throw new Error("known rejected create"); };
  await x.turn(old, "a");
  const failed = await x.job("a");
  expect(failed.state).toBe("failed");
  expect(failed.rotation?.carry).toMatchObject({ kind: "nudge" });
  x.hooks.create = undefined;
  await x.automation.queue("a"); await x.automation.kick();
  expect(x.created).toHaveLength(2);
  expect(x.created[1].agentId).toBe(attempted);
  expect(await x.job("a")).toMatchObject({ state: "working", generation: 2 });
});
