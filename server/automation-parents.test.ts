import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures } from "./automation-fixture";
import type { AutomationSettings } from "../shared/automation";
import type { Link, Task } from "../shared/model";

// SUB-CARDS-SPEC §5/§8, AUTOMATION-SPEC §10: a supervised parent waits for its sub-cards and wakes once they settle.
afterEach(cleanupAutomationFixtures);

const link = (kind: Link["kind"], from: string, to: string): Link => ({ id: `${kind}-${from}-${to}`, projectId: "p", kind, from, to, createdBy: "human", createdAt: "2026-10-22T00:00:00.000Z" });

/** Card a runs under automation and hands its work to sub-card b; a's turn ends and it waits. */
async function family(settings: Partial<AutomationSettings> = {}, before?: (x: Awaited<ReturnType<typeof setup>>) => void) {
  const x = await setup({ enabled: true, ...settings });
  await x.store.mutate((board) => void board.links.push(link("subtask", "b", "a")));
  before?.(x);
  await x.automation.queue("a");
  await x.automation.kick();
  const parent = x.created[0].agentId;
  await x.automation.queue("b");
  await x.automation.kick();
  await x.turn(parent, "a");
  expect(await x.job("a")).toMatchObject({ state: "waiting", code: "sub_cards" });
  const toParent = () => x.sent.filter((s) => s.agentId === parent);
  return { x, parent, toParent };
}

test("a sub-card asking a person keeps its parent waiting; the parent wakes once when that sub-card delivers", async () => {
  const { x, toParent } = await family();
  const child = x.created.find((c) => c.workspaceId === "w-b")!.agentId;
  await x.startTurn(child, "b");
  await x.record("b", { actor: "agent", action: "progress_reported", agentId: child, reportKind: "question", note: "Which endpoint?" });
  await x.endTurn(child, "b");
  await x.automation.kick();
  expect(await x.job("b")).toMatchObject({ state: "needs_human", code: "question" });
  expect((await x.job("a")).state).toBe("waiting");
  expect(toParent()).toHaveLength(0);
  // The person answers the sub-card and it delivers.
  await x.startTurn(child, "b");
  await x.deliver(child, "b");
  await x.endTurn(child, "b");
  await x.automation.kick();
  expect((await x.job("b")).state).toBe("delivered");
  expect((await x.job("a")).state).toBe("working");
  expect(toParent()).toEqual([expect.objectContaining({ text: expect.stringMatching(/sub-cards changed[\s\S]*Card b \(b\): In review; automation delivered/) })]);
  await x.automation.kick();
  expect(toParent()).toHaveLength(1);
});

test("a sub-card whose workspace is gone settles as failed, so its waiting parent wakes and hears why", async () => {
  // One slot: the parent holds it, so the sub-card is dispatched only once the parent waits.
  const x = await setup({ enabled: true, maxRunning: 1 });
  await x.store.mutate((board) => void board.links.push(link("subtask", "b", "a")));
  x.hooks.workspace = (id) => (id === "w-b" ? null : undefined);
  await x.automation.queue("a");
  await x.automation.kick();
  const parent = x.created[0].agentId;
  await x.automation.queue("b");
  await x.automation.kick();
  expect((await x.job("b")).state).toBe("queued");
  // The parent's silent turn end waits for b, which frees the slot; b's dispatch finds no workspace.
  await x.turn(parent, "a");
  expect((await x.store.read()).events.some((e) => e.taskId === "a" && e.action === "automation_waiting")).toBe(true);
  expect(await x.job("b")).toMatchObject({ state: "failed", code: "workspace_unavailable" });
  expect((await x.job("a")).state).toBe("working");
  expect(x.sent.filter((s) => s.agentId === parent)).toEqual([expect.objectContaining({ text: expect.stringMatching(/Card b \(b\): Todo; automation failed \(workspace_unavailable\)/) })]);
});

test("a parent whose sub-cards settled waits for a free slot before it wakes", async () => {
  const { x, toParent } = await family({ maxRunning: 1 });
  const child = x.created.find((c) => c.workspaceId === "w-b")!.agentId;
  // Another card takes the only slot while the sub-card works.
  await x.store.mutate((board) => {
    board.tasks.push({ ...(board.tasks[0] as Task), id: "c", workspaceId: "w-c", operationId: "create-c", status: "development" });
    board.automation.push({ taskId: "c", projectId: "p", state: "working", role: "implementer", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: x.at(), updatedAt: x.at() });
  });
  await x.deliver(child, "b");
  await x.turn(child, "b");
  expect((await x.job("b")).state).toBe("delivered");
  expect((await x.job("a")).state).toBe("waiting");
  expect(toParent()).toHaveLength(0);
  await x.store.mutate((board) => void (board.automation.find((j) => j.taskId === "c")!.state = "delivered"));
  await x.automation.kick();
  expect((await x.job("a")).state).toBe("working");
  expect(toParent()).toHaveLength(1);
});

test.each([
  ["cancelled", (t: Task): void => { t.status = "cancelled"; }],
  ["archived", (t: Task): void => { t.archivedAt = "2026-10-22T00:00:00.000Z"; }],
] as const)("a sub-card's queued sub-card stops when its parent is %s, without moving it or starting a session", async (_, end) => {
  const x = await setup({ enabled: true });
  await x.store.mutate((board) => {
    const base = board.tasks[0] as Task;
    board.tasks.push({ ...base, id: "grand", workspaceId: "w-grand", operationId: "create-grand" }, { ...base, id: "x", workspaceId: "w-x", operationId: "create-x", status: "development" });
    // a > b > grand; grand waits for x, which a person works on.
    board.links.push(link("subtask", "b", "a"), link("subtask", "grand", "b"), link("blocks", "x", "grand"));
  });
  await x.automation.queue("grand");
  await x.automation.kick();
  expect((await x.job("grand")).state).toBe("queued");
  await x.store.mutate((board) => end(board.tasks.find((t) => t.id === "b")!));
  await x.automation.kick();
  expect(await x.job("grand")).toMatchObject({ state: "stopped", code: "ancestor_finished" });
  expect((await x.store.read()).events.filter((e) => e.taskId === "grand" && e.action === "automation_stopped")).toEqual([
    expect.objectContaining({ actor: "system", note: "An ancestor card was cancelled, archived or removed" }),
  ]);
  await x.store.mutate((board) => void (board.tasks.find((t) => t.id === "x")!.status = "done"));
  await x.automation.kick();
  expect(x.created).toHaveLength(0);
  expect((await x.task("grand")).status).toBe("todo");
  expect((await x.store.read()).events.filter((e) => e.taskId === "grand" && e.action === "automation_stopped")).toHaveLength(1);
});
