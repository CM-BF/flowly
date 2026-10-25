import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

// A successor reads the card's full record and acknowledges it inside its own running turn: every page it reads and every
// check it runs is new data in its own provider file, observed by the 60-second pass (SESSION-HANDOFF-SPEC §5.1, §7.5).
// Never reaches a daemon or a real provider history: the Paseo API is an in-memory fake; the board, the synthetic Codex
// home and the Git repository live in a temporary directory.
const run = promisify(execFile);
const roots: string[] = [], observers: HandoffObserver[] = [];
afterEach(async () => { forgetHistory(); await Promise.all(observers.splice(0).map((observer) => observer.stop())); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const at = "2026-10-25T02:00:00.000Z";
const line = (value: unknown) => JSON.stringify(value) + "\n";
const uuid = (n: number) => `019a15e5-0000-7abc-8def-${String(n).padStart(12, "0")}`;
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

/** A card handed over: the sealed predecessor `pred` left a long record (a full read of several pages); the successor `succ` is in its first turn. */
async function handedOver() {
  const directory = await mkdtemp(join(tmpdir(), "flowly-running-read-")); roots.push(directory);
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
  // Production wiring (index.server.ts): the service's mutex and index sync; only the provider home is redirected.
  const handoffs = new HandoffService(board, () => now); handoffs.attach(paseo);
  const observer = new HandoffObserver({ records: handoffs.records, board, paseo: () => paseo, serial: handoffs.serial.bind(handoffs), syncIndex: handoffs.syncIndex.bind(handoffs), onCompaction: (taskId, agentId) => handoffs.forgetRead(taskId, agentId), clock: () => now,
    capture: (agent, previous, options) => captureHandoff(agent, previous, { ...options, codexHome }) });
  observers.push(observer);
  for (const agentId of ["pred", "succ"]) await observer.ensureSession("card", agentId);
  // What a busy card collects: 70 notes of about 1.9 KB, so the full read has several pages.
  for (let n = 0; n < 70; n++) await handoffs.records.appendNote("card", "project", { kind: n % 2 ? "background" : "hazard", text: `Note ${n}: ${"the predecessor found this and wrote it down; ".repeat(42)}`.slice(0, 1900) }, { by: { kind: "flowly" }, sourceId: `fixture-note:${n}` });
  // And two open gaps the successor must acknowledge.
  for (const [n, text] of [[1, "The predecessor's last turn was not captured."], [2, "One repository was not inspected."]] as const) await handoffs.records.appendGap("card", "project", { kind: "flowly", text, status: "open" }, { by: { kind: "flowly" }, sourceId: `fixture-gap:${n}` });
  const managed = async (): Promise<ManagedHandoffSession[]> => [{ taskId: "card", agentId: "pred" }, { taskId: "card", agentId: "succ" }];
  const minute = async () => { now += 60_000; await observer.poll(managed); };
  for (let n = 0; n < 3; n++) await minute();
  let calls = 0;
  /** What Codex writes to the successor's rollout for one tool call: the call, its output (none while it runs) and the new context size. */
  const tool = async (name: string, args: unknown, output?: string) => {
    calls++;
    const stamp = new Date(now).toISOString();
    await appendFile(rollouts.get("succ")!, [{ timestamp: stamp, type: "response_item", payload: { type: "function_call", name, call_id: `succ-call-${calls}`, arguments: JSON.stringify(args) } },
      ...(output === undefined ? [] : [{ timestamp: stamp, type: "response_item", payload: { type: "function_call_output", call_id: `succ-call-${calls}`, output } }]),
      { timestamp: stamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 40_000 + calls * 9_000 }, model_context_window: 258_400 } } }].map(line).join(""));
  };
  /** Another card's commit in the shared project root. */
  const elsewhere = async (n: number) => { await writeFile(join(repo, `other-${n}.md`), "another card\n"); await git(repo, "add", "."); await git(repo, "commit", "-q", "-m", `other ${n}`); };
  const heads = async () => [await handoffGitSnapshot(repo)].map(({ repo: path, sha, dirty }) => ({ repo: path, sha, dirty }));
  const read = () => handoffs.records.read("card", "project");
  const file = join(directory, "handoffs", "card.json");
  return { handoffs, observer, minute, tool, elsewhere, heads, read, file, identity: { taskId: "card", workspaceId: "ws", agentId: "succ" } };
}
type Card = Awaited<ReturnType<typeof handedOver>>;

/** The successor's full read, one page per minute, its own session observed in between (each page read is a tool call; so is a Git check). */
async function fullRead(x: Card, between: (page: number) => Promise<void> = async () => undefined) {
  let cursor: string | undefined;
  const pages: NonNullable<Awaited<ReturnType<Card["handoffs"]["context"]>>["page"]>[] = [];
  for (;;) {
    const page = (await x.handoffs.context("card", "succ", { full: true, cursor })).page!;
    pages.push(page);
    await x.tool("mcp__flowly__flowly_get_task", { handoff: "full", handoffCursor: cursor }, JSON.stringify(page).slice(0, 60_000));
    if (page.viewChanged || page.complete) return pages;
    await between(pages.length);
    cursor = page.nextCursor;
  }
}

