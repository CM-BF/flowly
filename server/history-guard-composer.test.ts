import { afterEach, beforeEach, expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { ComposerService, ComposerStore } from "./composer";
import { forgetHistory } from "./provider-history";
import { historyLimits } from "../shared/automation";

// AUTOMATION-SPEC §4.6: sending to a session makes Paseo load it, and Paseo reads an oversized Codex thread whole and
// its worker crashes, so the composer keeps the message queued instead of sending it.
const roots: string[] = [];
const settle = () => new Promise((r) => setTimeout(r, 50));
let codexHome: string | undefined;
beforeEach(() => {
  codexHome = process.env.CODEX_HOME;
  forgetHistory();
});
afterEach(async () => {
  if (codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = codexHome;
  forgetHistory();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const pad = (n: number) => String(n).padStart(2, "0");
/** A UUIDv7 thread id created at `ms`, and the local day folder Codex files it under. */
function thread(ms: number) {
  const hex = ms.toString(16).padStart(12, "0");
  const d = new Date(ms);
  return { id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`, day: [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())] };
}

/** A card with one idle-or-running Codex session whose rollout (sparse, nothing written) is `bytes` long. */
async function setup(bytes: number, status = "running") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowly-history-composer-")));
  roots.push(root);
  const home = join(root, "codex");
  process.env.CODEX_HOME = home;
  const { id, day } = thread(Date.parse("2026-10-23T23:54:42Z"));
  const dir = join(home, "sessions", ...day);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-23T16-54-42-${id}.jsonl`);
  await writeFile(path, "");
  await truncate(path, bytes);

  const board = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await board.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const agent = {
    id,
    workspaceId: "w",
    status,
    provider: "codex",
    archivedAt: null,
    pendingPermissions: [] as unknown[],
    persistence: { provider: "codex", sessionId: id, nativeHandle: id },
  };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent }) }) } } as unknown as PaseoApi;
  const sent: { text: string; steer: boolean }[] = [];
  const service = new ComposerService(
    new ComposerStore(board.directory),
    board,
    async (_p, _id, text, steer) => {
      sent.push({ text, steer });
    },
    () => 1_000_000,
  );
  return { service, paseo, agent, sent, id };
}

test("an oversized Codex session keeps its queued message with an error instead of being sent to", async () => {
  const x = await setup(historyLimits.rotate);
  await x.service.push({ taskId: "t", agentId: x.id, text: "after this turn" }, x.paseo);
  await settle(); // the push's background drain sees a running session and waits
  x.agent.status = "idle";
  expect(await x.service.drain(x.id, x.paseo)).toBe(false);
  expect(x.sent).toEqual([]);
  const entry = (await x.service.read()).sessions[x.id];
  expect(entry.queue.map((m) => m.text)).toEqual(["after this turn"]);
  expect(entry.lastError).toMatch(/history is 200 MB, too large for Paseo to load safely; the message stays queued/);
});

test("send now refuses an oversized Codex session and leaves the message queued", async () => {
  const x = await setup(historyLimits.rotate);
  const item = await x.service.push({ taskId: "t", agentId: x.id, text: "steer this" }, x.paseo);
  await settle();
  await expect(x.service.sendNow({ taskId: "t", agentId: x.id, id: item.id }, x.paseo)).rejects.toThrow(
    /history is 200 MB, too large for Paseo to load safely/,
  );
  expect(x.sent).toEqual([]);
  expect((await x.service.read()).sessions[x.id].queue.map((m) => m.id)).toEqual([item.id]);
});

test("a Codex session just below the limit still drains and takes send now", async () => {
  const x = await setup(historyLimits.rotate - 1);
  const first = await x.service.push({ taskId: "t", agentId: x.id, text: "first" }, x.paseo);
  await x.service.push({ taskId: "t", agentId: x.id, text: "second" }, x.paseo);
  await settle();
  await x.service.sendNow({ taskId: "t", agentId: x.id, id: first.id }, x.paseo);
  x.agent.status = "idle";
  expect(await x.service.drain(x.id, x.paseo)).toBe(true);
  expect(x.sent).toEqual([{ text: "first", steer: true }, { text: "second", steer: false }]);
  expect((await x.service.read()).sessions[x.id]).toBeUndefined();
});

test("polling an oversized session's queue does not rewrite the composer file each time", async () => {
  const { stat } = await import("node:fs/promises");
  const x = await setup(historyLimits.rotate);
  await x.service.push({ taskId: "t", agentId: x.id, text: "after this turn" }, x.paseo);
  await settle();
  x.agent.status = "idle";
  forgetHistory();
  expect(await x.service.drain(x.id, x.paseo)).toBe(false);
  const file = join((x.service as unknown as { store: { path: string } }).store.path);
  const before = (await stat(file)).ino;
  for (let i = 0; i < 3; i++) await x.service.drainAll(x.paseo);
  expect((await stat(file)).ino).toBe(before);
  expect(x.sent).toHaveLength(0);
});
