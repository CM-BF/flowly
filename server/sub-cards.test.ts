import { afterEach, expect, test, vi } from "vitest";
import { rm } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { agentFixture } from "./agent-fixture";
import { BoardService } from "./service";
import { createLink } from "./links";
import { AutomationService } from "./automation";
import { childrenOf, depthOf, parentOf, subCardLimits, subCardProblem } from "../shared/links";
import type { Link, Task } from "../shared/model";
import type { ToolPreparation } from "../shared/tools";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const sub = (from: string, to: string): Link => ({ id: `${from}-${to}`, projectId: "p", kind: "subtask", from, to, createdBy: "human", createdAt: "2026-10-22T00:00:00.000Z" });

test("a card has one parent, trees stay shallow and parents have a bounded number of sub-cards", () => {
  const links = [sub("b", "a"), sub("c", "b")];
  expect(parentOf(links, "c")).toBe("b");
  expect(childrenOf(links, "a")).toEqual(["b"]);
  expect(depthOf(links, "c")).toBe(2);
  expect(subCardProblem(links, "a", "c")).toMatch(/already a sub-card/);
  // c's tree (height 0) under b (depth 1) fits; d under c makes 3 levels, one more is too deep.
  expect(subCardProblem(links, "c", "d")).toBe("");
  expect(subCardProblem([...links, sub("d", "c")], "d", "e")).toMatch(/levels deep/);
  const full = Array.from({ length: subCardLimits.perParent }, (_, i) => sub(`k${i}`, "z"));
  expect(subCardProblem(full, "z", "new")).toMatch(/at most/);
});

/** The agent fixture plus a real BoardService whose workspaces are created by a fake SDK. */
async function setup() {
  const f = await agentFixture();
  roots.push(f.root);
  let workspaces = 0;
  const create = vi.fn(async () => ({ id: `new-ws-${++workspaces}` }));
  const paseo = f.paseo as unknown as { workspaces: Record<string, unknown> };
  paseo.workspaces.create = create;
  const board = new BoardService(f.store);
  f.service.createTask = (input, api, agent) => board.createTask(input, api, agent);
  const moves: { previous?: string; to: string }[] = [];
  f.service.onStatusChange = (previous, task) => moves.push({ previous, to: task.status });
  const request = async () => {
    const ctx = await f.service.get(f.identity);
    return { expectedRevision: ctx.revision, request: ctx.request };
  };
  return { ...f, create, moves, request };
}

test("an agent creates a sub-card in its own workspace, linked and ordered in the same write, idempotently", async () => {
  const x = await setup();
  const first = await x.service.createCard(x.identity, { ...(await x.request()), title: "Part one", description: "Do part one" });
  expect(first).toMatchObject({ subCardOf: "t", status: "todo", queued: false });
  const signed = await x.request();
  const second = await x.service.createCard(x.identity, { ...signed, title: "Part two", blockedBy: [first.cardId], start: "later" });
  expect(second.status).toBe("backlog");
  // The same request again returns the same card, without a second workspace.
  expect(await x.service.createCard(x.identity, { ...signed, title: "Part two", blockedBy: [first.cardId], start: "later" })).toMatchObject({ cardId: second.cardId, replayed: true });
  expect(x.create).toHaveBeenCalledTimes(2);
  const board = await x.store.read();
  expect(childrenOf(board.links, "t")).toEqual([first.cardId, second.cardId]);
  expect(board.links).toContainEqual(expect.objectContaining({ kind: "blocks", from: first.cardId, to: second.cardId }));
  const created = board.tasks.find((t) => t.id === first.cardId)!;
  expect(created.createdByAgent).toEqual({ agentId: "actor", taskId: "t" });
  expect(board.events.find((e) => e.taskId === first.cardId && e.action === "created")).toMatchObject({ actor: "agent", agentId: "actor" });
  // Blockers must be cards of the project; nothing is created otherwise.
  await expect(x.service.createCard(x.identity, { ...(await x.request()), title: "Bad", blockedBy: ["nope"] })).rejects.toMatchObject({ code: "CARD_INVALID" });
  expect(x.create).toHaveBeenCalledTimes(2);
});

test("the parent's agent starts, accepts and cancels only its own sub-cards", async () => {
  const x = await setup();
  const made = await x.service.createCard(x.identity, { ...(await x.request()), title: "Child", start: "later" });
  const other = await x.service.createCard(x.identity, { ...(await x.request()), title: "Separate", subCard: false });
  expect(other.subCardOf).toBeUndefined();
  await expect(x.service.updateCard(x.identity, { ...(await x.request()), cardId: other.cardId, action: "cancel" })).rejects.toMatchObject({ code: "NOT_PARENT" });
  await expect(x.service.updateCard(x.identity, { ...(await x.request()), cardId: made.cardId, action: "accept" })).rejects.toMatchObject({ code: "NOT_DELIVERED" });
  // Automation is off: start only moves it out of Backlog.
  expect(await x.service.updateCard(x.identity, { ...(await x.request()), cardId: made.cardId, action: "start" })).toMatchObject({ status: "todo", queued: false });
  await x.store.mutate((board) => {
    board.tasks.find((t) => t.id === made.cardId)!.status = "in_review";
  });
  expect(await x.service.updateCard(x.identity, { ...(await x.request()), cardId: made.cardId, action: "accept" })).toMatchObject({ status: "done" });
  expect(await x.service.updateCard(x.identity, { ...(await x.request()), cardId: made.cardId, action: "accept" })).toMatchObject({ replayed: true });
  // A person's move effects (automation, wrap-up, memory) run for the agent's moves too.
  expect(x.moves).toEqual([
    { previous: "backlog", to: "todo" },
    { previous: "in_review", to: "done" },
  ]);
  const board = await x.store.read();
  expect(board.events.find((e) => e.taskId === made.cardId && e.to === "done")).toMatchObject({ actor: "agent", agentId: "actor" });
});

