import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import { SessionReadService, SessionReadStore, type NativeAttention } from "./session-reads";
import { WorkspaceRestoreService, type ArchivedSession } from "./workspace-restore";
import { forgetHistory } from "./provider-history";
import { historyLimits } from "../shared/automation";
import { nativeAttentionToken, type AttentionAgent } from "../shared/session-attention";

// AUTOMATION-SPEC §4.6: clearing Paseo's unread flag and reviving an archived session both make Paseo load the
// session's whole Codex thread, which an oversized history does not survive. Flowly skips both for such sessions.

const roots: string[] = [];
let savedHome: string | undefined;
let codexHome = "";
beforeEach(async () => {
  forgetHistory();
  savedHome = process.env.CODEX_HOME;
  // Every measurement in this file reads this fresh home, never ~/.codex.
  codexHome = await mkdtemp(join(tmpdir(), "flowly-codex-"));
  roots.push(codexHome);
  process.env.CODEX_HOME = codexHome;
});
afterEach(async () => {
  forgetHistory();
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const pad = (n: number) => String(n).padStart(2, "0");
/** A UUIDv7 Codex thread id created at `ms`, and the local day folder Codex files it under. */
function thread(ms: number) {
  const hex = ms.toString(16).padStart(12, "0");
  const d = new Date(ms);
  return { id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`, day: [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())] };
}
/** A Codex thread whose sparse rollout file is `bytes` long, in its day folder or in archived_sessions. */
async function codexThread(ms: number, bytes: number, archived = false) {
  const { id, day } = thread(ms);
  const dir = archived ? join(codexHome, "archived_sessions") : join(codexHome, "sessions", ...day);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-23T16-54-42-${id}.jsonl`);
  await writeFile(path, "");
  await truncate(path, bytes);
  return id;
}
const persistence = (id: string) => ({ provider: "codex", sessionId: id, nativeHandle: id });
const created = Date.parse("2026-10-23T12:00:00Z");
const tooLarge = historyLimits.rotate;
const justBelow = historyLimits.rotate - 1;

async function board(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  return { root, store, now: new Date().toISOString() };
}

// ---- Session reads (copied from session-reads.test.ts, with Codex persistence and one snapshot per session) ----

const at = "2026-10-23T10:00:00.000Z";
const unreadCodex = (id: string) =>
  ({
    id, workspaceId: "w", status: "idle", archivedAt: null, requiresAttention: true, attentionReason: "finished", attentionTimestamp: at,
    provider: "codex", persistence: persistence(id),
  }) as AttentionAgent;

async function readsFixture(agents: AttentionAgent[]) {
  const { root, store, now } = await board("flowly-reads-");
  await store.mutate((b) => {
    b.projects.push({
      id: "p", paseoProjectId: "native", title: "P", description: "",
      primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null,
    });
    b.tasks.push({
      id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root],
      title: "Card", description: "", status: "development", priority: "normal",
      position: 0, revision: 1, operationId: "op", createdAt: now, updatedAt: now, archivedAt: null,
    });
  });
  const refreshed: string[] = [];
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          refreshed.push(id);
          return { agent: agents.find((a) => a.id === id) ?? null };
        },
      }),
    },
    workspaces: { ref: () => ({ refresh: async () => ({ id: "w", archivingAt: null }) }) },
  } as unknown as PaseoApi;
  return { store, reads: new SessionReadStore(store.directory), paseo, refreshed };
}

function fakeNative(agents: AttentionAgent[]) {
  const clear = vi.fn(async (_ids: string[]) => undefined);
  const close = vi.fn(async () => undefined);
  const native: NativeAttention = { connect: async () => ({ agents: async () => agents, clear, close }) };
  return { native, clear, close };
}

test("marking an oversized Codex session read keeps Flowly's receipt but leaves Paseo's flag alone; a smaller one is cleared", async () => {
  const big = unreadCodex(await codexThread(created, tooLarge));
  const small = unreadCodex(await codexThread(created + 1000, justBelow));
  const fake = fakeNative([big, small]);
  const x = await readsFixture([big, small]);
  const service = new SessionReadService(x.store, x.reads, fake.native);

  const kept = await service.mark({ taskId: "t", agentId: big.id, token: nativeAttentionToken(big)! }, x.paseo);
  expect(kept).toMatchObject({ agentId: big.id, token: nativeAttentionToken(big) });
  expect(fake.clear).not.toHaveBeenCalled();

  await service.mark({ taskId: "t", agentId: small.id, token: nativeAttentionToken(small)! }, x.paseo);
  expect(fake.clear.mock.calls).toEqual([[[small.id]]]);
  // Both are read in Flowly.
  expect((await x.reads.read()).receipts.map((r) => r.agentId).sort()).toEqual([big.id, small.id].sort());
});

