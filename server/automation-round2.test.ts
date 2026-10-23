import { afterEach, expect, test, vi } from "vitest";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { automationFixture as setup, cleanupAutomationFixtures, underReview } from "./automation-fixture";
import { agentFixture } from "./agent-fixture";
import { projectLanes } from "../shared/lanes";
import { blockedThisTurn } from "../shared/automation";
import type { Link } from "../shared/model";

// Guards for automation fixes that no other test fails without (AUTOMATION-SPEC §4, §10; SUB-CARDS-SPEC §8).
const agentRoots: string[] = [];
afterEach(async () => {
  await cleanupAutomationFixtures();
  await Promise.all(agentRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const link = (kind: Link["kind"], from: string, to: string): Link => ({ id: `${from}-${kind}-${to}`, projectId: "p", kind, from, to, createdBy: "human", createdAt: new Date().toISOString() });

test("automation needs the In review lane: queueing a card and saving such settings are refused", async () => {
  const x = await setup({ enabled: true });
  const withoutReview = projectLanes(null).map((lane) => ({ ...lane, enabled: lane.status !== "in_review" }));
  const project = (await x.store.read()).projects[0];
  await expect(x.store.updateProject({ id: "p", revision: project.revision, lanes: withoutReview })).rejects.toThrow(/requires the In review lane/);
  await expect(x.store.updateProject({ id: "p", revision: project.revision, lanes: withoutReview, automation: { enabled: false, maxRunning: 2, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 } })).resolves.toMatchObject({ automation: { enabled: false } });
  // An older configuration saved with automation on and the lane off.
  await x.store.mutate((board) => void (board.projects[0].automation!.enabled = true));
  await expect(x.automation.queue("a")).rejects.toThrow(/requires the In review lane/);
  expect((await x.store.read()).automation).toEqual([]);
  expect((await x.store.read()).events.filter((e) => e.action === "automation_queued")).toHaveLength(0);
});

test("a parent's note reaches the sub-card's implementer in its start instruction", async () => {
  const x = await setup({ enabled: true });
  await x.automation.queue("a", { agentId: "parent-session" }, "Handle the empty input case");
  await x.automation.kick();
  expect(x.created).toHaveLength(1);
  expect(x.created[0].prompt).toMatch(/started this session[\s\S]*Handle the empty input case/);
});

test("a card whose blockers are Done starts with their handoffs", async () => {
  const x = await setup({ enabled: true });
  await x.store.mutate((board) => {
    board.tasks.find((t) => t.id === "b")!.status = "done";
    board.links.push(link("blocks", "b", "a"));
  });
  await x.automation.queue("a");
  await x.automation.kick();
  expect(x.created[0].prompt).toMatch(/Dependency handoffs \(card data\):\n\[\{"id":"b","title":"Card b"/);
  expect(x.created[0].prompt).toContain("w-b");
  // A top-level card has no parent branch to name.
  expect(x.created[0].prompt).not.toMatch(/Parent integration branch/);
});

test("a sub-card whose sibling blockers are Done also hears where its parent integrates them", async () => {
  const x = await setup({ enabled: true });
  await x.store.mutate((board) => {
    board.tasks.push({ ...board.tasks[0], id: "parent", title: "Parent card", workspaceId: "w-parent", operationId: "create-parent", status: "development" });
    board.tasks.find((t) => t.id === "b")!.status = "done";
    board.links.push(link("subtask", "a", "parent"), link("subtask", "b", "parent"), link("blocks", "b", "a"));
  });
  await x.automation.queue("a");
  await x.automation.kick();
  const prompt = x.created[0].prompt;
  expect(prompt).toMatch(/Dependency handoffs \(card data\)/);
  expect(prompt).toMatch(/Parent integration branch \(card data\): \{"id":"parent","title":"Parent card","lane":"[^"]+","directory":"[^"]*w-parent"\}/);
  expect(prompt).toMatch(/prefer merging it/);
});

test("Stop frees the slot: the next queued card starts without another dispatcher pass", async () => {
  const x = await setup({ enabled: true, maxRunning: 1 });
  await x.automation.queue("a");
  await x.automation.kick();
  await x.automation.queue("b");
  await x.automation.kick();
  expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a"]);
  await x.automation.stopJob("a");
  await vi.waitFor(() => expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a", "w-b"]));
});

test("an approval frees the reviewer's slot: the next queued card starts without another dispatcher pass", async () => {
  const { x, rev } = await underReview({ maxRunning: 1 });
  await x.automation.queue("b");
  await x.automation.kick();
  expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a", "w-a"]);
  await x.automation.submitReview({ agentId: rev, taskId: "a", workspaceId: "w-a" }, { verdict: "approve", summary: "Checked" });
  await vi.waitFor(() => expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a", "w-a", "w-b"]));
});

test("Stop, then Run again while the old preparation is suspended, creates exactly one session, for the new run", async () => {
  const x = await setup();
  let release!: () => void;
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ops: string[] = [];
  x.hooks.prepare = async (_, op) => {
    ops.push(op);
    if (ops.length === 1) { entered(); await gate; }
  };
  await x.automation.queue("a");
  await preparing;
  await x.automation.stopJob("a");
  await x.automation.queue("a");
  release();
  await vi.waitFor(() => expect(x.created).toHaveLength(1));
  await x.automation.kick();
  expect(x.created).toHaveLength(1);
  expect(ops).toHaveLength(2);
  expect(ops[1]).toMatch(/^automation:a:2:implementer:/);
  expect(x.created[0].agentId).toBe(x.preparedFor(ops[1]));
  expect(await x.job("a")).toMatchObject({ generation: 2, state: "working", implementerId: x.created[0].agentId });
});

test("setting Blocked again on a Blocked card is the agent's own blocker for automation", async () => {
  const x = await agentFixture();
  agentRoots.push(x.root);
  await x.store.mutate((board) => {
    board.tasks[0].status = "blocked";
    board.events.push({ id: randomUUID(), taskId: "t", actor: "system", action: "agent.turn_started", agentId: "actor", at: new Date().toISOString() });
  });
  const context = await x.service.get(x.identity);
  await x.service.write(x.identity, "status", { expectedRevision: context.revision, request: context.request, status: "blocked", note: "Still waiting for the API key" });
  expect(blockedThisTurn(await x.store.read(), "t", "actor")).toBe(true);
});
