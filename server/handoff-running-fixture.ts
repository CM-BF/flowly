import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { captureHandoff } from "./handoff-capture";
import { handoffGitSnapshot } from "./handoff-git";
import { HandoffObserver, type ManagedHandoffSession } from "./handoff-observer";
import { HandoffService } from "./handoff-service";
import { forgetHistory } from "./provider-history";
import { BoardStore } from "./store";
import type { AutomationJob } from "../shared/automation-schema";

// Test fixture only; runtime entries never import this module. A card handed over, observed with the production wiring
// (index.server.ts): HandoffService with its mutex and index sync, HandoffObserver, real captureHandoff on synthetic Codex
// rollouts and a real Git repository. Never reaches a daemon or a real provider history: the Paseo API is an in-memory
// fake; the board, the synthetic Codex home and the repository live in a temporary directory.
const run = promisify(execFile);
const roots: string[] = [], observers: HandoffObserver[] = [];
export async function cleanupRunningFixtures() { forgetHistory(); await Promise.all(observers.splice(0).map((observer) => observer.stop())); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); }
const at = "2026-10-25T02:00:00.000Z";
const line = (value: unknown) => JSON.stringify(value) + "\n";
const uuid = (n: number) => `019a15e5-0000-7abc-8def-${String(n).padStart(12, "0")}`;
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

/**
 * The sealed predecessor `pred` left a long record (`notes` notes of about 1.9 KB, so the full read has several pages, and
 * two open gaps); the successor `succ` is in its first turn. `minute()` is one 60-second pass of the observer.
 */
