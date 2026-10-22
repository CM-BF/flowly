import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import { AutomationService } from "./automation";
import type { AutomationSettings } from "../shared/automation";
import type { ToolPreparation } from "../shared/tools";
import type { BoardEvent, Status, Task } from "../shared/model";
import { randomUUID } from "node:crypto";

const roots: string[] = [];
const services: AutomationService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

type Agent = { id: string; workspaceId: string; archivedAt: string | null; status: string; provider?: string };
type Created = { workspaceId: string; agentId: string; provider: string; modeId?: string; prompt: string; title: string; labels: Record<string, string> };

/** A board with cards a, b (todo) and a fake Paseo that records created sessions and sent messages. */
async function setup(automation: Partial<AutomationSettings> | null = { enabled: true }) {
  const root = await mkdtemp(join(tmpdir(), "flowly-automation-test-"));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  const stamp = new Date().toISOString();
  await store.mutate((board) => {
    board.projects.push({
      id: "p",
      title: "P",
      description: "",
      paseoProjectId: "native",
      primaryPath: root,
      repos: [root],
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null,
      ...(automation ? { automation: { enabled: true, ...automation } as AutomationSettings } : {}),
    });
    for (const id of ["a", "b"])
      board.tasks.push({
        id,
        projectId: "p",
        workspaceId: `w-${id}`,
        sourcePath: root,
        repoPaths: [],
        title: `Card ${id}`,
        description: "",
        status: "todo",
        priority: "normal",
        position: 0,
        revision: 1,
        operationId: `create-${id}`,
        createdAt: stamp,
        updatedAt: stamp,
        archivedAt: null,
      });
  });
  const agents = new Map<string, Agent>();
  const created: Created[] = [];
  const sent: { agentId: string; text: string }[] = [];
  const prepared = new Map<string, string>();
  let failCreate = 0;
  const hooks: { prepare?: () => Promise<void>; refresh?: () => Promise<void>; send?: () => Promise<void>; created?: (id: string) => Promise<void> } = {};
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => { await hooks.refresh?.(); return agents.has(id) ? { agent: agents.get(id) } : null; },
        send: async (text: string, options: { activeTurnBehavior?: string; messageId?: string } = {}) => {
          await hooks.send?.();
          expect(options.activeTurnBehavior).toBe("steer");
          expect(options.messageId).toBeTruthy();
          if (!agents.has(id)) throw new Error("no such agent");
          sent.push({ agentId: id, text });
        },
      }),
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        refresh: async () => ({ workspaceDirectory: join(root, workspaceId) }),
        agents: {
          create: async (o: { agentId: string; config: { provider: string; modeId?: string }; prompt: string; title: string; labels: Record<string, string> }) => {
            if (failCreate > 0) {
              failCreate--;
              throw new Error("provider down");
            }
            agents.set(o.agentId, { id: o.agentId, workspaceId, archivedAt: null, status: "running", provider: o.config.provider.split("/")[0] });
            await hooks.created?.(o.agentId);
            created.push({ workspaceId, agentId: o.agentId, provider: o.config.provider, modeId: o.config.modeId, prompt: o.prompt, title: o.title, labels: o.labels });
            return { id: o.agentId };
          },
        },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "claude", available: true }] }),
      listModels: async () => ({ models: [{ id: "claude-haiku-4-5", isDefault: true }] }),
    },
  } as unknown as PaseoApi;
  let now = Date.parse(stamp);
  const automationService = new AutomationService(store, {
    clock: () => now,
    globalModel: async () => null,
    prepare: async (taskId: string, op: string): Promise<ToolPreparation> => {
      await hooks.prepare?.();
      if (!prepared.has(op)) prepared.set(op, `${taskId}-agent-${prepared.size + 1}`);
      return { agentId: prepared.get(op)!, contextFile: "/ctx", cliPath: "/cli", skillPath: "/skill", instructions: `card ${taskId}`, mcp: { type: "http", url: "http://x/mcp", headers: {} } };
    },
  });
  services.push(automationService);
  automationService.attach(paseo);
  await automationService.kick();
  const task = async (id: string) => (await store.read()).tasks.find((t) => t.id === id)!;
  const job = async (id: string) => (await store.read()).automation.find((j) => j.taskId === id)!;
  /** An event stamped with the test clock, as the turn hook and the agent tools record them. */
  const record = (taskId: string, event: Omit<BoardEvent, "id" | "at" | "taskId">) =>
    store.mutate((board) => {
      board.events.push({ ...event, taskId, id: randomUUID(), at: new Date(now).toISOString() });
    });
  /** What the turn hook records, then hands to automation. */
  const turn = async (agentId: string, taskId: string, outcome: "completed" | "failed" | "canceled" = "completed", work?: (t: Task) => void) => {
    now += 1000;
    await record(taskId, { actor: "system", action: "agent.turn_started", agentId });
    if (work)
      await store.mutate((board) => {
        work(board.tasks.find((x) => x.id === taskId)!);
      });
    now += 1000;
    await record(taskId, { actor: "system", action: "agent.turn_ended", agentId, outcome, ...(outcome === "failed" ? { note: "worker crashed" } : {}) });
    now += 1000;
    const ended = agents.get(agentId);
    if (ended) ended.status = "idle";
    await automationService.turnEnded(agentId);
    await automationService.kick();
  };
  const setStatus = (status: Status) => (t: Task) => {
    t.status = status;
    t.revision++;
  };
  return {
    store,
    hooks,
    automation: automationService,
    agents,
    created,
    sent,
    task,
    job,
    turn,
    record,
    setStatus,
    advance: (ms: number) => {
      now += ms;
    },
    failNextCreates: (n: number) => {
      failCreate = n;
    },
  };
}

