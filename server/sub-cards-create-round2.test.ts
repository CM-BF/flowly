import { afterEach, expect, test, vi } from "vitest";
import { rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { BoardService } from "./service";
import { AutomationService } from "./automation";
import { statuses, type Board } from "../shared/model";

const roots: string[] = [];
const automations: AutomationService[] = [];
afterEach(async () => {
  await Promise.all(automations.splice(0).map((service) => service.stop()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * agentFixture with BoardService creating the cards. The fake workspaces.create keeps
 * Paseo's idempotency: one workspace per idempotency key. `duringProvisioning` runs
 * inside the first create, standing in for a write that commits while the worktree is made.
 */
async function setup() {
  const fixture = await agentFixture();
  roots.push(fixture.root);
  const byKey = new Map<string, string>();
  let duringProvisioning: ((board: Board) => void) | undefined;
  const create = vi.fn(async (options: { idempotencyKey: string }) => {
    const hook = duringProvisioning;
    duringProvisioning = undefined;
    if (hook) await fixture.store.mutate(hook);
    if (!byKey.has(options.idempotencyKey)) byKey.set(options.idempotencyKey, `ws-${byKey.size + 1}`);
    return { id: byKey.get(options.idempotencyKey)! };
  });
  (fixture.paseo as unknown as { workspaces: { create: typeof create } }).workspaces.create = create;
  const boards = new BoardService(fixture.store);
  fixture.service.createTask = (input, paseo, agent) => {
    boards.automation = fixture.service.automation;
    return boards.createTask(input, paseo, agent);
  };
  const request = async () => {
    const context = await fixture.service.get(fixture.identity);
    return { expectedRevision: context.revision, request: context.request };
  };
  const automation = () => {
    // A real AutomationService with no attached API cannot dispatch anything.
    const service = new AutomationService(fixture.store, { prepare: async () => { throw new Error("must not prepare"); }, globalModel: async () => null });
    automations.push(service);
    fixture.service.automation = service;
    return service;
  };
  return {
    ...fixture, create, request, automation,
    during: (hook: (board: Board) => void) => { duringProvisioning = hook; },
    bound: async (workspaceId: string) => (await fixture.store.read()).tasks.filter((t) => t.workspaceId === workspaceId),
  };
}

const automationOn = { enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 };

test("a reserved creation can recover its workspace after the signed snapshot expires; a new stale request cannot", async () => {
  const x = await setup();
  const input = { ...(await x.request()), title: "Recover later" };
  x.during((board) => { board.tasks[0].status = "done"; });
  await expect(x.service.createCard(x.identity, input)).rejects.toMatchObject({ code: "TASK_FINISHED" });
  await x.store.mutate((board) => { board.tasks[0].status = "development"; });
  const unreserved = { ...(await x.request()), title: "Stale new decision" };
  x.advance(16 * 60_000);
  const recovered = await x.service.createCard(x.identity, input);
  expect(await x.bound("ws-1")).toMatchObject([{ id: recovered.cardId }]);
  expect(new Set(x.create.mock.calls.map(([options]) => options.idempotencyKey)).size).toBe(1);
  await expect(x.service.createCard(x.identity, unreserved)).rejects.toMatchObject({ code: "REQUEST_EXPIRED" });
  expect(x.create).toHaveBeenCalledTimes(2);
});

test.each(["task", "project"] as const)("a %s revision bump while the workspace is made does not orphan it: the card is saved on it", async (changed) => {
  const x = await setup();
  const signed = await x.request();
  x.during((board) => { if (changed === "task") board.tasks[0].revision++; else board.projects[0].revision++; });
  const result = await x.service.createCard(x.identity, { ...signed, title: "Sub" });
  expect(x.create).toHaveBeenCalledTimes(1);
  expect(await x.bound("ws-1")).toMatchObject([{ id: result.cardId, title: "Sub" }]);
});

test.each([
  { name: "the parent is archived", code: "ARCHIVED", block: (b: Board) => { b.tasks[0].archivedAt = new Date().toISOString(); }, clear: (b: Board) => { b.tasks[0].archivedAt = null; } },
  { name: "the parent is finished", code: "TASK_FINISHED", block: (b: Board) => { b.tasks[0].status = "done"; b.tasks[0].revision++; }, clear: (b: Board) => { b.tasks[0].status = "development"; b.tasks[0].revision++; } },
])("a refusal after provisioning ($name) names the workspace, and a same-request retry reports it, then reuses it", async ({ code, block, clear }) => {
  const x = await setup();
  const input = { ...(await x.request()), title: "Sub" };
  x.during(block);
  const first = await x.service.createCard(x.identity, input).catch((e) => e);
  expect(first).toMatchObject({ code, message: expect.stringContaining("ws-1") });
  expect(await x.bound("ws-1")).toEqual([]);
  // Still refused: the retry is refused before provisioning and still reports the workspace.
  await expect(x.service.createCard(x.identity, input)).rejects.toMatchObject({ code, message: expect.stringContaining("ws-1") });
  expect(x.create).toHaveBeenCalledTimes(1);
  // A person clears it; the same request now saves the card on the same workspace instead of making a second one.
  await x.store.mutate(clear);
  const created = await x.service.createCard(x.identity, input);
  expect(await x.bound("ws-1")).toMatchObject([{ id: created.cardId }]);
  expect(new Set(x.create.mock.calls.map(([options]) => options.idempotencyKey)).size).toBe(1);
  expect((await x.store.read()).tasks.filter((t) => t.title === "Sub")).toHaveLength(1);
});

test("a blocker archived while the workspace is made: CARD_INVALID names the workspace, and so does every retry", async () => {
  const x = await setup();
  await x.store.mutate((board) => { board.tasks.push({ ...board.tasks[0], id: "blocker", title: "Blocker", workspaceId: "blocker-ws", operationId: "blocker-op" }); });
  const input = { ...(await x.request()), title: "Sub", blockedBy: ["blocker"] };
  x.during((board) => { board.tasks.find((t) => t.id === "blocker")!.archivedAt = new Date().toISOString(); });
  await expect(x.service.createCard(x.identity, input)).rejects.toMatchObject({ code: "CARD_INVALID", message: expect.stringContaining("ws-1") });
  await expect(x.service.createCard(x.identity, input)).rejects.toMatchObject({ code: "CARD_INVALID", message: expect.stringContaining("ws-1") });
  expect(x.create).toHaveBeenCalledTimes(1);
  expect(await x.bound("ws-1")).toEqual([]);
});

test("a card deleted after its request committed is not created again by a retry of that request", async () => {
  const x = await setup();
  const input = { ...(await x.request()), title: "Sub" };
  const created = await x.service.createCard(x.identity, input);
  await x.store.mutate((board) => {
    board.tasks = board.tasks.filter((t) => t.id !== created.cardId);
    board.links = board.links.filter((l) => l.from !== created.cardId && l.to !== created.cardId);
  });
  await expect(x.service.createCard(x.identity, input)).rejects.toMatchObject({ code: "REQUEST_REUSED" });
  expect(x.create).toHaveBeenCalledTimes(1);
  expect((await x.store.read()).tasks).toHaveLength(1);
});

/** t (the caller) is a sub-card of m, which is a sub-card of root g. */
async function grandchild(x: Awaited<ReturnType<typeof setup>>, root: "cancelled" | "archived" | "done" | "live") {
  await x.store.mutate((board) => {
    const base = board.tasks[0];
    const stamp = new Date().toISOString();
    board.tasks.push({ ...base, id: "g", title: "Root", workspaceId: "g-ws", operationId: "g-op", status: root === "cancelled" ? "cancelled" : root === "done" ? "done" : "development", archivedAt: root === "archived" ? stamp : null });
    board.tasks.push({ ...base, id: "m", title: "Middle", workspaceId: "m-ws", operationId: "m-op", status: "development" });
    board.links.push({ id: "m-g", kind: "subtask", projectId: "p", from: "m", to: "g", createdBy: "human", createdAt: stamp });
    board.links.push({ id: "t-m", kind: "subtask", projectId: "p", from: "t", to: "m", createdBy: "human", createdAt: stamp });
    board.projects[0].automation = automationOn;
  });
}

test.each([
  { root: "cancelled", subCard: false },
  { root: "cancelled", subCard: true },
  { root: "archived", subCard: false },
  { root: "archived", subCard: true },
] as const)("a card under a $root ancestor cannot create cards (subCard=$subCard)", async ({ root, subCard }) => {
  const x = await setup();
  x.automation();
  await grandchild(x, root);
  const before = await x.store.read();
  await expect(x.service.createCard(x.identity, { ...(await x.request()), title: "Abandoned work", subCard, start: "now" })).rejects.toMatchObject({ code: "ANCESTOR_FINISHED", message: expect.stringContaining("Root") });
  expect(x.create).not.toHaveBeenCalled();
  const after = await x.store.read();
  expect(after.tasks).toEqual(before.tasks);
  expect(after.automation).toEqual([]);
});

test("an ancestor cancelled while the workspace is made refuses the commit and names the workspace", async () => {
  const x = await setup();
  await grandchild(x, "live");
  const input = { ...(await x.request()), title: "Late", subCard: false };
  x.during((board) => { board.tasks.find((t) => t.id === "g")!.status = "cancelled"; });
  await expect(x.service.createCard(x.identity, input)).rejects.toMatchObject({ code: "ANCESTOR_FINISHED", message: expect.stringContaining("ws-1") });
  expect(await x.bound("ws-1")).toEqual([]);
});

test("a card under a Done or live ancestor still creates cards", async () => {
  const x = await setup();
  await grandchild(x, "done");
  await expect(x.service.createCard(x.identity, { ...(await x.request()), title: "Follow-up", subCard: false, start: "later" })).resolves.toMatchObject({ status: "backlog" });
});

test("with automation on and no In review lane, start=now is refused before any workspace exists; start=later still works", async () => {
  const x = await setup();
  x.automation();
  // A configuration saved before projects refused this combination.
  await x.store.mutate((board) => {
    board.projects[0].automation = automationOn;
    board.projects[0].lanes = statuses.map((status) => ({ status, enabled: status !== "in_review" }));
  });
  const before = await x.store.read();
  await expect(x.service.createCard(x.identity, { ...(await x.request()), title: "Never deliverable" })).rejects.toMatchObject({
    code: "STATUS_UNAVAILABLE",
    message: expect.stringMatching(/In review lane/),
  });
  expect(x.create).not.toHaveBeenCalled();
  const after = await x.store.read();
  expect(after.tasks).toEqual(before.tasks);
  expect(after.automation).toEqual([]);
  await expect(x.service.createCard(x.identity, { ...(await x.request()), title: "Parked", start: "later" })).resolves.toMatchObject({ status: "backlog", queued: false });
  expect(x.create).toHaveBeenCalledTimes(1);
});

test("a parked separate card is not offered to flowly_update_card, which only manages direct sub-cards", async () => {
  const x = await setup();
  const separate = await x.service.createCard(x.identity, { ...(await x.request()), title: "Separate later", subCard: false, start: "later" });
  expect(separate.message).not.toMatch(/flowly_update_card/);
  expect(separate.message).toMatch(/person/);
  const sub = await x.service.createCard(x.identity, { ...(await x.request()), title: "Sub later", subCard: true, start: "later" });
  expect(sub.message).toMatch(/flowly_update_card action=start/);
});
