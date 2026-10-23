import { afterEach, expect, test, vi } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures } from "./automation-fixture";
import { defaultGit, readHead } from "./workpad";

vi.mock("./workpad", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workpad")>()),
  readHead: vi.fn(async () => ({ sha: "abcdef123456", branch: "sw/full-handoff", dirty: false, at: new Date().toISOString() })),
  defaultGit: vi.fn(async () => "sw/parent-live\n"),
}));

afterEach(async () => {
  await cleanupAutomationFixtures();
  vi.clearAllMocks();
});

test.each([true, false])("dependency starts read the live parent's integration branch without git status (stored: %s)", async (stored) => {
  const x = await setup({ enabled: true });
  await x.store.mutate((board) => {
    board.tasks.push({ ...board.tasks[0], id: "parent", title: "Parent card", workspaceId: "w-parent", operationId: "create-parent", status: "development" });
    board.tasks.find((t) => t.id === "b")!.status = "done";
    for (const [kind, from, to] of [["subtask", "a", "parent"], ["subtask", "b", "parent"], ["blocks", "b", "a"]] as const)
      board.links.push({ id: `${from}-${kind}-${to}`, projectId: "p", kind, from, to, createdBy: "human", createdAt: x.at() });
    if (stored) board.workpads.push({
      taskId: "parent", projectId: "p", revision: 1, acceptance: [], validation: [], confusions: [],
      head: { sha: "abcdef123456", branch: "sw/parent-stored", dirty: true, at: x.at() }, env: null, updatedAt: x.at(), updatedBy: "agent",
    });
  });
  await x.automation.queue("a");
  await x.automation.kick();
  const prompt = x.created[0].prompt;
  expect(prompt).toContain(`"branch":"${stored ? "sw/parent-stored" : "sw/parent-live"}"`);
  expect(prompt).toMatch(/Parent integration branch[^\n]*"directory":"[^\n]*w-parent"/);
  expect(vi.mocked(readHead).mock.calls.some(([directory]) => directory.endsWith("w-parent"))).toBe(false);
  expect(vi.mocked(defaultGit).mock.calls).toEqual(stored ? [] : [[expect.stringMatching(/w-parent$/), ["rev-parse", "--abbrev-ref", "HEAD"]]]);
  expect(vi.mocked(readHead).mock.calls.some(([directory]) => directory.endsWith("w-b"))).toBe(true);
});
