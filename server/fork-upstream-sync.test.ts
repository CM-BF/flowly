import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import { BoardStore } from "./store";
import { readDatabaseFile } from "./sqlite-storage";
import { boardOverview, OverviewDeltas } from "./board-overview";
import { cardDetail } from "../shared/card-detail";
import { attentionItemsWithFacts } from "../shared/attention";
import { telemetrySettingsValues } from "../shared/settings";
import { emptyBoard, type Board } from "../shared/model";
import type { AutomationJob } from "../shared/automation";

// The fork's board data under upstream's v1.7.0 architecture (AGENTS.md, upstream sync 2026-10-26): SQLite storage, the
// overview and card detail reads that replaced whole-board reads, the shared Attention rule, and telemetry off by default.
const directories: string[] = [];
const stores: BoardStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => undefined)));
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const at = "2026-10-26T10:00:00.000Z";
const project = { id: "p", paseoProjectId: "native-p", title: "P", description: "", primaryPath: "/repo", repos: ["/repo"], revision: 1, createdAt: at, updatedAt: at, archivedAt: null, automation: { enabled: true, maxRunning: 2, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 } };
const task = (id: string, status: Board["tasks"][number]["status"] = "development") => ({
  id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/repo", repoPaths: [], title: `Card ${id}`, description: "", status,
  priority: "normal" as const, position: 0, revision: 1, operationId: `op-${id}`, createdAt: at, updatedAt: at, archivedAt: null,
});
const job = (taskId: string, extra: Partial<AutomationJob> = {}): AutomationJob => ({
  taskId, projectId: "p", role: "implementer", state: "working", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: at, updatedAt: at, ...extra,
});
function fixture(): Board {
  const b = emptyBoard();
  b.projects.push(project);
  b.tasks.push(task("parent"), task("child", "in_review"), task("other"));
  b.links.push({ id: "l1", projectId: "p", kind: "subtask", from: "child", to: "parent", createdBy: "system", createdAt: at });
  b.automation.push(
    job("parent", { state: "waiting", implementerId: "impl-1", subSeen: "child:in_review:reviewing:" }),
    job("child", { role: "reviewer", state: "reviewing", implementerId: "impl-2", reviewerId: "rev-1", reviewRounds: 2, review: { level: "deep", reason: { kind: "card" }, max: 3, size: 3 }, risks: ["The six-month workload has not been measured."], risksFrom: { round: 1 } }),
    job("other", { state: "needs_human", code: "blocked", implementerId: "impl-3" }),
  );
  b.handoffIndex.push({ taskId: "child", fresh: false, staleSince: at, open: 2, sessions: 3, behind: "activity" });
  return b;
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "flowly-fork-sync-"));
  directories.push(path);
  return path;
}

test("automation jobs and the handoff index survive the move to SQLite and every later write", async () => {
  const d = await directory();
  const original = fixture();
  await writeFile(join(d, "board.json"), JSON.stringify(original, null, 2));
  const store = new BoardStore(d, { backend: "sqlite", storage: { checkVersion: false } });
  stores.push(store);
  const migrated = await store.read();
  expect(migrated.automation).toEqual(original.automation);
  expect(migrated.handoffIndex).toEqual(original.handoffIndex);
  expect(readDatabaseFile(sqlite, join(d, "flowly.sqlite")).automation).toEqual(original.automation);

  await store.mutate((b) => {
    const child = b.automation.find((j) => j.taskId === "child")!;
    child.state = "delivered";
    child.verdict = "approved";
    b.automation = b.automation.filter((j) => j.taskId !== "other");
    b.handoffIndex[0]!.fresh = true;
  });
  const written = readDatabaseFile(sqlite, join(d, "flowly.sqlite"));
  expect(written.automation.map((j) => [j.taskId, j.state, j.verdict])).toEqual([["parent", "waiting", undefined], ["child", "delivered", "approved"]]);
  expect(written.handoffIndex[0]!.fresh).toBe(true);
  expect(written.automation.find((j) => j.taskId === "child")!.risks).toEqual(original.automation[1]!.risks);

  // A transaction that changes nothing writes nothing (SESSION-HANDOFF-SPEC idle writes), with SQLite too.
  const revision = (await store.read()).revision;
  await store.transaction(() => ({ value: null, changed: false }));
  expect((await store.read()).revision).toBe(revision);
});

test("the overview carries the fork's collections, and a patch sends only the jobs and entries that changed", () => {
  const board = fixture();
  const view = boardOverview(board);
  expect(view.automation).toEqual(board.automation);
  expect(view.handoffIndex).toEqual(board.handoffIndex);
  const deltas = new OverviewDeltas();
  const first = deltas.read(view, {});
  const next = structuredClone(board);
  next.automation[0]!.state = "working";
  next.automation = next.automation.filter((j) => j.taskId !== "other");
  next.handoffIndex[0]!.open = 0;
  const patch = deltas.read(boardOverview(next), { etag: first.etag }).patch!;
  expect(patch.automation).toEqual({ set: [next.automation[0]], remove: ["other"] });
  expect(patch.handoffIndex).toEqual({ set: [next.handoffIndex[0]], remove: [] });
  expect(patch.tasks).toBeUndefined();
});

test("a card's detail carries its own job, its related cards' jobs and its handoff entry", () => {
  const board = fixture();
  const detail = cardDetail(board, { taskId: "child", workspaceId: "w-child" });
  expect(detail.automation.map((j) => j.taskId).sort()).toEqual(["child", "parent"]);
  expect(detail.handoffIndex).toEqual(board.handoffIndex);
  expect(cardDetail(board, { taskId: "other", workspaceId: "w-other" }).automation.map((j) => j.taskId)).toEqual(["other"]);
});

test("Attention from overview facts includes automation that waits for a person, and a failed job a person took back drops out", () => {
  const board = fixture();
  const view = boardOverview(board);
  const items = attentionItemsWithFacts(view, [], [], false, () => undefined);
  expect(items.map((i) => [i.task.id, i.automation])).toEqual([["other", true]]);
  const failed = structuredClone(board);
  failed.automation[2] = job("other", { state: "failed", implementerId: "impl-3", updatedAt: at });
  expect(attentionItemsWithFacts(boardOverview(failed), [], [], false, () => undefined).map((i) => i.task.id)).toEqual(["other"]);
  failed.automation[2] = { ...failed.automation[2]!, takenBack: true };
  expect(attentionItemsWithFacts(boardOverview(failed), [], [], false, () => undefined)).toEqual([]);
});

test("telemetry is off until the user turns it on (fork decision)", () => {
  expect(telemetrySettingsValues({}).enabled).toBe(false);
  expect(telemetrySettingsValues(null).enabled).toBe(false);
  expect(telemetrySettingsValues({ enabled: true }).enabled).toBe(true);
});
