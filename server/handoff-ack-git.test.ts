import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { captureHandoff } from "./handoff-capture";
import { handoffGitSnapshot } from "./handoff-git";
import { HandoffObserver } from "./handoff-observer";
import { HandoffService } from "./handoff-service";
import { forgetHistory } from "./provider-history";
import { BoardStore } from "./store";

// The successor's ACK goes through flowly_update_handoff (HandoffService.update), which reads the heads itself. Never reaches
// a daemon: the Paseo API is an in-memory fake; the board, the synthetic Codex home and the Git repository are temporary.
const run = promisify(execFile);
const roots: string[] = [], observers: HandoffObserver[] = [];
afterEach(async () => { forgetHistory(); await Promise.all(observers.splice(0).map((o) => o.stop())); await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const at = "2026-10-25T02:00:00.000Z", uuid = "019a15e5-0000-7abc-8def-000000000001";
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const identity = { taskId: "alpha", workspaceId: "ws-alpha", agentId: "a-impl" };

async function idleCard() {
  const directory = await mkdtemp(join(tmpdir(), "flowly-ack-git-")); roots.push(directory);
  const repo = join(directory, "repos", "shared"), codexHome = join(directory, "homes", "codex");
  await mkdir(repo, { recursive: true }); await git(repo, "init", "-q"); await writeFile(join(repo, "README.md"), "x\n"); await git(repo, "add", "."); await git(repo, "commit", "-q", "-m", "one");
  let now = Date.parse(at);
  const board = new BoardStore(directory);
  await board.mutate((value) => {
    value.projects.push({ id: "project", title: "P", description: "", paseoProjectId: "native", primaryPath: repo, repos: [repo], revision: 1, createdAt: at, updatedAt: at, archivedAt: null });
    value.tasks.push({ id: "alpha", projectId: "project", workspaceId: "ws-alpha", sourcePath: repo, repoPaths: [repo], title: "alpha", description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: "create", createdAt: at, updatedAt: at, archivedAt: null });
  });
  // The rollout's day folder follows from the session's UUID v7 time, as the locator searches it.
  const stamp = new Date(parseInt(uuid.replace(/-/g, "").slice(0, 12), 16));
  const folder = join(codexHome, "sessions", String(stamp.getFullYear()), String(stamp.getMonth() + 1).padStart(2, "0"), String(stamp.getDate()).padStart(2, "0"));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `rollout-ack-${uuid}.jsonl`), JSON.stringify({ timestamp: at, type: "session_meta", payload: { id: uuid, session_id: uuid, cwd: repo } }) + "\n");
  const actor = { id: "a-impl", provider: "codex", model: "codex-fixture", cwd: repo, workspaceId: "ws-alpha", status: "idle", activeTurn: null, pendingPermissions: [], createdAt: at, updatedAt: at, lastUserMessageAt: at, persistence: { provider: "codex", nativeHandle: uuid, sessionId: uuid }, archivedAt: null };
  const paseo = {
    agents: { ref: () => ({ refresh: async () => ({ agent: actor }) }) },
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: repo, workspaceKind: "local" }) }) },
  } as unknown as PaseoApi;
  const handoffs = new HandoffService(board, () => now); handoffs.attach(paseo);
  const observer = new HandoffObserver({ records: handoffs.records, board, paseo: () => paseo, serial: handoffs.serial.bind(handoffs), syncIndex: handoffs.syncIndex.bind(handoffs), clock: () => now,
    capture: (agent, previous, options) => captureHandoff(agent, previous, { ...options, codexHome, claudeHome: join(directory, "homes", "claude") }) });
  observers.push(observer);
  await observer.ensureSession("alpha", "a-impl");
  await observer.observe("alpha", "a-impl", { timeline: [{ type: "assistant_message", text: "Done." }], outcome: "completed", forceGit: true }); // the last turn end
  // Another card commits in the shared root; this card stays idle for 10 minutes of observer passes.
  await writeFile(join(repo, "OTHER.md"), "other card\n"); await git(repo, "add", "."); await git(repo, "commit", "-q", "-m", "other card");
  for (let minute = 1; minute <= 10; minute++) { now += 60_000; await observer.poll(async () => [{ taskId: "alpha", agentId: "a-impl" }]); }
  const read = () => handoffs.records.read("alpha", "project");
  const heads = async () => { const head = await handoffGitSnapshot(repo); return [{ repo: head.repo, sha: head.sha, dirty: head.dirty }]; };
  return { repo, handoffs, read, heads };
}

test("an ACK prepared on an idle card applies through flowly_update_handoff after another card committed in the shared root", async () => {
  const x = await idleCard();
  const prepared = await x.read(), heads = await x.heads();
  expect(prepared.git.map((entry) => entry.sha)).not.toEqual(heads.map((head) => head.sha)); // the card's Git is behind the repository
  const result = await x.handoffs.update(identity, { handoffRevision: prepared.revision, ack: { handoffRevision: prepared.revision, heads, understanding: "Idle card; HEAD verified.", items: [] } });
  // One write: Flowly's own Git refresh and the ACK land in the same revision, and the card now holds the observed heads.
  expect(result).toMatchObject({ ok: true, handoffRevision: prepared.revision + 1 });
  const after = await x.read();
  expect(after.git.map((entry) => entry.sha)).toEqual(heads.map((head) => head.sha));
  expect(after.ledger.find((session) => session.agentId === "a-impl")?.ack).toMatchObject({ handoffRevision: prepared.revision, complete: true });
});

test("a refused ACK still records the heads Flowly read, so the successor's reread shows them", async () => {
  const x = await idleCard();
  const prepared = await x.read(), heads = await x.heads();
  const wrong = heads.map((head) => ({ ...head, sha: "0".repeat(40) }));
  await expect(x.handoffs.update(identity, { handoffRevision: prepared.revision, ack: { handoffRevision: prepared.revision, heads: wrong, understanding: "Stale view.", items: [] } })).rejects.toMatchObject({ code: "ACK_MISMATCH" });
  const reread = await x.read();
  expect(reread.git.map((entry) => entry.sha)).toEqual(heads.map((head) => head.sha));
  // The reread revision then applies.
  await expect(x.handoffs.update(identity, { handoffRevision: reread.revision, ack: { handoffRevision: reread.revision, heads, understanding: "Reread; HEAD verified.", items: [] } })).resolves.toMatchObject({ ok: true });
});
