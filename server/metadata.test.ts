import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const f = await agentFixture(); roots.push(f.root);
  await f.store.mutate((b) => { b.tasks[0].brief = "Fix foo.ts. Keep the API. Test Chinese input."; });
  return f;
}
test("agent organizes metadata atomically, keeps original input, and replays once", async () => {
  const f = await fixture();
  const before = await f.service.get(f.identity);
  const input = { expectedRevision: before.revision, request: before.request, title: "Fix Chinese input", description: before.task.brief, priority: "high" };
  const result = await f.service.write(f.identity, "metadata", input);
  expect((await f.service.write(f.identity, "metadata", input)).replayed).toBe(true);
  const board = await f.store.read();
  expect(board.tasks[0]).toMatchObject({ title: input.title, description: input.description, priority: "high", brief: input.description, revision: 2 });
  expect(board.events.filter((e) => e.action === "edited")).toHaveLength(1);
  expect(result.receipt.action).toBe("metadata");
  await expect(f.service.write(f.identity, "metadata", { ...input, title: "Different" })).rejects.toMatchObject({ code: "REQUEST_REUSED" });
});
test("metadata respects human revisions, finished state, and reviewer role", async () => {
  const f = await fixture();
  const before = await f.service.get(f.identity);
  await f.store.mutate((b) => { b.tasks[0].title = "Person edited"; b.tasks[0].revision++; });
  await expect(f.service.write(f.identity, "metadata", { expectedRevision: before.revision, request: before.request, title: "Stale" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  const current = await f.service.get(f.identity);
  await f.store.mutate((b) => { b.tasks[0].status = "done"; });
  await expect(f.service.write(f.identity, "metadata", { expectedRevision: current.revision, request: current.request, title: "Finished" })).rejects.toMatchObject({ code: "TASK_FINISHED" });
  await f.store.mutate((b) => { b.tasks[0].status = "in_review"; b.automation.push({ taskId: "t", projectId: "p", reviewerId: f.identity.agentId, role: "reviewer", state: "reviewing", generation: 1, nudges: 0, failures: 0, reviewRounds: 1, queuedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
  await expect(f.service.write(f.identity, "metadata", { expectedRevision: current.revision, request: current.request, title: "Reviewer" })).rejects.toMatchObject({ code: "REVIEWER_ONLY" });
  expect((await f.store.read()).tasks[0].title).toBe("Person edited");
});
