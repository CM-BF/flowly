import { afterEach, expect, test } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { projectOrder } from "../shared/model";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-order-")));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  await store.mutate((b) => {
    for (const [i, id] of ["a", "b", "c"].entries())
      b.projects.push({ id, paseoProjectId: `n${id}`, title: id, description: "", primaryPath: `/${id}`, repos: [`/${id}`], revision: 5, createdAt: `2026-10-0${i + 1}T00:00:00Z`, updatedAt: "x", archivedAt: null });
  });
  return store;
}
const order = async (store: BoardStore) => (await store.read()).projects.sort(projectOrder).map((p) => p.id);

test("projects move up, down and to top without touching their revisions", async () => {
  const store = await setup();
  expect(await order(store)).toEqual(["a", "b", "c"]);
  await store.moveProject({ id: "c", direction: "up" });
  expect(await order(store)).toEqual(["a", "c", "b"]);
  await store.moveProject({ id: "b", direction: "top" });
  expect(await order(store)).toEqual(["b", "a", "c"]);
  await store.moveProject({ id: "c", direction: "down" }); // already last: no change
  expect(await order(store)).toEqual(["b", "a", "c"]);
  expect((await store.read()).projects.every((p) => p.revision === 5)).toBe(true);
  await store.moveProject({ id: "b", to: 2 });
  expect(await order(store)).toEqual(["a", "c", "b"]);
  await store.moveProject({ id: "b", to: 99 }); // clamped, already last
  expect(await order(store)).toEqual(["a", "c", "b"]);
  await expect(store.moveProject({ id: "missing", direction: "up" })).rejects.toThrow(/not found/);
});

test("unpositioned (new) projects sort after ordered ones by creation", () => {
  const p = (id: string, createdAt: string, position?: number) => ({ id, createdAt, position });
  expect([p("new", "2026-10-09"), p("x", "2026-10-01", 1), p("y", "2026-10-02", 0)].sort(projectOrder).map((q) => q.id)).toEqual(["y", "x", "new"]);
});

test("project lanes: turning a lane off needs it empty; disabled lanes reject cards", async () => {
  const store = await setup();
  await store.mutate((b) => {
    const now = "2026-10-01T00:00:00Z";
    b.tasks.push({ id: "t1", projectId: "a", workspaceId: "w", sourcePath: "/a", repoPaths: ["/a"], title: "T", description: "", status: "blocked", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const lanes = (off: string[]) =>
    (["backlog", "todo", "design", "development", "test", "in_review", "blocked", "done", "cancelled"] as const).map((status) => ({
      status,
      enabled: !off.includes(status),
      ...(status === "todo" ? { name: "Ready" } : {}),
    }));
  const rev = async () => (await store.read()).projects.find((p) => p.id === "a")!.revision;
  await expect(store.updateProject({ id: "a", revision: await rev(), lanes: lanes(["blocked"]) })).rejects.toThrow(/Move the cards out of Blocked \(1\)/);
  await store.editTask({ id: "t1", revision: 1, status: "todo", actor: "human" });
  const saved = await store.updateProject({ id: "a", revision: await rev(), lanes: lanes(["blocked", "backlog"]) });
  expect(saved.lanes?.find((l) => l.status === "todo")?.name).toBe("Ready");
  await expect(store.editTask({ id: "t1", revision: 2, status: "blocked", actor: "human" })).rejects.toThrow(/Blocked is not a lane/);
  await expect(store.placeTask({ id: "t1", revision: 2, status: "backlog", beforeId: null, afterId: null })).rejects.toThrow(/Backlog is not a lane/);
});