test("Run with agent needs automation on for the project", async () => {
  const x = await setup(null);
  await expect(x.automation.queue("a")).rejects.toThrow(/Turn on agent automation/);
});

test("a queued card gets an unattended session in its own workspace with the card's tools", async () => {
  const x = await setup({ enabled: true, implementer: { provider: "claude", model: "claude-haiku-4-5" } });
  await x.automation.queue("a");
  await x.automation.kick();
  expect(x.created).toHaveLength(1);
  expect(x.created[0]).toMatchObject({ workspaceId: "w-a", provider: "claude/claude-haiku-4-5", modeId: "bypassPermissions", labels: { "flowly-task": "a", "flowly-automation": "implementer" } });
  expect(x.created[0].prompt).toMatch(/^\[Flowly automation\]/);
  expect(await x.job("a")).toMatchObject({ state: "working", implementerId: x.created[0].agentId });
  await expect(x.automation.queue("a")).rejects.toThrow(/already queued or running/);
});

test("the project's slots, priorities and blockers decide what starts", async () => {
  const x = await setup({ enabled: true, maxRunning: 1 });
  await x.store.mutate((board) => {
    board.links.push({ id: "l", projectId: "p", kind: "blocks", from: "a", to: "b", createdBy: "human", createdAt: new Date().toISOString() });
  });
  await x.automation.queue("b");
  await x.automation.queue("a");
  await x.automation.kick();
  // b waits on a; a takes the only slot.
  expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a"]);
  const impl = x.created[0].agentId;
  await x.turn(impl, "a", "completed", x.setStatus("in_review"));
  expect((await x.job("a")).state).toBe("delivered");
  // Delivered is not Done: b still waits.
  expect(x.created).toHaveLength(1);
  await x.store.mutate((board) => {
    board.tasks.find((t) => t.id === "a")!.status = "done";
  });
  await x.automation.kick();
  expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a", "w-b"]);
});

test("a turn without a delivery is nudged, then the card is blocked and automation stops", async () => {
  const x = await setup({ enabled: true, nudgeLimit: 1 });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.turn(impl, "a", "completed", x.setStatus("development"));
  expect(x.sent.map((s) => s.text)).toEqual([expect.stringMatching(/reminder 1 of 1/)]);
  // The hook and the reconcile pass see the same turn end once.
  await x.automation.turnEnded(impl);
  await x.automation.kick();
  expect(x.sent).toHaveLength(1);
  await x.turn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "failed", code: "no_delivery" });
  const task = await x.task("a");
  expect(task.status).toBe("blocked");
  const board = await x.store.read();
  expect(board.events.find((e) => e.taskId === "a" && e.rule === "AUTO")).toMatchObject({ from: "development", to: "blocked" });
});

