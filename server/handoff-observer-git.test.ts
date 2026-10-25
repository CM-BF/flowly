import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { captureHandoff } from "./handoff-capture";
import { HandoffObserver } from "./handoff-observer";
import { HandoffService } from "./handoff-service";
import { forgetHistory } from "./provider-history";
import { BoardStore } from "./store";
import { fixtureAt, fixtureUuid, jsonLine } from "./handoff-observer-fixture";

// When the observer reads a card's repositories. Never reaches a daemon or Git: the Paseo API is an in-memory fake, the Git
// read is a seam that counts its calls, and the board and the synthetic Codex home live in a temporary directory.
const roots: string[] = [], observers: HandoffObserver[] = [];
afterEach(async () => { forgetHistory(); await Promise.all(observers.splice(0).map((o) => o.stop())); await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const sha = (c: string) => c.repeat(40);

async function card() {
  const directory = await mkdtemp(join(tmpdir(), "flowly-observer-git-")); roots.push(directory);
  const board = new BoardStore(directory), home = join(directory, "synthetic-codex");
  await board.mutate((value) => {
    value.projects.push({ id: "project", title: "P", description: "", paseoProjectId: "native", primaryPath: directory, repos: [directory], revision: 1, createdAt: fixtureAt, updatedAt: fixtureAt, archivedAt: null });
    value.tasks.push({ id: "card", projectId: "project", workspaceId: "workspace", sourcePath: directory, repoPaths: [], title: "Card", description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: "create", createdAt: fixtureAt, updatedAt: fixtureAt, archivedAt: null });
  });
  const stamp = new Date(parseInt(fixtureUuid.replace(/-/g, "").slice(0, 12), 16));
  const folder = join(home, "sessions", String(stamp.getFullYear()), String(stamp.getMonth() + 1).padStart(2, "0"), String(stamp.getDate()).padStart(2, "0"));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `rollout-fixture-${fixtureUuid}.jsonl`), jsonLine({ timestamp: fixtureAt, type: "session_meta", payload: { id: fixtureUuid, session_id: fixtureUuid, cwd: directory } }));
  const actor: Record<string, unknown> = { id: "worker", provider: "codex", model: "codex-fixture", cwd: directory, workspaceId: "workspace", status: "running", activeTurn: { turnId: "t1", startedAt: fixtureAt }, pendingPermissions: [], createdAt: fixtureAt, updatedAt: fixtureAt, lastUserMessageAt: fixtureAt, persistence: { provider: "codex", nativeHandle: fixtureUuid, sessionId: fixtureUuid }, archivedAt: null };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: actor }) }) }, workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: directory, workspaceKind: "local" }) }) } } as unknown as PaseoApi;
  const state = { now: Date.parse(fixtureAt), sha: sha("a"), failing: false, reads: 0 };
  const handoffs = new HandoffService(board, () => state.now); handoffs.attach(paseo);
  const observe = () => {
    const observer = new HandoffObserver({ records: handoffs.records, board, paseo: () => paseo, serial: handoffs.serial.bind(handoffs), syncIndex: handoffs.syncIndex.bind(handoffs), clock: () => state.now,
      capture: (agent, previous, o) => captureHandoff(agent, previous, { ...o, codexHome: home, claudeHome: join(directory, "unused-claude") }),
      git: async (_taskId, _board, at) => { state.reads++; if (state.failing) throw new Error("git: not a repository"); return { snapshots: [{ repo: directory, sha: state.sha, branch: "main", dirty: false, at }], unchecked: [] }; } });
    observers.push(observer); return observer;
  };
  let observer = observe();
  const read = () => handoffs.records.read("card", "project");
  const idle = () => Object.assign(actor, { status: "idle", activeTurn: null });
  return { handoffs, state, read, idle, actor, get observer() { return observer; }, reload: async () => { await observer.stop(); observer = observe(); },
    poll: async (minutes = 1) => { state.now += minutes * 60_000; await observer.observe("card", "worker"); },
    hook: () => observer.observe("card", "worker", { timeline: [{ type: "assistant_message", text: "Done." }], outcome: "completed", forceGit: true }) };
}

test("a turn end seen only by a poll (its hook never came) reads the repositories once; the turn keeps its start time", async () => {
  const c = await card();
  await c.poll(); // in the turn
  expect((await c.read()).git.map((entry) => entry.sha)).toEqual([sha("a")]);
  c.state.sha = sha("b"); // the agent commits in its last minute; the turn ends and its hook is lost (reload, restart)
  c.idle();
  await c.poll();
  expect((await c.read()).git.map((entry) => entry.sha)).toEqual([sha("b")]);
  const reads = c.state.reads, revision = (await c.read()).revision;
  // Idle from here on: no more reads, nothing written, also after a plugin reload (at most one read for the lost turn end).
  for (let minute = 0; minute < 10; minute++) await c.poll();
  expect(c.state.reads).toBe(reads);
  await c.reload();
  for (let minute = 0; minute < 10; minute++) await c.poll();
  expect(c.state.reads).toBeLessThanOrEqual(reads + 1);
  expect((await c.read()).revision).toBe(revision);
  // A hook that arrives after a poll saw the turn end still records the turn from its observed start.
  await c.hook();
  expect((await c.read()).ledger[0].turns.at(-1)).toMatchObject({ startedAt: fixtureAt, outcome: "completed" });
});

test("Git unreadable again after its gap was closed is on the card again: the snapshot says so and the card is due", async () => {
  const c = await card();
  c.state.failing = true;
  await c.poll();
  const first = await c.read(), gap = first.gaps.find((entry) => entry.sourceId === "git-unavailable:card")!;
  expect(gap.status).toBe("open");
  expect(first.git).toEqual([expect.objectContaining({ sha: null, error: expect.stringContaining("could not be observed") })]);
  await c.handoffs.records.update("card", "project", { handoffRevision: first.revision, gaps: [{ id: gap.id, status: "closed", note: "Checked: the worktree was being recreated." }] }, { by: { kind: "human" } });
  c.state.failing = false; await c.poll(3);
  expect((await c.read()).git).toEqual([expect.objectContaining({ sha: sha("a") })]);
  expect((await c.read()).git[0].error).toBeUndefined();
  c.state.failing = true; await c.poll(3);
  const later = await c.read();
  expect(later.git).toEqual([expect.objectContaining({ sha: sha("a"), error: expect.stringContaining("could not be observed") })]);
  expect((await c.handoffs.context("card")).due).toContain("Some repository state could not be verified.");
  // Failing again changes nothing more.
  await c.poll(3); await c.poll(3);
  expect((await c.read()).revision).toBe(later.revision);
});

test("an idle card whose last Git read failed is read again within 2 minutes, and not after it succeeded", async () => {
  const c = await card();
  c.idle();
  c.state.failing = true;
  await c.hook(); // the turn end's read fails
  expect((await c.read()).git[0]?.error).toContain("could not be observed");
  c.state.failing = false;
  await c.poll(); await c.poll(); await c.poll();
  const healed = await c.read();
  expect(healed.git).toEqual([expect.objectContaining({ sha: sha("a") })]);
  expect(healed.git[0].error).toBeUndefined();
  const reads = c.state.reads;
  for (let minute = 0; minute < 10; minute++) await c.poll();
  expect(c.state.reads).toBe(reads);
});