test("the read-state sync never clears Paseo's flag of an oversized Codex session; smaller and unmeasurable ones are cleared", async () => {
  const big = unreadCodex(await codexThread(created, tooLarge));
  const archivedRollout = unreadCodex(await codexThread(created + 1000, tooLarge, true));
  const small = unreadCodex(await codexThread(created + 2000, justBelow));
  // No persistence to measure: unknown, never treated as oversized.
  const claude = { ...unreadCodex("claude-1"), provider: "claude", persistence: { provider: "claude", sessionId: "s" } } as AttentionAgent;
  const agents = [big, archivedRollout, small, claude];
  const x = await readsFixture(agents);
  // Read in Flowly while Paseo was unreachable: every receipt is still unsynced.
  const offline = new SessionReadService(x.store, x.reads, null);
  for (const a of agents) await offline.mark({ taskId: "t", agentId: a.id, token: nativeAttentionToken(a)! }, x.paseo);
  expect((await x.reads.read()).receipts).toHaveLength(4);

  const fake = fakeNative(agents);
  await expect(new SessionReadService(x.store, x.reads, fake.native).syncNative()).resolves.toBe(2);
  expect(fake.clear).toHaveBeenCalledTimes(1);
  expect([...fake.clear.mock.calls[0][0]].sort()).toEqual([small.id, claude.id].sort());
  expect(fake.close).toHaveBeenCalled();
});

// ---- Workspace restore (copied from workspace-restore.test.ts) ----

const wrapAt = "2026-10-15T08:31:04.763Z";
const wrapped = { action: "wrapped_up", note: "1 session(s) archived; workspace archived; card kept" };

async function restoreFixture(sessions: ArchivedSession[]) {
  const { root, store, now } = await board("flowly-restore-");
  await store.mutate((b) => {
    b.projects.push({
      id: "p", paseoProjectId: "native", title: "P", description: "",
      primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null,
    });
    b.tasks.push({
      id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root],
      title: "Card", description: "", status: "todo", priority: "normal",
      position: 0, revision: 3, operationId: "op", createdAt: now, updatedAt: now, archivedAt: null,
    });
    store.event(b, { taskId: "t", actor: "human", action: wrapped.action, note: wrapped.note }).at = wrapAt;
  });
  const recovery = {
    inspect: vi.fn(async () => ({ kind: "recoverable" as const, workspaceId: "w", workspaceName: "Card", action: "restore", branch: "kanban/x" })),
    restore: vi.fn(async () => undefined),
    archivedSessions: vi.fn(async () => sessions),
    reviveSession: vi.fn(async (_id: string) => undefined),
    close: vi.fn(async () => undefined),
  };
  return { store, recovery, service: new WorkspaceRestoreService(store, { connect: async () => recovery }) };
}
const archivedCodex = (id: string): ArchivedSession => ({ id, archivedAt: wrapAt, labels: {}, provider: "codex", persistence: persistence(id) });

test("reopening a card leaves an oversized archived Codex session archived and reports it; the others come back", async () => {
  const big = archivedCodex(await codexThread(created, tooLarge));
  const bigArchived = archivedCodex(await codexThread(created + 1000, tooLarge, true));
  const small = archivedCodex(await codexThread(created + 2000, justBelow));
  const unmeasured: ArchivedSession = { id: "claude-1", archivedAt: wrapAt, labels: {}, provider: "claude", persistence: { provider: "claude", sessionId: "s" } };
  const x = await restoreFixture([big, bigArchived, small, unmeasured]);

  await x.service.restoreAfterReopen("t");

  expect(x.recovery.restore).toHaveBeenCalledWith("w");
  expect(x.recovery.reviveSession.mock.calls.map((c) => c[0])).toEqual([small.id, unmeasured.id]);
  const last = (await x.store.read()).events.at(-1);
  expect(last?.action).toBe("workspace_restored");
  const why = "history 200 MB, too large for Paseo to load safely, left archived";
  expect(last?.note).toBe(
    `Worktree recreated on branch kanban/x and workspace restored; 2 session(s) restored; not restored: ${big.id.slice(0, 8)}: ${why}; ${bigArchived.id.slice(0, 8)}: ${why}.`,
  );
  expect(x.recovery.close).toHaveBeenCalled();
});