test("a running successor's full read and ACK survive its own session being observed between every page and before the ACK", async () => {
  const x = await handedOver();
  const before = await x.read(), bytes = await readFile(x.file, "utf8");
  const pages = await fullRead(x, async (page) => {
    // Between pages: a Git check, a call still running when the pass lands, another card's commit in the shared root.
    await x.tool("exec_command", { cmd: "git rev-parse --short=12 HEAD && git status --porcelain" }, "Process exited with code 0\nOutput:\nabc\n");
    if (page === 1) await x.tool("exec_command", { cmd: "npm test" });
    if (page === 2) await x.elsewhere(page);
    await x.minute();
  });
  expect(pages.length).toBeGreaterThanOrEqual(3);
  expect(pages.map((page) => [page.revision, !!page.viewChanged])).toEqual(pages.map(() => [before.revision, false]));
  expect(pages.at(-1)!.complete).toBe(true);
  // The observation was stored (the successor's cursor moved, its call in flight and the new head are on the card) under the same revision.
  const observed = await x.read(), succ = observed.ledger.find((session) => session.agentId === "succ")!;
  expect(await readFile(x.file, "utf8")).not.toBe(bytes);
  expect(succ.through!.offset).toBeGreaterThan(before.ledger.find((session) => session.agentId === "succ")!.through!.offset);
  expect(succ.background.filter((item) => item.inFlight).map((item) => item.label)).toEqual(["npm test"]);
  expect(observed.git[0].sha).not.toBe(before.git[0].sha);
  expect(observed.revision).toBe(before.revision);
  // It verifies the heads (one more observed call), then acknowledges every id the read listed; its own call in flight is not one.
  const ids = [...new Set(pages.flatMap((page) => page.openIds))];
  expect(ids).toHaveLength(2);
  await x.tool("exec_command", { cmd: "git rev-parse --short=12 HEAD" }, "Process exited with code 0\nOutput:\nabc\n"); await x.minute();
  const result = await x.handoffs.update(x.identity, { handoffRevision: pages[0].revision, ack: { handoffRevision: pages[0].revision, heads: await x.heads(), understanding: "Read every page; heads verified.", items: ids.map((id) => ({ id, disposition: "doing" as const })) } });
  expect(result).toMatchObject({ ok: true, handoffRevision: before.revision + 1 });
  expect(result.ackMissing).toBeUndefined();
  expect((await x.read()).ledger.find((session) => session.agentId === "succ")!.ack).toMatchObject({ complete: true, recordRevision: before.revision + 1 });
}, 60_000);

test("a person's words arriving mid-read still change the view and refuse an ACK of the old revision", async () => {
  const x = await handedOver();
  const first = await fullRead(x, async (page) => {
    if (page === 1) await x.handoffs.recordInput({ ...x.identity, messageId: "m-mid-read", text: "Keep the old endpoint working until Friday.", via: "comment" });
    await x.minute();
  });
  expect(first.map((page) => !!page.viewChanged)).toEqual([false, true]);
  const stale = first[0].revision;
  await expect(x.handoffs.update(x.identity, { handoffRevision: stale, ack: { handoffRevision: stale, heads: await x.heads(), understanding: "Read page 1.", items: [] } })).rejects.toMatchObject({ code: "ACK_MISMATCH" });
  // Read again from page 1: complete, and it lists the new input; the ACK of that revision applies.
  const again = await fullRead(x, () => x.minute());
  expect(again.at(-1)!.complete).toBe(true);
  const revision = again[0].revision, input = (await x.read()).inputs.find((entry) => entry.messageId === "m-mid-read")!;
  expect(again.flatMap((page) => page.openIds)).toContain(input.id);
  const result = await x.handoffs.update(x.identity, { handoffRevision: revision, ack: { handoffRevision: revision, heads: await x.heads(), understanding: "Read again; keep the old endpoint.", items: [...new Set(again.flatMap((page) => page.openIds))].map((id) => ({ id, disposition: "doing" as const })) } });
  expect(result).toMatchObject({ ok: true }); expect(result.ackMissing).toBeUndefined();
}, 60_000);

test("a partial ACK is continued after its own session was observed", async () => {
  const x = await handedOver();
  // The successor starts a server before acknowledging: real background work (a new revision), listed with the two gaps.
  await x.tool("exec_command", { cmd: "./scripts/serve --port 4100" }, "Process running with session ID 7001");
  await x.minute();
  const read = await x.read(), [one, two, ...rest] = (await x.handoffs.context("card", "succ", { full: true })).page!.openIds;
  expect(rest).toEqual([expect.stringMatching(/^bg:/)]);
  const partial = await x.handoffs.update(x.identity, { handoffRevision: read.revision, ack: { handoffRevision: read.revision, heads: await x.heads(), understanding: "Two gaps handled.", items: [one, two].map((id) => ({ id, disposition: "done" as const, note: "Checked in the session history." })) } });
  expect(partial.ackMissing).toEqual(rest);
  await x.tool("exec_command", { cmd: "curl -s localhost:4100/health" }, "Process exited with code 0\nOutput:\nok\n"); await x.minute();
  const result = await x.handoffs.update(x.identity, { handoffRevision: partial.handoffRevision, ack: { handoffRevision: partial.handoffRevision, heads: await x.heads(), understanding: "The server is mine now.", items: rest.map((id) => ({ id, disposition: "doing" as const })) } });
  expect(result.ackMissing).toBeUndefined();
  expect((await x.read()).ledger.find((session) => session.agentId === "succ")!.ack).toMatchObject({ complete: true });
}, 60_000);