test("a question waits for the person; their reply resumes supervision", async () => {
  const x = await setup();
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.turn(impl, "a", "completed", () => undefined);
  // That turn was silent: one reminder. The next turn asks.
  x.advance(1000);
  await x.record("a", { actor: "system", action: "agent.turn_started", agentId: impl });
  await x.record("a", { actor: "agent", action: "progress_reported", agentId: impl, reportKind: "question", note: "Which database?" });
  x.advance(1000);
  await x.record("a", { actor: "system", action: "agent.turn_ended", agentId: impl, outcome: "completed" });
  x.advance(1000);
  await x.automation.turnEnded(impl);
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "question" });
  await x.automation.turnStarted(impl);
  expect(await x.job("a")).toMatchObject({ state: "working", nudges: 0 });
});

test("a failed turn is retried in the same session after a backoff, then gives up", async () => {
  const x = await setup({ enabled: true, failureLimit: 2 });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.turn(impl, "a", "failed", x.setStatus("development"));
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", failures: 1, detail: "worker crashed" });
  await x.automation.kick();
  expect(x.sent).toHaveLength(0);
  x.advance(30_000);
  await x.automation.kick();
  expect(x.sent.map((s) => s.text)).toEqual([expect.stringMatching(/The last turn failed: worker crashed/)]);
  await x.turn(impl, "a", "failed");
  expect(await x.job("a")).toMatchObject({ state: "failed", code: "failed" });
  expect((await x.task("a")).status).toBe("blocked");
});

test("a failed session start is retried, then reported without touching the card", async () => {
  const x = await setup({ enabled: true, failureLimit: 2 });
  x.failNextCreates(2);
  await x.automation.queue("a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", code: "start_failed" });
  x.advance(30_000);
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "failed", code: "start_failed" });
  expect((await x.task("a")).status).toBe("todo");
});

test("review loop: changes go back to the implementer, the next delivery is reviewed again, approval waits for the user", async () => {
  const x = await setup({ enabled: true, reviewer: { provider: "codex", model: "gpt-6-luna" }, maxReviewRounds: 3 });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.turn(impl, "a", "completed", x.setStatus("in_review"));
  expect(await x.job("a")).toMatchObject({ state: "reviewing", role: "reviewer", reviewRounds: 1 });
  expect(x.created[1]).toMatchObject({ workspaceId: "w-a", provider: "codex/gpt-6-luna", modeId: "full-access", labels: { "flowly-automation": "reviewer" } });
  expect(x.created[1].prompt).toMatch(/review round 1 of 3/);
  const rev = x.created[1].agentId;
  // Only the reviewer may give the verdict.
  await expect(x.automation.submitReview({ agentId: impl, taskId: "a", workspaceId: "w-a" }, { verdict: "approve", summary: "self" })).rejects.toMatchObject({ code: "NOT_REVIEWER" });
  const answer = await x.automation.submitReview({ agentId: rev, taskId: "a", workspaceId: "w-a" }, { verdict: "changes", summary: "Tests missing", findings: ["src/a.ts: no test for empty input"] });
  expect(answer).toMatchObject({ accepted: true, verdict: "changes" });
  x.agents.get(rev)!.status = "idle";
  await x.automation.kick();
  await vi.waitFor(() => expect(x.sent.at(-1)).toMatchObject({ agentId: impl, text: expect.stringMatching(/requested changes[\s\S]*no test for empty input/) }));
  expect((await x.task("a")).status).toBe("development");
  // The reviewer's own turn end no longer matters; a repeated verdict is acknowledged once.
  await x.turn(rev, "a");
  expect(await x.automation.submitReview({ agentId: rev, taskId: "a", workspaceId: "w-a" }, { verdict: "changes", summary: "Tests missing" })).toMatchObject({ replayed: true });
  await x.turn(impl, "a", "completed", x.setStatus("in_review"));
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 2 });
  // Round 2 goes to the same reviewer session.
  expect(x.created).toHaveLength(2);
  expect(x.sent.at(-1)).toMatchObject({ agentId: rev, text: expect.stringMatching(/review round 2 of 3/) });
  await x.automation.submitReview({ agentId: rev, taskId: "a", workspaceId: "w-a" }, { verdict: "approve", summary: "Looks good" });
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved" });
  expect((await x.task("a")).status).toBe("in_review");
});

