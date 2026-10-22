import { afterEach, expect, test, vi } from "vitest";
import { rm } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { agentFixture } from "./agent-fixture";
import { BoardService } from "./service";
import { AutomationService } from "./automation";
import { linkLimits, type Task } from "../shared/model";
import type { AutomationJob } from "../shared/automation";

const roots: string[] = [];
const automations: AutomationService[] = [];
afterEach(async () => {
  await Promise.all(automations.splice(0).map((service) => service.stop()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const fixture = await agentFixture();
  roots.push(fixture.root);
  let workspaceCount = 0;
  const create = vi.fn(async () => ({ id: `draft-workspace-${++workspaceCount}` }));
  (fixture.paseo as unknown as { workspaces: { create: typeof create } }).workspaces.create = create;
  const boards = new BoardService(fixture.store);
  fixture.service.createTask = (input, paseo, agent) => { boards.automation = fixture.service.automation; return boards.createTask(input, paseo, agent); };
  const onStatusChange = vi.fn();
  fixture.service.onStatusChange = onStatusChange;
  const request = async () => {
    const context = await fixture.service.get(fixture.identity);
    return { expectedRevision: context.revision, request: context.request };
  };
  const child = async (status: Task["status"] = "backlog") => {
    await fixture.store.mutate((board) => {
      board.tasks.push({ ...board.tasks[0], id: "child", title: "Child", workspaceId: "child-workspace", operationId: "child-operation", status });
      board.links.push({ id: "parent-link", kind: "subtask", projectId: "p", from: "child", to: "t", createdBy: "human", createdAt: new Date().toISOString() });
    });
    return "child";
  };
  return { ...fixture, create, request, child, onStatusChange };
}

test.each(["task", "project"] as const)("create refuses a stale signed %s revision before provisioning", async (changed) => {
  const x = await setup();
  const signed = await x.request();
  await x.store.mutate((board) => { if (changed === "task") board.tasks[0].revision++; else board.projects[0].revision++; });
  await expect(x.service.createCard(x.identity, { ...signed, title: "Stale decision" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(x.create).not.toHaveBeenCalled();
  expect((await x.store.read()).tasks).toHaveLength(1);
});

test.each(["task", "project"] as const)("update refuses a stale signed %s revision without moving its child", async (changed) => {
  const x = await setup();
  const cardId = await x.child("in_review");
  const signed = await x.request();
  await x.store.mutate((board) => { if (changed === "task") board.tasks[0].revision++; else board.projects[0].revision++; });
  const before = await x.store.read();
  await expect(x.service.updateCard(x.identity, { ...signed, cardId, action: "accept" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(await x.store.read()).toEqual(before);
  expect(x.onStatusChange).not.toHaveBeenCalled();
});

test.each(["done", "cancelled"] as const)("a %s parent cannot create cards or accept children", async (status) => {
  const x = await setup();
  const cardId = await x.child("in_review");
  await x.store.mutate((board) => { board.tasks[0].status = status; board.tasks[0].revision++; });
  const before = await x.store.read();
  await expect(x.service.createCard(x.identity, { ...(await x.request()), title: "Forbidden" })).rejects.toMatchObject({ code: "TASK_FINISHED" });
  await expect(x.service.updateCard(x.identity, { ...(await x.request()), cardId, action: "accept" })).rejects.toMatchObject({ code: "TASK_FINISHED" });
  expect(await x.store.read()).toEqual(before);
  expect(x.create).not.toHaveBeenCalled();
  expect(x.onStatusChange).not.toHaveBeenCalled();
});

test.each(["parent", "project"] as const)("an archived %s cannot create or manage a child", async (archived) => {
  const x = await setup();
  const cardId = await x.child("in_review");
  await x.store.mutate((board) => { if (archived === "parent") board.tasks[0].archivedAt = new Date().toISOString(); else board.projects[0].archivedAt = new Date().toISOString(); });
  const before = await x.store.read();
  await expect(x.service.createCard(x.identity, { ...(await x.request()), title: "Forbidden" })).rejects.toMatchObject({ code: "ARCHIVED" });
  await expect(x.service.updateCard(x.identity, { ...(await x.request()), cardId, action: "accept" })).rejects.toMatchObject({ code: "ARCHIVED" });
  expect(await x.store.read()).toEqual(before);
  expect(x.create).not.toHaveBeenCalled();
});

const job = (taskId: string, extra: Partial<AutomationJob> = {}): AutomationJob => ({
  taskId, projectId: "p", role: "implementer", state: "queued", generation: 1,
  nudges: 0, failures: 0, reviewRounds: 0,
  queuedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra,
});

test("an automation reviewer cannot create or accept cards in the reviewed card's name", async () => {
  const x = await setup();
  const cardId = await x.child("in_review");
  await x.store.mutate((board) => {
    board.tasks[0].status = "in_review";
    board.automation.push(job("t", { state: "reviewing", role: "reviewer", implementerId: "implementation-session", reviewerId: "actor" }));
  });
  const before = await x.store.read();
  await expect(x.service.createCard(x.identity, { ...(await x.request()), title: "Reviewer work" })).rejects.toMatchObject({ code: "REVIEWER_ONLY" });
  await expect(x.service.updateCard(x.identity, { ...(await x.request()), cardId, action: "accept" })).rejects.toMatchObject({ code: "REVIEWER_ONLY" });
  expect(await x.store.read()).toEqual(before);
  expect(x.create).not.toHaveBeenCalled();
  expect(x.onStatusChange).not.toHaveBeenCalled();
});

test.each([
  { state: "stopped", code: "stopped" },
  { state: "stopped", code: "card_moved" },
  { state: "failed", code: "no_delivery" },
  { state: "failed", code: "failed" },
] as const)("the parent cannot restart a $state/$code child", async ({ state, code }) => {
  const x = await setup();
  const cardId = await x.child("backlog");
  await x.store.mutate((board) => {
    board.projects[0].automation = { enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 };
    board.automation.push(job(cardId, { state, code, implementerId: "child-session" }));
  });
  // A real AutomationService with no attached API cannot dispatch anything.
  const automation = new AutomationService(x.store, { prepare: async () => { throw new Error("must not prepare"); }, globalModel: async () => null });
  automations.push(automation);
  x.service.automation = automation;
  const before = await x.store.read();
  await expect(x.service.updateCard(x.identity, { ...(await x.request()), cardId, action: "start" })).rejects.toMatchObject({ code: state === "failed" ? "NEEDS_PERSON" : "TAKEN_BY_PERSON" });
  expect(await x.store.read()).toEqual(before);
  expect(x.onStatusChange).not.toHaveBeenCalled();
});

test("child ownership is checked in the committing transaction after a concurrent unlink", async () => {
  const x = await setup();
  const cardId = await x.child("in_review");
  const signed = await x.request();
  const transaction = x.store.transaction.bind(x.store);
  // Inject an actual committed unlink just before update's first transaction.
  // The generic cast is only a test seam; no source-reading or private-method patch.
  const original = x.store.transaction;
  let injected = false;
  (x.store as { transaction: (operation: any) => Promise<any> }).transaction = async (operation) => {
    if (!injected) {
      injected = true;
      await transaction((board) => {
        board.links = board.links.filter((link) => link.id !== "parent-link");
        return { value: undefined, changed: true };
      });
    }
    return transaction(operation);
  };
  try {
    await expect(x.service.updateCard(x.identity, { ...signed, cardId, action: "accept" })).rejects.toMatchObject({ code: "NOT_PARENT" });
  } finally { x.store.transaction = original; }
  const after = await x.store.read();
  expect(after.links).toEqual([]);
  expect(after.tasks.find((task) => task.id === cardId)?.status).toBe("in_review");
  expect(after.events.filter((event) => event.taskId === cardId && event.action === "status_changed")).toEqual([]);
  expect(x.onStatusChange).not.toHaveBeenCalled();
});

test("distinct concurrent creation requests cannot overshoot the creating card's 50-card quota", async () => {
  const x = await setup();
  await x.store.mutate((board) => {
    for (let index = 0; index < 49; index++) board.tasks.push({
      ...board.tasks[0], id: `prior-${index}`, workspaceId: `prior-workspace-${index}`, operationId: `prior-operation-${index}`,
      createdByAgent: { agentId: "actor", taskId: "t" },
    });
  });
  const first = await x.request(), second = await x.request();
  const results = await Promise.allSettled([
    x.service.createCard(x.identity, { ...first, title: "Last allowed", subCard: false }),
    x.service.createCard(x.identity, { ...second, title: "Over quota", subCard: false }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected).toMatchObject({ status: "rejected", reason: { code: "CARD_LIMIT" } });
  expect(x.create).toHaveBeenCalledTimes(1);
  expect((await x.store.read()).tasks.filter((task) => task.createdByAgent?.taskId === "t")).toHaveLength(50);
});

test.each(["parent", "blocker"] as const)("a full %s link budget rejects before workspace provisioning", async (full) => {
  const x = await setup();
  await x.store.mutate((board) => {
    const base = board.tasks[0];
    if (full === "blocker") board.tasks.push({ ...base, id: "full-blocker", workspaceId: "full-blocker-workspace", operationId: "full-blocker-operation" });
    const target = full === "parent" ? "t" : "full-blocker";
    for (let index = 0; index < linkLimits.perTask; index++) {
      const id = `peer-${index}`;
      board.tasks.push({ ...base, id, workspaceId: `${id}-workspace`, operationId: `${id}-operation` });
      board.links.push({ id: `${id}-link`, projectId: "p", kind: "related", from: target, to: id, createdBy: "human", createdAt: new Date().toISOString() });
    }
  });
  const before = await x.store.read();
  await expect(x.service.createCard(x.identity, {
    ...(await x.request()), title: "No orphan workspace", ...(full === "blocker" ? { subCard: false, blockedBy: ["full-blocker"] } : {}),
  })).rejects.toMatchObject({ code: "CARD_INVALID" });
  expect(x.create).not.toHaveBeenCalled();
  expect(await x.store.read()).toEqual(before);
});

test("a new sub-card cannot depend on its own parent before its workspace exists", async () => {
  const x = await setup();
  // Parent implicitly waits for sub-cards; child waiting on parent makes a mixed
  // subtask/blocks dependency cycle although neither edge kind cycles alone.
  const before = await x.store.read();
  await expect(x.service.createCard(x.identity, { ...(await x.request()), title: "Deadlocked child", blockedBy: ["t"] })).rejects.toMatchObject({ code: "CARD_INVALID" });
  expect(x.create).not.toHaveBeenCalled();
  expect(await x.store.read()).toEqual(before);
});

test("a replayed cancellation cannot cancel work a person reopened afterward", async () => {
  const x = await setup();
  const cardId = await x.child("in_review");
  const input = { ...(await x.request()), cardId, action: "cancel" as const };
  await x.service.updateCard(x.identity, input);
  await x.store.mutate((board) => { const child = board.tasks.find((task) => task.id === cardId)!; child.status = "development"; child.revision++; });
  const before = await x.store.read();
  expect(await x.service.updateCard(x.identity, input)).toMatchObject({ replayed: true });
  expect(await x.store.read()).toEqual(before);
  expect(x.onStatusChange).toHaveBeenCalledTimes(1);
});


test("separate-card chains share a lineage budget even when each creator is below its own cap", async () => {
  const x = await setup();
  await x.store.mutate((board) => {
    for (let i = 0; i < 99; i++) board.tasks.push({ ...board.tasks[0], id: `lineage-${i}`, operationId: `lineage-op-${i}`, workspaceId: `lineage-ws-${i}`, createdByAgent: { agentId: "other", taskId: i ? `lineage-${i - 1}` : "t" } });
  });
  await x.service.createCard(x.identity, { ...(await x.request()), title: "Hundredth", subCard: false });
  await expect(x.service.createCard(x.identity, { ...(await x.request()), title: "Over lineage", subCard: false })).rejects.toMatchObject({ code: "CARD_LIMIT" });
  expect(x.create).toHaveBeenCalledTimes(1);
});

test("one signed request cannot create a card and then write progress", async () => {
  const x = await setup();
  const signed = await x.request();
  await x.service.createCard(x.identity, { ...signed, title: "Child" });
  await expect(x.service.write(x.identity, "progress", { ...signed, note: "Another action", kind: "progress" })).rejects.toMatchObject({ code: "REQUEST_REUSED" });
});
