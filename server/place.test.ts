import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore, slotPosition } from "./store";
import { emptyBoard, taskPlacement, type Board, type Status, type Task } from "../shared/model";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
function card(id: string, status: Status, position: number, extra: Partial<Task> = {}): Task {
  return {
    id, projectId: "p1", workspaceId: `w-${id}`, sourcePath: "/repo", repoPaths: [],
    title: `Title ${id}`, description: `Body ${id}`, status, priority: "high", position,
    revision: 3, operationId: `op-${id}`, createdAt: at(position + 10), updatedAt: at(0),
    archivedAt: null, ...extra,
  };
}
async function setup(tasks: Task[]) {
  const directory = await mkdtemp(join(tmpdir(), "ultra-kanban-place-"));
  directories.push(directory);
  const board: Board = emptyBoard();
  board.revision = 5;
  board.projects.push({
    id: "p1", paseoProjectId: "n1", title: "P", description: "", primaryPath: "/repo",
    repos: ["/repo"], revision: 1, createdAt: at(0), updatedAt: at(0), archivedAt: null,
  });
  board.projects.push({ ...board.projects[0], id: "p2", paseoProjectId: "n2" });
  board.tasks.push(...tasks);
  const store = new BoardStore(directory);
  await writeFile(store.path, JSON.stringify(board));
  return store;
}
const order = (b: Board, status: Status) =>
  b.tasks
    .filter((t) => t.status === status)
    .sort((x, y) => x.position - y.position || x.createdAt.localeCompare(y.createdAt))
    .map((t) => t.id);
const place = (id: string, status: Status, anchor: { beforeId?: string; afterId?: string } = {}, revision = 3) => ({
  id, revision, status, beforeId: anchor.beforeId ?? null, afterId: anchor.afterId ?? null,
});

describe("slot position", () => {
  test("falls strictly between neighbors, extends ends and reports no room for equal neighbors", () => {
    const peers = [{ position: 0 }, { position: 1 }, { position: 1 }];
    expect(slotPosition([], 0)).toBe(0);
    expect(slotPosition(peers, 0)).toBe(-1);
    expect(slotPosition(peers, 1)).toBe(0.5);
    expect(slotPosition(peers, 3)).toBe(2);
    expect(slotPosition(peers, 2)).toBeNull();
  });
});

describe("tasks.place", () => {
  test("same-column reorder writes once and changes only the moved card's position and revision", async () => {
    const s = await setup([card("a", "todo", 0), card("b", "todo", 1), card("c", "todo", 2)]);
    const before = await s.read();
    const moved = await s.placeTask(place("c", "todo", { beforeId: "a" }));
    const after = await s.read();
    expect(order(after, "todo")).toEqual(["c", "a", "b"]);
    expect(after.revision).toBe(before.revision + 1);
    expect(moved.revision).toBe(4);
    const { position: _p, revision: _r, updatedAt: _u, ...rest } = after.tasks.find((t) => t.id === "c")!;
    const { position: _p0, revision: _r0, updatedAt: _u0, ...original } = before.tasks.find((t) => t.id === "c")!;
    expect(rest).toEqual(original);
    expect(after.tasks.filter((t) => t.id !== "c")).toEqual(before.tasks.filter((t) => t.id !== "c"));
    expect(after.events).toEqual([]);
  });
  test("cross-column drop sets status and position in one write and records the status change", async () => {
    const s = await setup([card("a", "todo", 0), card("x", "in_review", 0), card("y", "in_review", 1)]);
    await s.placeTask(place("a", "in_review", { afterId: "x" }));
    const b = await s.read();
    expect(order(b, "in_review")).toEqual(["x", "a", "y"]);
    expect(order(b, "todo")).toEqual([]);
    expect(b.revision).toBe(6);
    expect(b.events).toMatchObject([{ taskId: "a", actor: "human", action: "status_changed", from: "todo", to: "in_review" }]);
  });
  test("no anchor appends to the end; an empty column starts at zero", async () => {
    const s = await setup([card("a", "todo", 0), card("b", "todo", 4)]);
    await s.placeTask(place("a", "todo"));
    await s.placeTask(place("b", "done", {}, 3));
    const b = await s.read();
    expect(order(b, "todo")).toEqual(["a"]);
    expect(b.tasks.find((t) => t.id === "b")!.position).toBe(0);
    expect(order(b, "done")).toEqual(["b"]);
  });
  test("dropping into the current slot does not write or bump revisions", async () => {
    const s = await setup([card("a", "todo", 0), card("b", "todo", 1)]);
    const source = await readFile(s.path, "utf8");
    for (const anchor of [{ beforeId: "b" }, {}, { afterId: "a" }]) {
      const id = Object.keys(anchor).length === 0 ? "b" : anchor.beforeId ? "a" : "b";
      expect((await s.placeTask(place(id, "todo", anchor))).revision).toBe(3);
    }
    expect(await readFile(s.path, "utf8")).toBe(source);
  });
  test("stale revision and invalid anchors are rejected without writing", async () => {
    const s = await setup([
      card("a", "todo", 0), card("b", "todo", 1), card("x", "done", 0),
      card("z", "todo", 2, { projectId: "p2" }),
    ]);
    const source = await readFile(s.path, "utf8");
    await expect(s.placeTask(place("a", "todo", { afterId: "b" }, 2))).rejects.toThrow("Revision conflict");
    await expect(s.placeTask(place("a", "todo", { beforeId: "a" }))).rejects.toThrow("Drop position changed");
    await expect(s.placeTask(place("a", "todo", { beforeId: "x" }))).rejects.toThrow("Drop position changed");
    await expect(s.placeTask(place("a", "todo", { beforeId: "missing" }))).rejects.toThrow("Drop position changed");
    await expect(s.placeTask(place("missing", "todo"))).rejects.toThrow("Task not found");
    expect(await readFile(s.path, "utf8")).toBe(source);
  });
  test("archived cards and archived projects cannot be placed", async () => {
    const s = await setup([card("a", "todo", 0, { archivedAt: at(1) }), card("b", "todo", 1)]);
    await expect(s.placeTask(place("a", "done"))).rejects.toThrow("Archived");
    await s.mutate((b) => { b.projects[0].archivedAt = at(2); });
    await expect(s.placeTask(place("b", "done"))).rejects.toThrow("Archived");
  });
  test("concurrent drops with the same captured revision commit exactly once", async () => {
    const s = await setup([card("a", "todo", 0), card("b", "todo", 1)]);
    const results = await Promise.allSettled([
      s.placeTask(place("a", "done")),
      s.placeTask(place("a", "in_review")),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const b = await s.read();
    expect(b.tasks.find((t) => t.id === "a")!.status).toBe("done");
    expect(b.revision).toBe(6);
  });
  test("equal neighbor positions are normalized without touching other revisions", async () => {
    const s = await setup([card("a", "todo", 0), card("b", "todo", 0), card("c", "todo", 0), card("d", "done", 0)]);
    await s.placeTask(place("d", "todo", { beforeId: "b" }));
    const b = await s.read();
    expect(order(b, "todo")).toEqual(["a", "d", "b", "c"]);
    expect(b.tasks.filter((t) => t.id !== "d").map((t) => t.revision)).toEqual([3, 3, 3]);
  });
  test("input accepts at most one anchor", () => {
    expect(taskPlacement.safeParse(place("a", "todo", { beforeId: "b", afterId: "c" })).success).toBe(false);
    expect(taskPlacement.safeParse(place("a", "todo", { afterId: "c" })).success).toBe(true);
  });
});
