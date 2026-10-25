import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { captureHandoff } from "./handoff-capture";
import { HandoffObserver, type HandoffObserverDeps, type ManagedHandoffSession } from "./handoff-observer";
import { HandoffService } from "./handoff-service";
import { HandoffStore } from "./handoff-store";
import { forgetHistory } from "./provider-history";
import { BoardStore } from "./store";
import type { AutomationJob } from "../shared/automation-schema";

// Never reaches a daemon or a real provider history: the Paseo API is an in-memory fake; the board, the synthetic Codex and
// Claude homes and the Git repositories live in a temporary directory.
const run = promisify(execFile);
const roots: string[] = [], observers: HandoffObserver[] = [];
afterEach(async () => {
  forgetHistory();
  await Promise.all(observers.splice(0).map((observer) => observer.stop()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const at = "2026-10-25T02:00:00.000Z";
const line = (value: unknown) => JSON.stringify(value) + "\n";
const uuid = (n: number) => `019a15e5-0000-7abc-8def-${String(n).padStart(12, "0")}`;
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
async function repository(path: string, dirty = false) {
  await mkdir(path, { recursive: true }); await git(path, "init", "-q"); await writeFile(join(path, "README.md"), "fixture\n");
  await git(path, "add", "README.md"); await git(path, "commit", "-q", "-m", "fixture");
  if (dirty) await writeFile(join(path, "README.md"), "fixture, edited and not committed\n");
}
/** Every byte Flowly owns in the data directory (board.json, handoff records, archives, receipts), by path. */
async function bytes(directory: string) {
  const out: Record<string, string> = {};
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (["homes", "repos"].includes(relative(directory, child))) continue;
      if (entry.isDirectory()) await walk(child); else out[relative(directory, child)] = createHash("sha256").update(await readFile(child)).digest("hex");
    }
  };
  await walk(directory); return out;
}

/**
 * Several idle cards on real files: Codex and Claude sessions whose provider files no longer grow, a stopped job with a
 * replaced session, a card whose workspace cannot be read (its Git observation fails), a project root with more
 * repositories than are inspected, and a session that is gone.
 */
async function idleBoard() {
  const directory = await mkdtemp(join(tmpdir(), "flowly-handoff-idle-")); roots.push(directory);
  const repos = join(directory, "repos"), homes = join(directory, "homes"), codexHome = join(homes, "codex"), claudeHome = join(homes, "claude");
  const alpha = join(repos, "alpha"), wide = join(repos, "wide");
  await repository(join(alpha, "app")); await repository(join(alpha, "lib"), true); await mkdir(join(alpha, "notes"), { recursive: true });
  for (let n = 0; n < 10; n++) await repository(join(wide, `service-${n}`));
  let now = Date.parse(at);
  const board = new BoardStore(directory);
  const job = (taskId: string, state: AutomationJob["state"], implementerId: string, extra: Partial<AutomationJob> = {}): AutomationJob => ({ taskId, projectId: "project", state, role: "implementer", implementerId, generation: 1, nudges: 0, failures: 0, reviewRounds: 1, queuedAt: at, updatedAt: at, ...extra } as AutomationJob);
  await board.mutate((value) => {
    value.projects.push({ id: "project", title: "P", description: "", paseoProjectId: "native", primaryPath: alpha, repos: [alpha, wide, join(repos, "beta")], revision: 1, createdAt: at, updatedAt: at, archivedAt: null });
    const card = (id: string, workspaceId: string, repoPaths: string[]) => ({ id, projectId: "project", workspaceId, sourcePath: repoPaths[0], repoPaths, title: id, description: "", status: "in_review" as const, priority: "normal" as const, position: 0, revision: 1, operationId: `create-${id}`, createdAt: at, updatedAt: at, archivedAt: null });
    value.tasks.push(card("alpha", "ws-alpha", [alpha]), card("beta", "ws-beta", [join(repos, "beta")]), card("gamma", "ws-gamma", [wide]));
    value.automation.push(job("alpha", "delivered", "a-impl", { reviewerId: "a-rev", verdict: "approved" }), job("beta", "stopped", "b-impl", { retired: [{ agentId: "b-old", role: "implementer", at, reason: "run_again" }] }));
  });
  const sessions = [
    { taskId: "alpha", agentId: "a-impl", provider: "codex", n: 1, workspace: "ws-alpha", cwd: alpha },
    { taskId: "alpha", agentId: "a-rev", provider: "claude", n: 2, workspace: "ws-alpha", cwd: alpha },
    { taskId: "beta", agentId: "b-old", provider: "codex", n: 3, workspace: "ws-beta", cwd: repos },
    { taskId: "beta", agentId: "b-impl", provider: "claude", n: 4, workspace: "ws-beta", cwd: repos },
    { taskId: "gamma", agentId: "g-man", provider: "codex", n: 5, workspace: "ws-gamma", cwd: wide },
    { taskId: "gamma", agentId: "g-gone", provider: "claude", n: 6, workspace: "ws-gamma", cwd: wide },
  ] as const;
  const actors = new Map<string, Record<string, unknown>>();
  for (const s of sessions) {
    const id = uuid(s.n);
    if (s.provider === "codex") {
      const folder = join(codexHome, "sessions", "2025", "10", "28"); await mkdir(folder, { recursive: true });
      const event = (type: string, data: Record<string, unknown>) => ({ timestamp: at, type: "event_msg", payload: { type, ...data } });
      await writeFile(join(folder, `rollout-idle-${id}.jsonl`), [
        { timestamp: at, type: "session_meta", payload: { id, session_id: id, cwd: s.cwd } },
        event("item_completed", { thread_id: id, turn_id: "t1", item: { type: "UserMessage", id: `u-${s.n}`, content: [{ type: "text", text: `Fix card ${s.taskId}` }] } }),
        { timestamp: at, type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: `c-${s.n}`, arguments: JSON.stringify({ cmd: "npm test" }) } },
        { timestamp: at, type: "response_item", payload: { type: "function_call_output", call_id: `c-${s.n}`, output: "Process exited with code 0\nOutput:\nok" } },
        event("token_count", { info: { last_token_usage: { total_tokens: 41_000 }, model_context_window: 258_400 } }),
        event("item_completed", { thread_id: id, turn_id: "t1", item: { type: "AgentMessage", id: `m-${s.n}`, content: [{ type: "Text", text: `Card ${s.taskId}: tests pass; delivered.` }] } }),
        event("task_complete", { last_agent_message: `Card ${s.taskId}: tests pass; delivered.` }),
      ].map(line).join(""));
    } else if (s.agentId !== "g-gone") {
      const folder = join(claudeHome, "projects", "idle"); await mkdir(folder, { recursive: true });
      const base = { sessionId: id, entrypoint: "sdk-cli", isSidechain: false, timestamp: at, userType: "external", cwd: s.cwd, version: "2.9.0" };
      await writeFile(join(folder, `${id}.jsonl`), [
        { ...base, type: "user", uuid: `u-${s.n}`, message: { role: "user", content: `Review card ${s.taskId}` } },
        { ...base, type: "assistant", uuid: `a-${s.n}`, message: { id: `r-${s.n}`, role: "assistant", content: [{ type: "text", text: "Approved: the criteria are met." }], usage: { input_tokens: 10, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 30_000, output_tokens: 400, cache_creation: { ephemeral_1h_input_tokens: 2_000 } } } },
      ].map(line).join(""));
    }
    if (s.agentId !== "g-gone") actors.set(s.agentId, { id: s.agentId, provider: s.provider, model: `${s.provider}-fixture`, cwd: s.cwd, workspaceId: s.workspace, status: "idle", activeTurn: null, pendingPermissions: [], createdAt: at, updatedAt: at, lastUserMessageAt: at, lastUsage: { contextWindowUsedTokens: 41_000, contextWindowMaxTokens: 258_400 }, persistence: { provider: s.provider, nativeHandle: id, sessionId: id }, archivedAt: null });
  }
  const workspaces: Record<string, { workspaceDirectory: string; workspaceKind: string } | Error> = { "ws-alpha": { workspaceDirectory: alpha, workspaceKind: "local" }, "ws-beta": new Error("workspace unavailable"), "ws-gamma": { workspaceDirectory: wide, workspaceKind: "local" } };
  const paseo = {
    agents: { ref: (agentId: string) => ({ refresh: async () => actors.has(agentId) ? { agent: actors.get(agentId) } : null, timeline: { refetch: () => { throw new Error("idle observation must never load a timeline"); } }, send: () => { throw new Error("idle observation must never send"); } }) },
    workspaces: { ref: (workspaceId: string) => ({ refresh: async () => { const value = workspaces[workspaceId]; if (value instanceof Error) throw value; return value ?? null; } }) },
  } as unknown as PaseoApi;
  // Production wiring (index.server.ts): the service's mutex and index sync; only the provider homes are redirected.
  const wire = () => {
    const handoffs = new HandoffService(board, () => now); handoffs.attach(paseo);
    const deps: HandoffObserverDeps = { records: handoffs.records, board, paseo: () => paseo, serial: handoffs.serial.bind(handoffs), syncIndex: handoffs.syncIndex.bind(handoffs), onCompaction: (taskId, agentId) => handoffs.forgetRead(taskId, agentId), clock: () => now,
      capture: (agent, previous, options) => captureHandoff(agent, previous, { ...options, codexHome, claudeHome }) };
    const observer = new HandoffObserver(deps); observers.push(observer);
    return { handoffs, observer };
  };
  const managed = async (): Promise<ManagedHandoffSession[]> => sessions.map(({ taskId, agentId }) => ({ taskId, agentId }));
  return { directory, board, sessions, wire, managed, advance: (ms: number) => { now += ms; } };
}

test("idle cards keep their revision and every file byte through the whole idle loop and a plugin reload", async () => {
  const x = await idleBoard();
  let { handoffs, observer } = x.wire();
  // Warm-up: each session's last turn (start registration, end hook with its timeline), then passes that read the provider files.
  for (const s of x.sessions) {
    await observer.ensureSession(s.taskId, s.agentId);
    await observer.observe(s.taskId, s.agentId, { timeline: [{ type: "user_message", text: `Fix card ${s.taskId}`, messageId: `m-${s.agentId}` }, { type: "assistant_message", text: `Card ${s.taskId}: tests pass; delivered.` }], outcome: "completed", forceGit: true });
  }
  for (let minute = 0; minute < 5; minute++) { x.advance(60_000); await observer.poll(x.managed); }
  // A real idle state also has acknowledged Flowly gaps pushed out of the 40-entry current list into the archive.
  const beta = await handoffs.records.read("beta", "project"), unavailable = beta.gaps.find((gap) => gap.sourceId === "git-unavailable:beta");
  expect(unavailable).toBeTruthy();
  await handoffs.records.update("beta", "project", { handoffRevision: beta.revision, gaps: [{ id: unavailable!.id, status: "closed", note: "Checked by hand: the workspace folder was archived." }] }, { by: { kind: "human" } });
  for (let batch = 0; batch < 5; batch++) {
    const record = await handoffs.records.read("beta", "project");
    await handoffs.records.update("beta", "project", { handoffRevision: record.revision, gaps: Array.from({ length: 9 }, (_, n) => ({ text: `Successor question ${batch}.${n}`, status: "open" as const })) }, { by: { kind: "agent", agentId: "b-impl" } });
  }
  expect((await handoffs.records.read("beta", "project")).gaps.some((gap) => gap.sourceId === "git-unavailable:beta")).toBe(false);
  for (const s of x.sessions) await handoffs.syncIndex(s.taskId);

  const before = await bytes(x.directory), revisions = await Promise.all(["alpha", "beta", "gamma"].map(async (id) => (await handoffs.records.read(id, "project")).revision));
  for (let minute = 1; minute <= 30; minute++) {
    if (minute === 15) { await observer.stop(); ({ handoffs, observer } = x.wire()); } // Plugin reload: in-memory state (Git timers, reads) is gone.
    x.advance(60_000); await observer.poll(x.managed);
    if (minute % 2) continue;
    for (const s of x.sessions) {
      await observer.ensureSession(s.taskId, s.agentId);
      await handoffs.syncIndex(s.taskId);
      await handoffs.context(s.taskId, s.agentId, { recordAccess: false }); // handoffDue on every Flowly tool result
      await handoffs.context(s.taskId); // the drawer's etag read
    }
  }
  expect(await Promise.all(["alpha", "beta", "gamma"].map(async (id) => (await handoffs.records.read(id, "project")).revision))).toEqual(revisions);
  expect(await bytes(x.directory)).toEqual(before);
  // An ACK the successor prepared from the revision it read before all that idle time still applies.
  await expect(handoffs.records.update("alpha", "project", { handoffRevision: revisions[0], ack: { handoffRevision: revisions[0], heads: [], understanding: "Idle card, nothing new.", items: [] } }, { by: { kind: "agent", agentId: "a-impl" } }, { agentId: "a-impl", actualHeads: [] })).resolves.toMatchObject({ handoffRevision: revisions[0] + 1 });
}, 60_000);

test("a transaction that changes nothing writes nothing: no revision, no receipt, no bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowly-handoff-noop-")); roots.push(directory);
  const store = new HandoffStore(directory), flowly = { by: { kind: "flowly" as const } };
  const session = { agentId: "worker", n: 1, role: "implementer" as const, provider: "codex", reason: "launch", startedAt: at, finalized: false, turns: [], background: [], live: [] };
  await store.setSession("card", "project", session, { ...flowly, sourceId: "session:worker" });
  await store.appendNote("card", "project", { kind: "background", text: "Async shell finished" }, { ...flowly, sourceId: "capture-notice:worker:one" });
  await store.appendInput("card", "project", { text: "Keep the old column", via: "comment", atSource: "typed", status: "open", messageId: "comment:op" }, { by: { kind: "human" }, sourceId: "comment:op", operationId: "comment:op", unconfirmed: true });
  await store.confirmSource("card", "project", "comment:op", { ...flowly, operationId: "confirm:comment:op" });
  // 40 newer gaps push the closed one out of the current list into the archive; observing it again must find it there.
  const unavailable = { id: "g:git-unavailable", sourceId: "git-unavailable:card", kind: "flowly", agentId: "worker", text: "Repository state could not be observed.", status: "open" };
  await store.capture("card", "project", { entries: [{ section: "gaps", value: unavailable }] }, flowly);
  const gap = (await store.read("card", "project")).gaps[0];
  await store.update("card", "project", { handoffRevision: (await store.read("card", "project")).revision, gaps: [{ id: gap.id, status: "closed", note: "Verified by hand." }] }, flowly);
  for (let n = 0; n < 5; n++) await store.update("card", "project", { handoffRevision: (await store.read("card", "project")).revision, gaps: Array.from({ length: 9 }, (_, k) => ({ text: `Open question ${n}.${k}`, status: "open" as const })) }, flowly);
  const archived = await store.read("card", "project");
  expect(archived.gaps.some((value) => value.id === gap.id)).toBe(false);
  const before = await bytes(directory);
  const repeats = [
    () => store.setSession("card", "project", session, { ...flowly, sourceId: "session:worker" }),
    () => store.appendNote("card", "project", { kind: "background", text: "Async shell finished" }, { ...flowly, sourceId: "capture-notice:worker:one" }),
    () => store.confirmSource("card", "project", "comment:op", { ...flowly, operationId: "confirm:comment:op:again" }),
    () => store.capture("card", "project", { entries: [{ section: "gaps", value: unavailable }], git: [] }, flowly),
    () => store.capture("card", "project", { forgetSeen: ["never-read"] }, flowly),
    () => store.update("card", "project", { handoffRevision: archived.revision }, { by: { kind: "agent", agentId: "worker" } }),
  ];
  for (const repeat of repeats) expect((await repeat()).handoffRevision).toBe(archived.revision);
  expect(await bytes(directory)).toEqual(before);
  // A real change still writes.
  expect((await store.appendNote("card", "project", { kind: "other", text: "New fact" }, flowly)).handoffRevision).toBe(archived.revision + 1);
});