export async function handedOver(options: { notes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "flowly-running-")); roots.push(directory);
  const repo = join(directory, "repos", "shared"), codexHome = join(directory, "homes", "codex");
  await mkdir(repo, { recursive: true }); await git(repo, "init", "-q"); await writeFile(join(repo, "README.md"), "x\n"); await git(repo, "add", "README.md"); await git(repo, "commit", "-q", "-m", "x");
  let now = Date.parse(at);
  const board = new BoardStore(directory);
  await board.mutate((value) => {
    value.projects.push({ id: "project", title: "P", description: "", paseoProjectId: "native", primaryPath: repo, repos: [repo], revision: 1, createdAt: at, updatedAt: at, archivedAt: null, automation: { enabled: true } } as never);
    value.tasks.push({ id: "card", projectId: "project", workspaceId: "ws", sourcePath: repo, repoPaths: [repo], title: "card", description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: "create-card", createdAt: at, updatedAt: at, archivedAt: null });
    value.automation.push({ taskId: "card", projectId: "project", state: "working", role: "implementer", implementerId: "succ", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: at, updatedAt: at, retired: [{ agentId: "pred", role: "implementer", at, reason: "run_again" }] } as unknown as AutomationJob);
  });
  const rollouts = new Map<string, string>(), actors = new Map<string, Record<string, unknown>>();
  for (const [agentId, n] of [["pred", 1], ["succ", 2]] as const) {
    const id = uuid(n), stamp = new Date(parseInt(id.replace(/-/g, "").slice(0, 12), 16));
    const folder = join(codexHome, "sessions", String(stamp.getFullYear()), String(stamp.getMonth() + 1).padStart(2, "0"), String(stamp.getDate()).padStart(2, "0")); await mkdir(folder, { recursive: true });
    const path = join(folder, `rollout-running-${id}.jsonl`); rollouts.set(agentId, path);
    await writeFile(path, [{ timestamp: at, type: "session_meta", payload: { id, session_id: id, cwd: repo } }, { timestamp: at, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 40_000 }, model_context_window: 258_400 } } }].map(line).join(""));
    const running = agentId === "succ";
    actors.set(agentId, { id: agentId, provider: "codex", model: "codex-fixture", cwd: repo, workspaceId: "ws", status: running ? "running" : "idle", activeTurn: running ? { turnId: "succ-turn-1", startedAt: at } : null, pendingPermissions: [], createdAt: at, updatedAt: at, lastUserMessageAt: at, persistence: { provider: "codex", nativeHandle: id, sessionId: id }, archivedAt: null });
  }
  const paseo = {
    agents: { ref: (agentId: string) => ({ refresh: async () => actors.has(agentId) ? { agent: actors.get(agentId) } : null }) },
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: repo, workspaceKind: "local" }) }) },
  } as unknown as PaseoApi;
  const handoffs = new HandoffService(board, () => now); handoffs.attach(paseo);
  const observer = new HandoffObserver({ records: handoffs.records, board, paseo: () => paseo, serial: handoffs.serial.bind(handoffs), syncIndex: handoffs.syncIndex.bind(handoffs), onCompaction: (taskId, agentId) => handoffs.forgetRead(taskId, agentId), clock: () => now,
    capture: (agent, previous, o) => captureHandoff(agent, previous, { ...o, codexHome }) });
  observers.push(observer);
  for (const agentId of ["pred", "succ"]) await observer.ensureSession("card", agentId);
  for (let n = 0; n < (options.notes ?? 70); n++) await handoffs.records.appendNote("card", "project", { kind: n % 2 ? "background" : "hazard", text: `Note ${n}: ${"the predecessor found this and wrote it down; ".repeat(42)}`.slice(0, 1900) }, { by: { kind: "flowly" }, sourceId: `fixture-note:${n}` });
  for (const [n, text] of [[1, "The predecessor's last turn was not captured."], [2, "One repository was not inspected."]] as const) await handoffs.records.appendGap("card", "project", { kind: "flowly", text, status: "open" }, { by: { kind: "flowly" }, sourceId: `fixture-gap:${n}` });
  const managed = async (): Promise<ManagedHandoffSession[]> => [{ taskId: "card", agentId: "pred" }, { taskId: "card", agentId: "succ" }];
  const minute = async () => { now += 60_000; await observer.poll(managed); };
  for (let n = 0; n < 3; n++) await minute();
  let calls = 0, turns = 1;
  /** Records appended to the successor's rollout as Codex writes them. */
  const raw = async (records: unknown[]) => appendFile(rollouts.get("succ")!, records.map(line).join(""));
  /** One tool call in the successor's rollout: the call, its output (none while it runs) and the new context size. Returns the call id. */
  const tool = async (name: string, args: unknown, output?: string) => {
    calls++;
    const stamp = new Date(now).toISOString();
    await raw([{ timestamp: stamp, type: "response_item", payload: { type: "function_call", name, call_id: `succ-call-${calls}`, arguments: JSON.stringify(args) } },
      ...(output === undefined ? [] : [{ timestamp: stamp, type: "response_item", payload: { type: "function_call_output", call_id: `succ-call-${calls}`, output } }]),
      { timestamp: stamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 40_000 + calls * 9_000 }, model_context_window: 258_400 } } }]);
    return `succ-call-${calls}`;
  };
  /** The successor's turn ends (Paseo reports it idle) or a new one starts. */
  const turn = (running: boolean) => { const actor = actors.get("succ")!; actor.status = running ? "running" : "idle"; actor.activeTurn = running ? { turnId: `succ-turn-${++turns}`, startedAt: new Date(now).toISOString() } : null; };
  /** Another card's commit in the shared project root. */
  const elsewhere = async (n: number) => { await writeFile(join(repo, `other-${n}.md`), "another card\n"); await git(repo, "add", "."); await git(repo, "commit", "-q", "-m", `other ${n}`); };
  const heads = async () => [await handoffGitSnapshot(repo)].map(({ repo: path, sha, dirty }) => ({ repo: path, sha, dirty }));
  const read = () => handoffs.records.read("card", "project");
  return { directory, repo, handoffs, observer, managed, minute, raw, tool, turn, elsewhere, heads, read, file: join(directory, "handoffs", "card.json"), archive: join(directory, "handoffs", "card", "archive.jsonl"), now: () => now, identity: { taskId: "card", workspaceId: "ws", agentId: "succ" } };
}
export type RunningCard = Awaited<ReturnType<typeof handedOver>>;

/** The successor's full read, one page per minute (each page read is a tool call in its own rollout), `between` run before the next page. */
export async function fullRead(x: RunningCard, between: (page: number) => Promise<void> = async () => undefined) {
  let cursor: string | undefined;
  const pages: NonNullable<Awaited<ReturnType<RunningCard["handoffs"]["context"]>>["page"]>[] = [];
  for (;;) {
    const page = (await x.handoffs.context("card", "succ", { full: true, cursor })).page!;
    pages.push(page);
    await x.tool("mcp__flowly__flowly_get_task", { handoff: "full", handoffCursor: cursor }, JSON.stringify(page).slice(0, 60_000));
    if (page.viewChanged || page.complete) return pages;
    await between(pages.length);
    cursor = page.nextCursor;
  }
}