test("a human can link a card under a parent, never into a second parent or under its own sub-card", async () => {
  const x = await setup();
  const stamp = new Date().toISOString();
  await x.store.mutate((board) => {
    for (const id of ["u", "v"]) board.tasks.push({ ...(board.tasks[0] as Task), id, workspaceId: `w-${id}`, operationId: `op-${id}`, title: id, createdAt: stamp, updatedAt: stamp });
  });
  await createLink(x.store, { kind: "subtask", from: "u", to: "t" });
  await expect(createLink(x.store, { kind: "subtask", from: "u", to: "v" })).rejects.toThrow(/already a sub-card/);
  await expect(createLink(x.store, { kind: "subtask", from: "t", to: "u" })).rejects.toThrow();
  expect((await x.store.read()).links.filter((l) => l.kind === "subtask")).toHaveLength(1);
});

test("automation: a parent that dispatched sub-cards waits without a slot and wakes with their state once they settle", async () => {
  const x = await setup();
  await x.store.mutate((board) => {
    board.projects[0].automation = { enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 };
  });
  const sent: { agentId: string; text: string }[] = [];
  const agents = new Map<string, { id: string; workspaceId: string; archivedAt: null }>();
  const api = x.paseo as unknown as { agents: { ref(id: string): Record<string, unknown> }; workspaces: Record<string, unknown> };
  const baseRef = api.agents.ref.bind(api.agents);
  api.agents.ref = (id: string) => ({
    ...baseRef(id),
    refresh: async () => (agents.has(id) ? { agent: agents.get(id) } : await (baseRef(id).refresh as () => Promise<unknown>)()),
    send: async (text: string) => void sent.push({ agentId: id, text }),
  });
  const baseWorkspace = (api.workspaces.ref as (id: string) => Record<string, unknown>).bind(api.workspaces);
  api.workspaces.ref = (id: string) => ({
    ...baseWorkspace(id),
    agents: {
      create: async (o: { agentId: string }) => {
        agents.set(o.agentId, { id: o.agentId, workspaceId: id, archivedAt: null });
        return { id: o.agentId };
      },
    },
  });
  let now = Date.now();
  let prepared = 0;
  const automation = new AutomationService(x.store, {
    clock: () => now,
    globalModel: async () => ({ provider: "claude", model: "claude-haiku-4-5" }),
    prepare: async (taskId): Promise<ToolPreparation> => ({ agentId: `${taskId}-agent-${++prepared}`, contextFile: "/c", cliPath: "/cli", skillPath: "/s", instructions: "", mcp: { type: "http", url: "http://x", headers: {} } }),
  });
  automation.attach(x.paseo as PaseoApi);
  x.service.automation = automation;
  const stamp = () => new Date(now).toISOString();
  const record = (taskId: string, agentId: string, action: string) =>
    x.store.mutate((board) => {
      board.events.push({ id: `${action}-${now}-${agentId}`, taskId, actor: "system", action, agentId, outcome: action === "agent.turn_ended" ? "completed" : undefined, at: stamp() });
    });
  // The parent card itself runs under automation; its agent is the fixture's "actor" session.
  await automation.queue("t");
  await x.store.mutate((board) => {
    const job = board.automation[0];
    Object.assign(job, { state: "working", implementerId: "actor", startedAt: stamp(), turnAt: stamp() });
  });
  // During its turn the parent creates a sub-card (queued because automation is on).
  now += 1000;
  await record("t", "actor", "agent.turn_started");
  const child = await x.service.createCard(x.identity, { ...(await x.request()), title: "Child" });
  expect(child.queued).toBe(true);
  now += 1000;
  await record("t", "actor", "agent.turn_ended");
  now += 1000;
  await automation.turnEnded("actor");
  let board = await x.store.read();
  expect(board.automation.find((j) => j.taskId === "t")).toMatchObject({ state: "waiting", code: "sub_cards" });
  // The waiting parent holds no slot: with one slot, the child starts.
  await automation.kick();
  board = await x.store.read();
  const childJob = board.automation.find((j) => j.taskId === child.cardId)!;
  expect(childJob.state).toBe("working");
  expect(sent).toHaveLength(0);
  // The child delivers: nothing moves any more, so the parent wakes with the children's state.
  await x.store.mutate((b) => {
    b.tasks.find((t) => t.id === child.cardId)!.status = "in_review";
  });
  now += 1000;
  await record(child.cardId, childJob.implementerId!, "agent.turn_ended");
  now += 1000;
  await automation.turnEnded(childJob.implementerId!);
  await automation.kick();
  board = await x.store.read();
  expect(board.automation.find((j) => j.taskId === "t")).toMatchObject({ state: "working" });
  expect(sent.at(-1)).toMatchObject({ agentId: "actor", text: expect.stringMatching(/sub-cards changed[\s\S]*Child \(.+\): In review; automation delivered/) });
  // Waking once per change: another pass sends nothing new.
  await automation.kick();
  expect(sent.filter((m) => m.agentId === "actor")).toHaveLength(1);
});
