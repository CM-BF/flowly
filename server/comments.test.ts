import { afterEach, expect, test } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { addComment } from "./comments";
import { commentInput, commentLimits } from "../shared/comments";
import { commentTask } from "../shared/rpc";
import { emptyBoard, type Board } from "../shared/model";

// Card comments (CARD-COMMENTS-SPEC §4, §6): recorded on the card as "commented" events, never twice per operation.
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup() {
  const path = await mkdtemp(join(tmpdir(), "flowly-comments-test-"));
  directories.push(path);
  const store = new BoardStore(path);
  const now = new Date().toISOString();
  await store.mutate((board: Board) => {
    Object.assign(board, emptyBoard());
    board.projects.push({ id: "p", paseoProjectId: "native", title: "Project", description: "", primaryPath: "/repo", repos: ["/repo"], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    board.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: "/repo", repoPaths: [], title: "Card", description: "", status: "in_review", priority: "normal", position: 0, revision: 3, operationId: "create", createdAt: now, updatedAt: now, archivedAt: null });
  });
  return store;
}

test("a comment is a human commented event with the exact text; the card revision stays", async () => {
  const store = await setup();
  const before = await store.read();
  const text = "  Did the 429 retry land?\nAlso keep the old flag.  ";
  const event = await addComment(store, { taskId: "t", text, operationId: "op-1" });
  expect(event).toMatchObject({ taskId: "t", actor: "human", action: "commented", note: text });
  expect(event.agentId).toBeUndefined();
  const after = await store.read();
  expect(after.events.filter((e) => e.action === "commented")).toEqual([event]);
  // Like an agent's progress note: open forms and agents' signed requests stay valid.
  expect(after.tasks[0].revision).toBe(3);
  expect(after.tasks[0].updatedAt).toBe(before.tasks[0].updatedAt);
  expect(after.tasks[0].status).toBe("in_review");
  expect(after.revision).toBe(before.revision + 1);
});

test("a replay with the same operationId returns the same event and writes nothing", async () => {
  const store = await setup();
  const first = await addComment(store, { taskId: "t", text: "Please also cover Safari.", operationId: "op-1" });
  const written = await readFile(store.path, "utf8");
  const again = await addComment(store, { taskId: "t", text: "Please also cover Safari.", operationId: "op-1" });
  expect(again).toEqual(first);
  expect(await readFile(store.path, "utf8")).toBe(written);
  expect((await store.read()).events.filter((e) => e.action === "commented")).toHaveLength(1);
  // The same operation cannot record a different comment.
  await expect(addComment(store, { taskId: "t", text: "Something else", operationId: "op-1" })).rejects.toThrow(/operation/i);
  // A new operation is a new comment, even with the same text.
  const second = await addComment(store, { taskId: "t", text: "Please also cover Safari.", operationId: "op-2" });
  expect(second.id).not.toBe(first.id);
});

test("archived cards and projects refuse comments with ARCHIVED; a missing card is refused", async () => {
  const store = await setup();
  const kept = await addComment(store, { taskId: "t", text: "Before archiving", operationId: "op-1" });
  await store.mutate((b) => void (b.tasks[0].archivedAt = new Date().toISOString()));
  await expect(addComment(store, { taskId: "t", text: "Too late", operationId: "op-2" })).rejects.toMatchObject({ code: "ARCHIVED" });
  // A retry of a comment that already committed still gets its event.
  expect(await addComment(store, { taskId: "t", text: "Before archiving", operationId: "op-1" })).toEqual(kept);
  await store.mutate((b) => {
    b.tasks[0].archivedAt = null;
    b.projects[0].archivedAt = new Date().toISOString();
  });
  await expect(addComment(store, { taskId: "t", text: "Project archived", operationId: "op-3" })).rejects.toMatchObject({ code: "ARCHIVED" });
  await expect(addComment(store, { taskId: "missing", text: "Nobody", operationId: "op-4" })).rejects.toThrow(/not found/i);
  expect((await store.read()).events.filter((e) => e.action === "commented")).toHaveLength(1);
});

test("Done and Cancelled cards still take comments", async () => {
  const store = await setup();
  for (const status of ["done", "cancelled"] as const) {
    await store.mutate((b) => void (b.tasks[0].status = status));
    await expect(addComment(store, { taskId: "t", text: `On a ${status} card`, operationId: `op-${status}` })).resolves.toMatchObject({ action: "commented" });
  }
  expect((await store.read()).tasks[0].status).toBe("cancelled");
});

test("comments outlive the card's activity limit and keep their own bound", async () => {
  const store = await setup();
  for (let i = 0; i < 3; i++) await addComment(store, { taskId: "t", text: `Early comment ${i}`, operationId: `early-${i}` });
  await store.mutate((b) => {
    for (let i = 0; i < 130; i++) store.event(b, { taskId: "t", actor: "system", action: "turn_ended" });
  });
  let board = await store.read();
  expect(board.events.filter((e) => e.action === "commented").map((e) => e.note)).toEqual(["Early comment 0", "Early comment 1", "Early comment 2"]);
  expect(board.events.filter((e) => e.action !== "commented")).toHaveLength(100);
  for (let i = 0; i < commentLimits.perTask; i++) await addComment(store, { taskId: "t", text: `Later comment ${i}`, operationId: `later-${i}` });
  board = await store.read();
  const comments = board.events.filter((e) => e.action === "commented");
  expect(comments).toHaveLength(commentLimits.perTask);
  expect(comments[0].note).toBe("Later comment 0");
  expect(board.events.filter((e) => e.action !== "commented")).toHaveLength(100);
});

test("deleting a card removes its comments with its other events and keeps them in the backup", async () => {
  const store = await setup();
  await addComment(store, { taskId: "t", text: "Keep this in the backup", operationId: "op-1" });
  const { backup } = await store.deleteTask({ id: "t", revision: 3 });
  expect((await store.read()).events).toEqual([]);
  expect(await readdir(join(store.directory, "removed"))).toHaveLength(1);
  expect(JSON.parse(await readFile(backup, "utf8")).events.map((e: { note?: string }) => e.note)).toContain("Keep this in the backup");
});

test("the RPC takes 1 to 10000 characters of non-blank text and an operation id", () => {
  expect(commentTask.name).toBe("tasks.comment");
  expect(commentInput.safeParse({ taskId: "t", text: "Hi", operationId: "op" }).success).toBe(true);
  expect(commentInput.safeParse({ taskId: "t", text: "x".repeat(commentLimits.text), operationId: "op" }).success).toBe(true);
  expect(commentInput.safeParse({ taskId: "t", text: "x".repeat(commentLimits.text + 1), operationId: "op" }).success).toBe(false);
  expect(commentInput.safeParse({ taskId: "t", text: " \n\t", operationId: "op" }).success).toBe(false);
  expect(commentInput.safeParse({ taskId: "t", text: "Hi" }).success).toBe(false);
  expect(commentInput.safeParse({ taskId: "t", text: "Hi", operationId: "op", extra: 1 }).success).toBe(false);
});
