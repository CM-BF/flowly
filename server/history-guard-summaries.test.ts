import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { FlowLog } from "./flow-log";
import { CommandLog } from "./command-log";
import { SummaryService, SummaryStore } from "./summaries";
import { WorkflowInsightsService, WorkflowStore } from "./workflow-insights";
import { forgetHistory } from "./provider-history";
import { historyLimits } from "../shared/automation";
import type { SummarySettings } from "../shared/summary";
import type { WorkflowSettings } from "../shared/workflow-insights";

// AUTOMATION-SPEC §4.6: Flowly never reads the timeline of a session whose Codex history reached historyLimits.rotate,
// because the read itself can make Paseo load the whole thread (progress summaries, workflow insights backfill).
const roots: string[] = [];
let savedCodexHome: string | undefined;
let codexHome = "";
beforeEach(async () => {
  forgetHistory();
  savedCodexHome = process.env.CODEX_HOME;
  codexHome = await realpath(await mkdtemp(join(tmpdir(), "flowly-codex-")));
  roots.push(codexHome);
  process.env.CODEX_HOME = codexHome;
});
afterEach(async () => {
  forgetHistory();
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const pad = (n: number) => String(n).padStart(2, "0");
/** A UUIDv7 thread id created at `ms` (also the agent id), with a sparse rollout of `bytes` in its local day folder. */
async function codexSession(ms: number, bytes: number) {
  const hex = ms.toString(16).padStart(12, "0");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`;
  const d = new Date(ms);
  const dir = join(codexHome, "sessions", String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-23T16-54-42-${id}.jsonl`);
  await writeFile(path, "");
  await truncate(path, bytes);
  return id;
}
/** Two Codex sessions: one whose history reached the limit, one just below it (the control). */
async function sessions() {
  const big = await codexSession(Date.parse("2026-10-23T16:54:42Z"), historyLimits.rotate);
  const small = await codexSession(Date.parse("2026-10-21T08:00:00Z"), historyLimits.rotate - 1);
  return { big, small };
}
const snapshot = (id: string, workspaceId: string) => ({
  id,
  workspaceId,
  status: "idle",
  provider: "codex",
  archivedAt: null,
  labels: {},
  updatedAt: "2026-10-19T10:00:00.000Z",
  persistence: { provider: "codex", sessionId: id, nativeHandle: id },
});

async function boardRoot(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/** Fixture of server/summaries.test.ts: card "t" in workspace "w", Codex sessions with the given timelines. */
async function summaries(timelines: Record<string, unknown[]>) {
  const root = await boardRoot("flowly-summary-guard-");
  const board = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await board.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const refetched: string[] = [];
  const appended: string[] = [];
  const created: { parent: string; prompt: string }[] = [];
  const paseo = {
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "claude", available: true }] }),
      listModels: async () => ({ models: [{ id: "claude-haiku-5-5" }], error: null }),
    },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (o: { parent: string; prompt: string }) => {
            created.push({ parent: o.parent, prompt: o.prompt });
            const lastMessage = JSON.stringify({ update: true, state: "s", target: "Goal: g", recap: "r", next: "n" });
            return { waitForFinish: async () => ({ status: "idle", final: null, error: null, lastMessage }), archive: async () => ({ archivedAt: now }) };
          },
        },
      }),
    },
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: snapshot(id, "w") }),
        timeline: {
          refetch: async () => {
            refetched.push(id);
            return { entries: timelines[id] || [] };
          },
          append: async () => {
            appended.push(id);
            return { seq: appended.length, epoch: "e" };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  const settings: SummarySettings = { summaryEnabled: true, summaryModel: "", digestEnabled: true, retroEnabled: true };
  const store = new SummaryStore(board.directory);
  const service = new SummaryService(board, store, async () => settings, async () => "en", undefined, 50, async (a) => {
    await a.archive();
  });
  return { service, store, paseo, refetched, appended, created };
}

test("manual summary refresh never reads an oversized session's timeline and summarizes the card's other session", async () => {
  const { big, small } = await sessions();
  // The oversized session holds the newer turn: read, it would be the one summarized.
  const x = await summaries({
    [big]: [{ item: { type: "user_message", text: "big ask" }, timestamp: "2026-10-23T17:00:00.000Z" }],
    [small]: [{ item: { type: "user_message", text: "small ask" }, timestamp: "2026-10-21T09:00:00.000Z" }],
  });
  expect(await x.service.refresh("t", [big, small], x.paseo)).toEqual({ queued: true });
  await x.service.settled("t");
  await vi.waitFor(() => expect(x.appended).toEqual([small]));
  // The session just below the limit is read and summarized as before.
  expect(x.refetched).toEqual([small]);
  expect(x.created).toHaveLength(1);
  expect(x.created[0]).toMatchObject({ parent: small });
  expect(x.created[0].prompt).toContain("User: small ask");
  expect(x.created[0].prompt).not.toContain("big ask");
  expect((await x.store.latest("t"))?.agentIds).toEqual([small]);
});

test("a card whose only session is oversized has nothing to summarize, and its timeline is not read", async () => {
  const { big } = await sessions();
  const x = await summaries({ [big]: [{ item: { type: "user_message", text: "big ask" }, timestamp: "2026-10-23T17:00:00.000Z" }] });
  await expect(x.service.refresh("t", [big], x.paseo)).rejects.toThrow(/No conversation to summarize yet/);
  expect(x.refetched).toEqual([]);
  expect(x.created).toEqual([]);
});

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const shell = (callId: string, command: string) => ({ type: "tool_call", callId, status: "completed", detail: { type: "shell", command } });

test("workflow insights backfill does not read an oversized session; the card's other session is backfilled", async () => {
  const { big, small } = await sessions();
  // Fixture of server/workflow-insights.test.ts: project "p", cards in workspaces w0 (big session) and w1 (small one).
  const root = await boardRoot("flowly-workflow-guard-");
  const board = new BoardStore(join(root, "data"));
  const flow = new FlowLog(board.directory);
  board.flow = flow;
  await board.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: "", updatedAt: "", archivedAt: null });
    for (const [i, id] of ["aaaaaaaa-1", "bbbbbbbb-2"].entries())
      b.tasks.push({ id, projectId: "p", workspaceId: `w${i}`, sourcePath: root, repoPaths: [root], title: `Card ${i}`, description: "", status: "development", priority: "normal", position: i, revision: 1, operationId: `o${i}`, createdAt: "2026-10-15T01:00:00.000Z", updatedAt: "2026-10-15T01:00:00.000Z", archivedAt: null });
  });
  const workspaces: Record<string, string> = { [big]: "w0", [small]: "w1" };
  const timelines: Record<string, unknown[]> = {
    [big]: [{ timestamp: "2026-10-18T10:00:00.000Z", item: shell("c1", "npm run lint") }],
    [small]: [{ timestamp: "2026-10-19T10:00:00.000Z", item: shell("c1", "make build") }],
  };
  const refetched: string[] = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: [big, small].map((id) => ({ agent: snapshot(id, workspaces[id]) })), pageInfo: { nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: snapshot(id, workspaces[id]) }),
        timeline: {
          refetch: async () => {
            refetched.push(id);
            return { entries: timelines[id] || [], hasOlder: false, startCursor: null };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  const settings: WorkflowSettings = { enabled: true, model: "", intervalDays: 7, runHour: 9, timeZone: "UTC" };
  const summary: SummarySettings = { summaryEnabled: true, summaryModel: "", digestEnabled: true, retroEnabled: true };
  const log = new CommandLog(board.directory);
  const service = new WorkflowInsightsService(board, log, new WorkflowStore(board.directory), flow, async () => settings, async () => summary, async () => "en", () => NOW, 1000, "/home/me");
  expect(await service.backfill("p", paseo)).toBe(1);
  expect(refetched).toEqual([small]);
  expect((await log.read("p")).map((r) => [r.agentId, r.taskId, r.actions[0]])).toEqual([[small, "bbbbbbbb-2", "make build"]]);
});
