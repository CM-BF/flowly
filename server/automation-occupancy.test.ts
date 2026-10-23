import { afterEach, expect, test } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationFixture as setup, cleanupAutomationFixtures } from "./automation-fixture";
import type { AutomationJob } from "../shared/automation";

// AUTOMATION-SPEC §10: one worker per physical directory, and a card whose own workspace is gone.
afterEach(cleanupAutomationFixtures);

// One physical checkout behind every workspace (it need not exist: the directory is compared, never entered).
const shared = { workspaceDirectory: join(tmpdir(), "flowly-occupancy-shared-root") };

test("two cards whose workspaces are one directory never run at once; the second starts when the first settles", async () => {
  const x = await setup({ enabled: true, maxRunning: 2 });
  x.hooks.workspace = () => shared;
  await x.automation.queue("a");
  await x.automation.queue("b");
  await x.automation.kick();
  expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a"]);
  expect((await x.job("b")).state).toBe("queued");
  const impl = x.created[0].agentId;
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  expect((await x.job("a")).state).toBe("delivered");
  await x.automation.kick();
  expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a", "w-b"]);
});

test("a stopped job whose session still runs in the shared directory holds it until that session goes idle", async () => {
  const x = await setup({ enabled: true, maxRunning: 2 });
  x.hooks.workspace = () => shared;
  await x.automation.queue("a");
  await x.automation.kick();
  await x.automation.stopJob("a");
  await x.automation.queue("b");
  await x.automation.kick();
  expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a"]);
  x.agents.get(x.created[0].agentId)!.status = "idle";
  await x.automation.kick();
  expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a", "w-b"]);
});

test("a card held back by the directory does not probe the sessions of finished cards on every pass", async () => {
  const x = await setup({ enabled: true, maxRunning: 5 });
  x.hooks.workspace = () => shared;
  const old = Array.from({ length: 40 }, (_, i) => `h${i}`);
  await x.store.mutate((board) => {
    for (const id of old) {
      board.tasks.push({ ...board.tasks[0], id, workspaceId: `w-${id}`, operationId: `create-${id}`, status: "done" });
      const job: AutomationJob = { taskId: id, projectId: "p", state: "stopped", code: "card_finished", role: "implementer", implementerId: `${id}-agent`, generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: x.at(), updatedAt: x.at() };
      board.automation.push(job);
      x.agents.set(`${id}-agent`, { id: `${id}-agent`, workspaceId: `w-${id}`, archivedAt: null, status: "idle" });
    }
  });
  const probed: string[] = [];
  x.hooks.refresh = async (id) => void probed.push(id);
  await x.automation.queue("a");
  await x.automation.kick();
  await x.automation.queue("b");
  await x.automation.kick();
  await x.automation.kick();
  expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a"]);
  expect((await x.job("b")).state).toBe("queued");
  expect(probed.filter((id) => /^h\d+-agent$/.test(id))).toEqual([]);
});

test.each([
  ["missing", null],
  ["being archived", { ...shared, archivingAt: "2026-10-22T00:00:00.000Z" }],
] as const)("a queued card whose workspace is %s settles with a reason instead of waiting forever", async (_, snapshot) => {
  const x = await setup({ enabled: true });
  x.hooks.workspace = (id) => (id === "w-a" ? snapshot : undefined);
  await x.automation.queue("a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "failed", code: "session_unavailable", detail: expect.stringMatching(/workspace is archived or no longer exists/) });
  expect(x.created).toHaveLength(0);
  const board = await x.store.read();
  expect(board.events.filter((e) => e.taskId === "a" && e.action === "automation_failed").map((e) => e.note)).toEqual([expect.stringMatching(/workspace is archived or no longer exists/)]);
  expect(board.tasks.find((t) => t.id === "a")!.status).toBe("todo");
});

test("a workspace refresh that fails is unknown, not a missing workspace: the card stays queued and starts later", async () => {
  const x = await setup({ enabled: true });
  x.hooks.workspace = (id) => {
    if (id === "w-a") throw new Error("request timed out");
    return undefined;
  };
  await x.automation.queue("a");
  await x.automation.kick();
  expect((await x.job("a")).state).toBe("queued");
  expect(x.created).toHaveLength(0);
  x.hooks.workspace = undefined;
  await x.automation.kick();
  expect(x.created.map((c) => c.workspaceId)).toEqual(["w-a"]);
});
