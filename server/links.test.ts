import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { createLink, deleteLink } from "./links";
import { linkLimits, type Task } from "../shared/model";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const now = "2026-10-16T00:00:00.000Z";
const card = (id: string, projectId = "p", extra: Partial<Task> = {}): Task => ({
  id, projectId, workspaceId: `w-${id}`, sourcePath: `/${projectId}`, repoPaths: [`/${projectId}`], title: id.toUpperCase(),
  description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: `o-${id}`,
  createdAt: now, updatedAt: now, archivedAt: null, ...extra,
});
async function setup(ids = ["a", "b", "c"]) {
  const root = await mkdtemp(join(tmpdir(), "ultra-links-test-"));
  roots.push(root);
  const store = new BoardStore(root);
  await store.mutate((board) => {
    for (const p of ["p", "q"])
      board.projects.push({
        id: p, title: p, description: "", paseoProjectId: `n-${p}`, primaryPath: `/${p}`, repos: [`/${p}`],
        revision: 1, createdAt: now, updatedAt: now, archivedAt: null,
      });
    board.tasks.push(...ids.map((id) => card(id)), card("other", "q"));
  });
  return store;
}

test("linking writes once, records an event on both cards, and leaves task revisions alone", async () => {
  const store = await setup();
  const before = await store.read();
  const link = await createLink(store, { kind: "blocks", from: "a", to: "b" });
  const board = await store.read();
  expect(link).toMatchObject({ kind: "blocks", from: "a", to: "b", projectId: "p", createdBy: "human" });
  expect(board.revision).toBe(before.revision + 1);
  expect(board.tasks.map((t) => t.revision)).toEqual(before.tasks.map((t) => t.revision));
  expect(board.events.filter((e) => e.action === "linked").map((e) => [e.taskId, e.note])).toEqual([
    ["a", "Blocks: B"],
    ["b", "Blocked by: A"],
  ]);
  // The same link again returns the stored one without a write.
  expect((await createLink(store, { kind: "blocks", from: "a", to: "b" })).id).toBe(link.id);
  expect((await store.read()).revision).toBe(board.revision);
});

test("links are refused across projects, to itself, when archived, when duplicated or circular", async () => {
  const store = await setup();
  await expect(createLink(store, { kind: "related", from: "a", to: "other" })).rejects.toThrow("different projects");
  await expect(createLink(store, { kind: "related", from: "a", to: "a" })).rejects.toThrow("itself");
  await expect(createLink(store, { kind: "related", from: "a", to: "missing" })).rejects.toThrow("Task not found");
  await createLink(store, { kind: "blocks", from: "a", to: "b" });
  await createLink(store, { kind: "blocks", from: "b", to: "c" });
  await expect(createLink(store, { kind: "blocks", from: "c", to: "a" })).rejects.toThrow("This would make a cycle: C → A → B → C.");
  await expect(createLink(store, { kind: "blocks", from: "b", to: "a" })).rejects.toThrow("already linked");
  await expect(createLink(store, { kind: "related", from: "b", to: "a" })).rejects.toThrow("already linked");
  await store.mutate((board) => {
    board.tasks.find((t) => t.id === "c")!.archivedAt = now;
  });
  await expect(createLink(store, { kind: "derived", from: "a", to: "c" })).rejects.toThrow("Archived cards");
  expect((await store.read()).links).toHaveLength(2);
});

test("a more specific link replaces Related between the same cards", async () => {
  const store = await setup();
  const related = await createLink(store, { kind: "related", from: "b", to: "a" });
  expect((await createLink(store, { kind: "related", from: "a", to: "b" })).id).toBe(related.id);
  await createLink(store, { kind: "derived", from: "a", to: "b" });
  expect((await store.read()).links.map((l) => l.kind)).toEqual(["derived"]);
});

