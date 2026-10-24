import { afterEach, beforeEach, expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { SessionTailService } from "./session-tail";
import { SessionImageService } from "./session-images";
import { forgetHistory } from "./provider-history";
import { historyLimits } from "../shared/automation";

// AUTOMATION-SPEC §4.6: a session whose Codex history reached historyLimits.rotate is never read through Paseo's
// timeline (session preview, session images): the read itself can make Paseo load the whole thread and crash.
const roots: string[] = [];
const codexHomeBefore = process.env.CODEX_HOME;
beforeEach(async () => {
  forgetHistory();
  // Every measurement looks in a fresh temp CODEX_HOME, never in ~/.codex.
  process.env.CODEX_HOME = await temp("flowly-codex-");
});
afterEach(async () => {
  forgetHistory();
  if (codexHomeBefore === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = codexHomeBefore;
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function temp(prefix: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

const pad = (n: number) => String(n).padStart(2, "0");
/**
 * A Codex session created at `iso` whose rollout is a sparse file of `bytes`, filed where Codex puts it
 * (CODEX_HOME/sessions/<local day of the UUIDv7 timestamp>). Its id is a UUIDv7 thread id, used as the agent id.
 */
async function codexSession(iso: string, bytes: number) {
  const ms = Date.parse(iso);
  const hex = ms.toString(16).padStart(12, "0");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`;
  const d = new Date(ms);
  const dir = join(process.env.CODEX_HOME!, "sessions", String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-23T16-54-42-${id}.jsonl`);
  await writeFile(path, "");
  await truncate(path, bytes);
  return id;
}

/** The card fixture of session-tail.test.ts / session-images.test.ts: task "t" in workspace "w". */
async function board() {
  const root = await temp("flowly-history-guard-");
  const store = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await store.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  return { store, root };
}

/** A daemon of idle Codex sessions in workspace "w"; every timeline read is recorded and returns `entries`. */
function daemon(entries: unknown[]) {
  const reads: { agentId: string; options: unknown }[] = [];
  const snapshot = (id: string) => ({
    id,
    workspaceId: "w",
    status: "idle",
    provider: "codex",
    persistence: { provider: "codex", sessionId: id, nativeHandle: id },
  });
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: snapshot(id) }),
        timeline: {
          refetch: async (options: unknown) => {
            reads.push({ agentId: id, options });
            return { agent: snapshot(id), epoch: "e1", entries, startCursor: null, hasOlder: false, hasNewer: false, reset: false, staleCursor: false };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  return { paseo, reads };
}

const toolCall = { seqStart: 3, item: { type: "tool_call", name: "edit", status: "completed", detail: { content: "big" } } };
const refused = "This session's history is 200 MB, too large for Paseo to load safely, so Flowly does not show it.";

test("the session preview refuses an oversized Codex session in every mode and never reads its timeline", async () => {
  const { store } = await board();
  const big = await codexSession("2026-10-23T16:54:42Z", historyLimits.rotate);
  const x = daemon([toolCall]);
  const service = new SessionTailService(store);
  const cursor = { epoch: "e1", seq: 3 };
  for (const input of [
    { limit: 35 },
    { limit: 35, mode: "turn" as const },
    { limit: 35, mode: "before" as const, cursor },
    { limit: 35, mode: "after" as const, cursor },
  ])
    await expect(service.tail({ taskId: "t", agentId: big, ...input }, x.paseo)).rejects.toThrow(refused);
  expect(x.reads).toEqual([]);
});

test("the session preview still reads a Codex session just below the limit", async () => {
  const { store } = await board();
  const small = await codexSession("2026-10-23T17:00:00Z", historyLimits.rotate - 1);
  const x = daemon([toolCall]);
  const result = await new SessionTailService(store).tail({ taskId: "t", agentId: small, limit: 35 }, x.paseo);
  expect(result.entries).toEqual([{ seqStart: 3, item: { type: "tool_call", name: "edit", status: "completed" } }]);
  expect(x.reads).toEqual([{ agentId: small, options: { direction: "tail", limit: 35, projection: "projected" } }]);
});

/** A card whose session transcript references a real PNG on the daemon machine. */
async function imageFixture() {
  const { store, root } = await board();
  const png = join(root, "shot.png");
  await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const x = daemon([{ item: { type: "user_message", text: `see [Image: source: ${png}]` } }]);
  return { service: new SessionImageService(store), png, ...x };
}

test("an oversized Codex session serves no images and its transcript is never read", async () => {
  const x = await imageFixture();
  const big = await codexSession("2026-10-23T16:54:42Z", historyLimits.rotate);
  // The image is in the session's timeline, but Flowly does not read that timeline, so it is not part of the session.
  await expect(x.service.read({ taskId: "t", agentId: big, src: x.png }, x.paseo)).rejects.toThrow(/not part of this session/);
  expect(x.reads).toEqual([]);
});

test("a Codex session just below the limit still serves the images of its transcript", async () => {
  const x = await imageFixture();
  const small = await codexSession("2026-10-23T17:00:00Z", historyLimits.rotate - 1);
  const { dataUri } = await x.service.read({ taskId: "t", agentId: small, src: x.png }, x.paseo);
  expect(dataUri).toBe("data:image/png;base64,iVBORw==");
  expect(x.reads).toEqual([{ agentId: small, options: { direction: "tail", limit: 500, projection: "projected" } }]);
});
