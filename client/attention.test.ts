import { expect, test } from "vitest";
import { attentionItems, lastSessionSettings } from "./attention";

const now = "2026-10-14T10:00:00.000Z";
const project = (id: string, archivedAt: string | null = null) => ({
  id, paseoProjectId: id, title: id, description: "", primaryPath: "/p", repos: ["/p"],
  revision: 1, createdAt: now, updatedAt: now, archivedAt,
});
const task = (id: string, workspaceId: string, projectId = "p", archivedAt: string | null = null) => ({
  id, projectId, workspaceId, sourcePath: "/p", repoPaths: ["/p"], title: id, description: "",
  status: "in_progress" as const, priority: "normal" as const, position: 0, revision: 1,
  operationId: id, createdAt: now, updatedAt: now, archivedAt,
});
const agent = (id: string, workspaceId: string, extra: Record<string, unknown> = {}) => ({
  id, workspaceId, status: "idle" as const, archivedAt: null, updatedAt: now, ...extra,
});
const finished = { requiresAttention: true, attentionReason: "finished", attentionTimestamp: now };

test("lists cards across projects needing a human; running alone and archived scopes are excluded", () => {
  const board = {
    projects: [project("p"), project("q"), project("old", now)],
    tasks: [task("a", "wa"), task("b", "wb", "q"), task("c", "wc"), task("d", "wd", "old"), task("e", "we", "p", now)],
    events: [],
  };
  const items = attentionItems(board, [
    agent("s1", "wa", finished),
    agent("s2", "wb", { status: "error", updatedAt: "2026-10-14T09:00:00.000Z" }),
    agent("s3", "wc", { status: "running" }),
    agent("s4", "wd", finished),
    agent("s5", "we", finished),
  ], [], false);
  expect(items.map((i) => i.task.id)).toEqual(["b", "a"]);
  expect(items[0]).toMatchObject({ errors: 1, sessionId: "s2" });
  expect(items[1]).toMatchObject({ unread: 1, sessionId: "s1" });
});

test("several flagged sessions open the card; read receipts and unavailable read state suppress unread", () => {
  const board = { projects: [project("p")], tasks: [task("a", "wa")], events: [] };
  const two = attentionItems(board, [agent("s1", "wa", finished), agent("s2", "wa", finished)], [], false);
  expect(two[0]).toMatchObject({ unread: 2, sessionId: null });
  const token = JSON.stringify(["s1", "finished", now]);
  const read = attentionItems(board, [agent("s1", "wa", finished)], [
    { taskId: "a", workspaceId: "wa", agentId: "s1", token, readAt: now },
  ], false);
  expect(read).toEqual([]);
  expect(attentionItems(board, [agent("s1", "wa", finished)], [], true)).toEqual([]);
  expect(attentionItems(board, [agent("s1", "wa", { pendingPermissions: [{}] })], [], true)[0]).toMatchObject({ permissions: 1 });
});

test("last session settings come from the newest active session in a card workspace", () => {
  const base = { archivedAt: null, provider: "codex", model: "m1", currentModeId: "full-access" };
  expect(lastSessionSettings([
    { ...base, workspaceId: "wa", createdAt: "2026-10-01T00:00:00Z" },
    { ...base, workspaceId: "wb", createdAt: "2026-10-03T00:00:00Z", provider: "claude", model: "sonnet" },
    { ...base, workspaceId: "elsewhere", createdAt: "2026-10-05T00:00:00Z", provider: "x" },
    { ...base, workspaceId: "wa", createdAt: "2026-10-06T00:00:00Z", archivedAt: "2026-10-07T00:00:00Z", provider: "y" },
  ], new Set(["wa", "wb"]))).toEqual({ provider: "claude", model: "sonnet", mode: "full-access" });
  expect(lastSessionSettings([], new Set())).toBeNull();
});