test("a card can have at most the link limit", async () => {
  const ids = ["a", ...Array.from({ length: linkLimits.perTask + 1 }, (_, i) => `x${i}`)];
  const store = await setup(ids);
  await store.mutate((board) => {
    board.links = ids.slice(1, linkLimits.perTask + 1).map((id) => ({
      id: `l-${id}`, projectId: "p", kind: "related", from: "a", to: id, createdBy: "human", createdAt: now,
    }));
  });
  await expect(createLink(store, { kind: "related", from: "a", to: `x${linkLimits.perTask}` })).rejects.toThrow(
    `at most ${linkLimits.perTask} links`,
  );
});

test("unlinking records an event on both cards; a missing link is reported", async () => {
  const store = await setup();
  const link = await createLink(store, { kind: "derived", from: "a", to: "b" });
  await deleteLink(store, { id: link.id });
  const board = await store.read();
  expect(board.links).toEqual([]);
  expect(board.events.filter((e) => e.action === "unlinked").map((e) => [e.taskId, e.note])).toEqual([
    ["a", "Follow-up of: B"],
    ["b", "Follow-up: A"],
  ]);
  await expect(deleteLink(store, { id: link.id })).rejects.toThrow("This link no longer exists.");
});

test("deleting a card drops its links into the backup and tells the other card", async () => {
  const store = await setup();
  await createLink(store, { kind: "blocks", from: "a", to: "b" });
  await createLink(store, { kind: "related", from: "b", to: "c" });
  const { backup } = await store.deleteTask({ id: "a", revision: 1 });
  const board = await store.read();
  expect(board.links.map((l) => [l.from, l.to])).toEqual([["b", "c"]]);
  expect(board.events.at(-1)).toMatchObject({ taskId: "b", action: "unlinked", note: "Blocked by: A" });
  expect(JSON.parse(await readFile(backup, "utf8")).links).toEqual([expect.objectContaining({ from: "a", to: "b" })]);
});

test("removing a project drops and backs up its links", async () => {
  const store = await setup();
  await createLink(store, { kind: "related", from: "a", to: "b" });
  const { backup } = await store.removeProject({ id: "p", revision: 1 } as never);
  expect((await store.read()).links).toEqual([]);
  expect(JSON.parse(await readFile(backup, "utf8")).links).toHaveLength(1);
});

test("files written before links get idea origins as links once; later files are kept as they are", async () => {
  const store = await setup();
  const board = JSON.parse(await readFile(store.path, "utf8"));
  board.tasks.find((t: Task) => t.id === "b").origin = { taskId: "a", ideaId: "i" };
  delete board.links;
  await writeFile(store.path, JSON.stringify(board));
  expect((await store.read()).links).toEqual([expect.objectContaining({ kind: "derived", from: "b", to: "a", ideaId: "i" })]);
  board.links = [];
  await writeFile(store.path, JSON.stringify(board));
  expect((await store.read()).links).toEqual([]);
});

test("a follow-up card is linked to its source in the same write, checked before any workspace", async () => {
  const store = await setup();
  await store.mutate((board) => {
    board.projects.find((p) => p.id === "p")!.primaryPath = "/p";
  });
  const create = vi.fn(async () => ({ id: "new-ws" }));
  const paseo = { workspaces: { create } } as unknown as PaseoApi;
  const service = new BoardService(store);
  const input = {
    projectId: "p", operationId: "op-follow", title: "Next", description: "", status: "todo" as const,
    priority: "normal" as const, mode: "directory" as const, baseRef: "",
  };
  await expect(service.createTask({ ...input, followUpOf: "other" }, paseo)).rejects.toThrow("no longer in this project");
  await expect(service.createTask({ ...input, followUpOf: "a", ideaId: "i" }, paseo)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  const created = await service.createTask({ ...input, followUpOf: "a" }, paseo);
  const board = await store.read();
  expect(board.links).toEqual([expect.objectContaining({ kind: "derived", from: created.id, to: "a", createdBy: "human" })]);
  expect(board.events.filter((e) => e.action === "linked").map((e) => e.taskId)).toEqual([created.id, "a"]);
  // Replaying the operation returns the first card without another link.
  expect((await service.createTask({ ...input, followUpOf: "a" }, paseo)).id).toBe(created.id);
  expect((await store.read()).links).toHaveLength(1);
});