test("a person finishing or taking back the card stops its automation; sessions are left alone", async () => {
  const x = await setup();
  await x.automation.queue("a");
  await x.automation.queue("b");
  await x.automation.kick();
  await x.automation.cardMoved("a", "todo", "done");
  expect(await x.job("a")).toMatchObject({ state: "stopped", code: "card_finished" });
  await x.automation.cardMoved("b", "development", "todo");
  expect(await x.job("b")).toMatchObject({ state: "stopped", code: "card_moved" });
  expect([...x.agents.values()].every((a) => !a.archivedAt)).toBe(true);
  // Run again later: the implementer session is reused, not a third one.
  await x.store.mutate((board) => {
    board.tasks.find((t) => t.id === "b")!.status = "todo";
  });
  x.agents.get((await x.job("b")).implementerId!)!.status = "idle";
  await x.automation.queue("b");
  await x.automation.kick();
  expect(x.created).toHaveLength(2);
  expect(x.sent.at(-1)).toMatchObject({ text: expect.stringMatching(/queued this card again/) });
  expect(await x.job("b")).toMatchObject({ state: "working", generation: 2 });
});

test("a turn end the hook missed is picked up by the next pass", async () => {
  const x = await setup();
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  x.advance(1000);
  await x.store.mutate((board) => {
    board.tasks.find((t) => t.id === "a")!.status = "in_review";
  });
  await x.record("a", { actor: "system", action: "agent.turn_ended", agentId: impl, outcome: "completed" });
  await x.automation.kick();
  expect((await x.job("a")).state).toBe("delivered");
});

test("an archived implementer under a running job ends it as unavailable", async () => {
  const x = await setup();
  await x.automation.queue("a");
  await x.automation.kick();
  x.agents.get(x.created[0].agentId)!.archivedAt = new Date().toISOString();
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "failed", code: "session_unavailable" });
});

test("a person moving a blocker to Done starts the card it blocked right away", async () => {
  const x = await setup();
  await x.store.mutate((board) => {
    board.links.push({ id: "l", projectId: "p", kind: "blocks", from: "a", to: "b", createdBy: "human", createdAt: new Date().toISOString() });
  });
  await x.automation.queue("b");
  await x.automation.kick();
  expect(x.created).toHaveLength(0);
  await x.store.mutate((board) => {
    board.tasks.find((t) => t.id === "a")!.status = "done";
  });
  // Card a has no job of its own; the move alone must run the dispatcher.
  await x.automation.cardMoved("a", "in_review", "done");
  await vi.waitFor(() => expect(x.created.map((c) => c.workspaceId)).toEqual(["w-b"]));
});


test("Stop while prepare is suspended prevents the old generation from creating a session", async () => {
  const x = await setup();
  let release!: () => void;
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  x.hooks.prepare = async () => { entered(); await gate; };
  await x.automation.queue("a");
  await preparing;
  await x.automation.stopJob("a");
  release();
  await x.automation.kick();
  expect(x.created).toHaveLength(0);
  expect(await x.job("a")).toMatchObject({ state: "stopped" });
});

test("busy sessions defer the exact instruction instead of interrupting a running turn", async () => {
  const x = await setup();
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.automation.stopJob("a");
  await x.automation.queue("a");
  await x.automation.kick();
  const pending = (await x.job("a")).instruction!;
  expect(x.sent).toHaveLength(0);
  expect(pending.text).toMatch(/queued this card again/);
  x.agents.get(impl)!.status = "idle";
  await x.automation.kick();
  expect(x.sent).toEqual([{ agentId: impl, text: pending.text }]);
  expect((await x.job("a")).instruction).toBeUndefined();
});

test("reviewer creation exhaustion cannot reuse its preparation for the implementer", async () => {
  const x = await setup({ enabled: true, reviewer: { provider: "codex", model: "gpt-6-luna" } });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  x.failNextCreates(2);
  await x.turn(impl, "a", "completed", x.setStatus("in_review"));
  x.advance(30_000);
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "incomplete", implementerId: impl });
  expect((await x.job("a")).pendingOp).toBeUndefined();
  await x.automation.turnStarted(impl);
  x.advance(121_000);
  await x.automation.kick();
  expect(x.created).toHaveLength(1);
  expect((await x.job("a")).implementerId).toBe(impl);
});

test("disabled automation freezes pending starts and archived cards stop supervision", async () => {
  const x = await setup();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  x.hooks.prepare = async () => { entered(); await gate; };
  await x.automation.queue("a");
  await started;
  await x.store.mutate((b) => { b.projects[0].automation!.enabled = false; });
  release();
  await x.automation.kick();
  expect(x.created).toHaveLength(0);
  expect((await x.job("a")).instruction).toBeTruthy();
  await x.store.mutate((b) => { b.projects[0].automation!.enabled = true; b.tasks[0].archivedAt = new Date().toISOString(); });
  await x.automation.kick();
  expect((await x.job("a")).state).toBe("stopped");
  expect(x.created).toHaveLength(0);
});

