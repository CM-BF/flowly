import { expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import { AutomationService } from "./automation";
import type { AutomationSettings } from "../shared/automation";
import { reviewingJob } from "../shared/automation";
import type { ToolPreparation } from "../shared/tools";
import { applyTurnEnded, applyTurnStarted } from "./progress-rules";
import type { BoardEvent, Status, Task } from "../shared/model";

// Test fixture only; runtime entries never import this module. It never reaches a daemon:
// the Paseo API is an in-memory fake and the board lives in a temp directory.
const roots: string[] = [];
const services: AutomationService[] = [];
/** Drains every dispatcher before its store directory is deleted; call it from afterEach. */
export async function cleanupAutomationFixtures() {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
}

type Agent = { id: string; workspaceId: string; archivedAt: string | null; status: string; provider?: string };
type Created = { images?: { data: string; mimeType: string }[]; clientMessageId?: string; featureValues?: Record<string, boolean | string>; workspaceId: string; agentId: string; provider: string; modeId?: string; prompt: string; title: string; labels: Record<string, string> };

/** A board with cards a, b (todo) and a fake Paseo that records created sessions and sent messages. */
export async function automationFixture(automation: Partial<AutomationSettings> | null = { enabled: true }) {
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
  const sent: { agentId: string; text: string; messageId?: string; images?: unknown[] }[] = [];
  const prepared = new Map<string, string>();
  let failCreate = 0;
  const hooks: { prepare?: () => Promise<void>; refresh?: () => Promise<void>; send?: () => Promise<void>; created?: (id: string) => Promise<void> } = {};
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => { await hooks.refresh?.(); return agents.has(id) ? { agent: agents.get(id) } : null; },
        send: async (text: string, options: { activeTurnBehavior?: string; messageId?: string; images?: unknown[] } = {}) => {
          await hooks.send?.();
          expect(options.activeTurnBehavior).toBe("steer");
          expect(options.messageId).toBeTruthy();
          if (!agents.has(id)) throw new Error("no such agent");
          sent.push({ agentId: id, text, messageId: options.messageId, images: options.images });
        },
      }),
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        refresh: async () => ({ workspaceDirectory: join(root, workspaceId) }),
        agents: {
          create: async (o: { agentId: string; images?: { data: string; mimeType: string }[]; clientMessageId?: string; config: { provider: string; modeId?: string; featureValues?: Record<string, boolean | string> }; prompt: string; title: string; labels: Record<string, string> }) => {
            if (failCreate > 0) {
              failCreate--;
              throw new Error("provider down");
            }
            agents.set(o.agentId, { id: o.agentId, workspaceId, archivedAt: null, status: "running", provider: o.config.provider.split("/")[0] });
            await hooks.created?.(o.agentId);
            created.push({ images: o.images, clientMessageId: o.clientMessageId, featureValues: o.config.featureValues, workspaceId, agentId: o.agentId, provider: o.config.provider, modeId: o.config.modeId, prompt: o.prompt, title: o.title, labels: o.labels });
            return { id: o.agentId };
          },
        },
      }),
    },
    providers: {
      listFeatures: async () => ({ features: [{ type: "toggle", id: "fast_mode", value: true, label: "Fast" }] }),
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
  const identity = (agentId: string, taskId: string) => ({ agentId, taskId, workspaceId: `w-${taskId}` });
  /** What the agent.turn_started hook does (index.server.ts): the lifecycle fact, rule A1 unless the session is exempt, then automation. */
  const startTurn = async (agentId: string, taskId: string) => {
    now += 1000;
    const started = agents.get(agentId);
    if (started) started.status = "running";
    await store.mutate((board) => {
      board.events.push({ id: randomUUID(), at: new Date(now).toISOString(), taskId, actor: "system", action: "agent.turn_started", agentId });
      if (!reviewingJob(board, agentId)) applyTurnStarted(store, board, identity(agentId, taskId), "Session");
    });
    await automationService.turnStarted(agentId, taskId);
  };
  /** What the agent.turn_ended hook does: the lifecycle fact, rule A1r, then automation. No extra dispatcher pass. */
  const endTurn = async (agentId: string, taskId: string, outcome: "completed" | "failed" | "canceled" = "completed", { idle = true } = {}) => {
    now += 1000;
    await store.mutate((board) => {
      board.events.push({ id: randomUUID(), at: new Date(now).toISOString(), taskId, actor: "system", action: "agent.turn_ended", agentId, outcome, ...(outcome === "failed" ? { note: "worker crashed" } : {}) });
      applyTurnEnded(store, board, identity(agentId, taskId), outcome === "failed" ? { kind: "failed", error: { message: "worker crashed" } } : outcome === "canceled" ? { kind: "canceled", reason: "interrupted" } : { kind: "completed" });
    });
    now += 1000;
    const ended = agents.get(agentId);
    if (ended && idle) ended.status = "idle";
    await automationService.turnEnded(agentId);
  };
  /** The agent delivers: its own status change to In review, as flowly_update_status records it. */
  const deliver = async (agentId: string, taskId: string) => {
    await store.mutate((board) => {
      const t = board.tasks.find((x) => x.id === taskId)!;
      t.status = "in_review";
      t.revision++;
      board.events.push({ id: randomUUID(), at: new Date(now).toISOString(), taskId, actor: "agent", action: "status_changed", agentId, to: "in_review" });
    });
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
    startTurn,
    endTurn,
    deliver,
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

/** Card a delivered once and under review in round 1 (codex reviewer); the reviewer session is still in its first turn. */
export async function underReview(settings: Partial<AutomationSettings> = {}) {
  const x = await automationFixture({ enabled: true, reviewer: { provider: "codex", model: "gpt-6-luna" }, ...settings });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", role: "reviewer", reviewRounds: 1 });
  return { x, impl, rev: x.created[1].agentId };
}