test("transient refresh errors retry the same session and payload without creating a replacement", async () => {
  const x = await setup();
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  x.agents.get(impl)!.status = "idle";
  x.hooks.refresh = async () => { throw new Error("temporary RPC failure"); };
  await x.automation.stopJob("a");
  await x.automation.queue("a");
  await x.automation.kick();
  const pending = (await x.job("a")).instruction!;
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", implementerId: impl });
  x.hooks.refresh = undefined;
  x.advance(30_000);
  await x.automation.kick();
  expect(x.created).toHaveLength(1);
  expect(x.sent.at(-1)).toEqual({ agentId: impl, text: pending.text });
});

test("successful turns reset the consecutive-failure counter", async () => {
  const x = await setup({ enabled: true, failureLimit: 2, nudgeLimit: 3 });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.turn(impl, "a", "failed");
  x.advance(30_000);
  await x.automation.kick();
  await x.turn(impl, "a");
  await x.turn(impl, "a", "failed");
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", failures: 1 });
});

test("an unrecorded idle outcome releases the slot conservatively after a grace period", async () => {
  const x = await setup({ enabled: true, maxRunning: 1 });
  await x.automation.queue("a");
  await x.automation.kick();
  await x.automation.queue("b");
  x.agents.get(x.created[0].agentId)!.status = "idle";
  x.advance(121_000);
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "interrupted" });
  expect(x.created).toHaveLength(2);
  expect((await x.store.read()).events.filter((e) => e.action === "agent.turn_ended")).toHaveLength(0);
});


test("a native turn starting before the create reply acknowledges its preparation", async () => {
  const x = await setup();
  x.hooks.created = (id) => x.automation.turnStarted(id);
  await x.automation.queue("a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "working" });
  expect((await x.job("a")).pendingOp).toBeUndefined();
  await x.turn(x.created[0].agentId, "a");
  expect(x.sent).toHaveLength(1);
  expect(x.sent[0].text).toMatch(/reminder/);
});

test("provider limits cool down without exhausting cards or draining more project slots", async () => {
  const x = await setup({ enabled: true, maxRunning: 2 });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  x.advance(1000);
  await x.record("a", { actor: "system", action: "agent.turn_started", agentId: impl });
  x.advance(1000);
  await x.record("a", { actor: "system", action: "agent.turn_ended", agentId: impl, outcome: "failed", note: "429 rate limit reached" });
  await x.automation.turnEnded(impl);
  await x.automation.queue("b");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "retry_wait", code: "cooldown", failures: 0, cooldowns: 1 });
  expect((await x.job("b")).state).toBe("queued");
  expect(x.created).toHaveLength(1);
});

test("approved delivery followed by a casual answer does not open another review", async () => {
  const x = await setup({ enabled: true, reviewer: { provider: "codex", model: "gpt-6-luna" } });
  await x.automation.queue("a"); await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.record("a", { actor: "agent", action: "status_changed", agentId: impl, to: "in_review" });
  await x.turn(impl, "a", "completed", x.setStatus("in_review"));
  const reviewer = x.created[1].agentId;
  await x.automation.submitReview({ agentId: reviewer, taskId: "a", workspaceId: "w-a" }, { verdict: "approve", summary: "Checked" });
  await x.automation.turnStarted(impl);
  await x.turn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved", reviewRounds: 1 });
  expect(x.created).toHaveLength(2);
});


test("unknown send outcome pauses rather than reusing or replacing a message blindly", async () => {
  const x = await setup();
  await x.automation.queue("a"); await x.automation.kick();
  const impl = x.created[0].agentId;
  x.agents.get(impl)!.status = "idle";
  x.hooks.send = async () => { throw Object.assign(new Error("agent_request_outcome_unknown"), { code: "agent_request_outcome_unknown" }); };
  await x.automation.stopJob("a"); await x.automation.queue("a"); await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "needs_human", code: "interrupted", failures: 0 });
  const id = (await x.job("a")).instruction!.id;
  x.advance(1_000_000); await x.automation.kick();
  expect((await x.job("a")).instruction!.id).toBe(id);
  expect(x.created).toHaveLength(1);
});
