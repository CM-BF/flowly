import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { HandoffStore } from "./handoff-store";
import { BoardStore } from "./store";
import { HandoffObserver, type HandoffObserverDeps } from "./handoff-observer";
import { captureHandoff, type CaptureBatch, type CaptureCursor } from "./handoff-capture";
import type { RotationContext } from "./automation-rotation";
import { handoffMessageSource } from "./handoff-source";
const folders: string[] = [], observers: HandoffObserver[] = [];
afterEach(async () => { await Promise.all(observers.splice(0).map((observer) => observer.stop())); vi.useRealTimers(); await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const at = "2026-10-24T00:00:00.000Z", flowly = { by: { kind: "flowly" as const } };
const source = { agentId: "worker", provider: "codex", fileId: "file:0", offset: 0, end: 100 };
const cursor = (offset = 100, epoch = 0): CaptureCursor => ({ version: 1, provider: "codex", sessionId: "native", fileId: "file", path: "synthetic-provider", offset, epoch, calls: [{ callId: "unresolved", kind: "exec", action: "start", source, at, label: "safe label" }] });
function batch(offset = 100): CaptureBatch { return { inputs: [], live: [], background: [], usage: [], compactions: [], gaps: [], notices: [], anchors: [], scriptCalls: 0, omittedGaps: 0, narrationOmitted: 0, narrationTrimmedChars: 0, cursor: cursor(offset), growth: {}, coverage: { at, from: 0, through: offset, fileBytes: offset, readBytes: offset, backlogBytes: 0, partialBytes: 0, skippedBytes: 0, complete: true, aborted: false } }; }
async function fixture(options: { fault?: (point: string) => void; override?: Partial<HandoffObserverDeps> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "flowly-handoff-observer-")); folders.push(directory);
  const board = new BoardStore(directory), records = new HandoffStore(directory, { fault: options.fault });
  await board.mutate((board) => {
    board.projects.push({ id: "project", title: "P", description: "", paseoProjectId: "native", primaryPath: directory, repos: [directory], revision: 1, createdAt: at, updatedAt: at, archivedAt: null });
    board.tasks.push({ id: "card", projectId: "project", workspaceId: "workspace", sourcePath: directory, repoPaths: [], title: "Card", description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: "create", createdAt: at, updatedAt: at, archivedAt: null });
  });
  let now = Date.parse(at), current = batch();
  const actor = { id: "worker", provider: "codex", model: "gpt-fixture", workspaceId: "workspace", status: "idle", activeTurn: null as null | { turnId: string; startedAt: string }, pendingPermissions: [] as unknown[], createdAt: at, updatedAt: at, lastUserMessageAt: at, persistence: { provider: "codex", nativeHandle: "native" }, archivedAt: null };
  const noTimeline = vi.fn(() => { throw new Error("Observer must never load an old timeline"); });
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: actor }), timeline: { refetch: noTimeline }, send: noTimeline }) } } as unknown as PaseoApi;
  const capture = vi.fn(async (_agent: unknown, _previous: unknown, _options?: unknown) => structuredClone(current)), syncIndex = vi.fn(async () => undefined), compaction = vi.fn();
  const git = vi.fn(async () => ({ snapshots: [{ repo: directory, sha: "a".repeat(40), dirty: false, at: new Date(now).toISOString() }], unchecked: [] }));
  const serials = new Map<string, Promise<unknown>>();
  const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => { const next = (serials.get(id) ?? Promise.resolve()).then(fn); serials.set(id, next.catch(() => undefined)); return next; };
  const deps: HandoffObserverDeps = { records, board, paseo: () => paseo, serial, syncIndex, clock: () => now, capture, git, onCompaction: compaction, ...options.override };
  const observer = new HandoffObserver(deps); observers.push(observer);
  return { directory, board, records, actor, observer, capture, git, noTimeline, compaction, serial, restart: () => { const next = new HandoffObserver(deps); observers.push(next); return next; }, setBatch: (b: CaptureBatch) => { current = b; }, advance: (ms: number) => { now += ms; }, read: () => records.read("card", "project") };
}

test("policy measurement under the card service queue never recursively waits on that queue or advances capture", async () => {
  const x = await fixture(); await x.observer.ensureSession("card", "worker");
  Object.assign(x.actor, { lastUsage: { contextWindowUsedTokens: 170000, contextWindowMaxTokens: 258400 } });
  const before = await x.read();
  const facts = await x.serial("card", () => x.observer.bridge.measure!({ taskId: "card", agentId: "worker" }));
  expect(facts).toMatchObject({ agentId: "worker", C: 170000, W: 258400, usageSource: "snapshot", ttlKind: "codex" });
  expect((await x.read()).revision).toBe(before.revision); expect(x.capture).not.toHaveBeenCalled(); expect(x.noTimeline).not.toHaveBeenCalled();
  x.actor.workspaceId = "other-workspace";
  await expect(x.observer.measure({ taskId: "card", agentId: "worker" })).rejects.toThrow("does not belong");
});

test("measured work time includes only proven started-and-ended turns, not session age or repeated hooks", async () => {
  const x = await fixture(), first = batch(); first.usage.push({ id: "initial", source, at, atSource: "provider", contextTokens: 100, initialContextTokens: 100, windowTokens: 1000 }); x.setBatch(first);
  await x.observer.observe("card", "worker"); x.advance(24 * 3_600_000);
  expect((await x.observer.measure({ taskId: "card", agentId: "worker" })).activeMs).toBeUndefined();
  const startedAt = new Date(Date.parse(at) + 24 * 3_600_000).toISOString();
  x.actor.activeTurn = { turnId: "known", startedAt }; await x.observer.observe("card", "worker");
  x.advance(45_000); await x.observer.observe("card", "worker"); x.advance(45_000); x.actor.activeTurn = null;
  const options = { timeline: [{ type: "assistant_message", text: "Finished known work" }], outcome: "completed" as const };
  await x.observer.observe("card", "worker", options); await x.observer.observe("card", "worker", options);
  const facts = await x.observer.measure({ taskId: "card", agentId: "worker" });
  expect(facts.activeMs).toBe(45_000); expect(facts.completedTurns).toBe(1); expect(facts.lastTurnEndAt).toBe(Date.parse(startedAt) + 90_000);
  expect(facts.lastRequestAt).toBe(Date.parse(at)); expect(facts.ttlSeconds).toBeUndefined();
});

test("a running turn's proof of activity is stored only with new data: quiet polls write nothing, a reload keeps the stored proof", async () => {
  const x = await fixture(), file = join(x.directory, "handoffs", "card.json");
  x.actor.status = "running"; x.actor.activeTurn = { turnId: "long", startedAt: at };
  await x.observer.observe("card", "worker"); // first sight of the turn: stored, with the time it was seen
  x.advance(10 * 60_000); x.setBatch(batch(200)); await x.observer.observe("card", "worker"); // new provider data: the proof goes with it
  const stored = await readFile(file, "utf8"), revision = (await x.read()).revision;
  for (let minute = 0; minute < 10; minute++) { x.advance(60_000); await x.observer.observe("card", "worker"); }
  expect(await readFile(file, "utf8")).toBe(stored); expect((await x.read()).revision).toBe(revision);
  // A plugin reload loses the quiet polls' in-memory proof; the hook (late, after the session went idle) counts the stored one.
  const reloaded = x.restart(); x.advance(5 * 60_000); x.actor.status = "idle"; x.actor.activeTurn = null;
  await reloaded.observe("card", "worker", { timeline: [{ type: "assistant_message", text: "Done." }], outcome: "completed" });
  expect((await reloaded.measure({ taskId: "card", agentId: "worker" })).activeMs).toBe(10 * 60_000);
});

test("without a reload the turn counts up to the last poll that saw it running, never up to a late hook", async () => {
  const x = await fixture();
  x.actor.status = "running"; x.actor.activeTurn = { turnId: "long", startedAt: at };
  for (let minute = 0; minute <= 20; minute++) { await x.observer.observe("card", "worker"); x.advance(60_000); }
  x.advance(39 * 60_000); x.actor.status = "idle"; x.actor.activeTurn = null;
  await x.observer.observe("card", "worker", { timeline: [{ type: "assistant_message", text: "Done." }], outcome: "completed" });
  expect((await x.observer.measure({ taskId: "card", agentId: "worker" })).activeMs).toBe(20 * 60_000);
});

test("equal narration on separate proven turns still counts each turn exactly once", async () => {
  const x = await fixture(), options = { timeline: [{ type: "assistant_message", text: "Same final words" }], outcome: "completed" as const };
  for (let n = 0; n < 2; n++) {
    x.actor.activeTurn = { turnId: `turn-${n}`, startedAt: new Date(Date.parse(at) + n * 1000).toISOString() };
    await x.observer.observe("card", "worker"); x.actor.activeTurn = null;
    await x.observer.observe("card", "worker", options); await x.observer.observe("card", "worker", options); x.advance(1000);
  }
  expect((await x.observer.measure({ taskId: "card", agentId: "worker" })).completedTurns).toBe(2);
});

test("policy measurement retains permanent semantic gaps even after the native cursor has caught up", async () => {
  const x = await fixture(); await x.observer.observe("card", "worker");
  await x.records.appendGap("card", "project", { text: "An earlier long input was skipped", status: "open", kind: "flowly", agentId: "worker" }, flowly);
  const before = await x.read(); expect(before.ledger[0].through?.gaps).toBe(0);
  const facts = await x.observer.measure({ taskId: "card", agentId: "worker" });
  expect(facts.coverage?.gaps).toBe(1); expect((await x.read()).revision).toBe(before.revision);
});

test("the policy cache tier is separate from P1's five-minute finalization safety budget", async () => {
  const x = await fixture(); x.actor.provider = "claude"; x.actor.persistence.provider = "claude";
  const first = batch(); first.usage.push({ id: "actual-request", source, at, atSource: "provider", contextTokens: 150000, windowTokens: 1000000, cacheTtlSeconds: 3300 }); x.setBatch(first);
  await x.observer.observe("card", "worker"); x.advance(20 * 60_000);
  expect((await x.observer.bridge.prepare(rotation())).finalize).toBeUndefined();
  expect(await x.observer.measure({ taskId: "card", agentId: "worker" })).toMatchObject({ ttlKind: "claude-1h", ttlSeconds: 3300, lastRequestAt: Date.parse(at) });
});

test("read-only measurement is canceled during stop without waiting for an unresponsive native request", async () => {
  let release!: () => void;
  const x = await fixture({ override: { measure: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { agentId: "worker", provider: "codex", at: Date.parse(at) }; } } });
  await x.observer.ensureSession("card", "worker"); const before = await x.read();
  const measuring = x.observer.measure({ taskId: "card", agentId: "worker" });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  const started = Date.now(); await x.observer.stop(); expect(Date.now() - started).toBeLessThan(1000);
  release(); await expect(measuring).rejects.toThrow("canceled"); expect((await x.read()).revision).toBe(before.revision);
});

test("semantic input and full native resume are committed together, including after an interrupted write", async () => {
  let armed = false;
  const x = await fixture({ fault: (point) => { if (armed && point === "intent-synced") { armed = false; throw new Error("crash"); } } });
  await x.observer.ensureSession("card", "worker");
  const first = batch(); first.inputs.push({ id: "original", source, text: "Keep this exact requirement", messageId: "m1", via: "session", atSource: "provider", at, redacted: true, status: "open" }); x.setBatch(first); armed = true;
  await expect(x.observer.observe("card", "worker")).rejects.toThrow("crash");
  const recovered = await new HandoffStore(x.directory).read("card", "project");
  expect(recovered.inputs[0].text).toBe("Keep this exact requirement"); expect(recovered.inputs[0].redacted).toBe(true); expect(recovered.ledger[0].through?.resume).toMatchObject(cursor());
  expect(recovered.ledger[0].through?.identity).toBe("file:0");
  const next = batch(10); next.cursor = cursor(10, 1); x.setBatch(next);
  await x.observer.observe("card", "worker"); expect((await x.read()).ledger[0].through?.identity).toBe("file:1");
  expect(x.capture.mock.calls.at(-1)?.[1]).toMatchObject(cursor());
});

test("unchanged polls do not rewrite records; Git time alone never changes the record", async () => {
  // Repositories are polled for a session in a turn; an idle one is read at its turn ends (handoff-idle.test.ts).
  const x = await fixture(); x.actor.status = "running"; x.actor.activeTurn = { turnId: "turn", startedAt: at };
  await x.observer.observe("card", "worker"); const first = await x.read();
  x.advance(60_000); await x.observer.observe("card", "worker"); expect((await x.read()).revision).toBe(first.revision); expect(x.git).toHaveBeenCalledTimes(1);
  x.advance(60_000); await x.observer.observe("card", "worker"); expect((await x.read()).revision).toBe(first.revision); expect(x.git).toHaveBeenCalledTimes(2);
});

// A pending start call is its own in-flight background item, not missing coverage: only the backlog counts (handoff-inflight.test.ts).
test("backlog and pending handles clear in current coverage instead of leaving permanent open gaps", async () => {
  const x = await fixture(); const first = batch(); first.gaps.push({ id: "lag", kind: "backlog", bytes: 90 }, { id: "call", kind: "background_handle_pending" }); first.coverage.backlogBytes = 90; first.coverage.fileBytes = 190; first.coverage.complete = false;
  first.background.push({ id: "call", callId: "call", source, kind: "exec", status: "unknown", at }); x.setBatch(first);
  await x.observer.observe("card", "worker"); expect((await x.read()).gaps).toEqual([]); expect((await x.read()).ledger[0].through?.gaps).toBe(1);
  const next = batch(190); next.background.push({ id: "resolved", callId: "call", source, kind: "exec", handle: "owned-123", status: "open", at }); x.setBatch(next);
  await x.observer.observe("card", "worker"); const record = await x.read(); expect(record.ledger[0].through?.gaps).toBe(0); expect(record.ledger[0].background).toMatchObject([{ ref: "owned-123", status: "open" }]);
});

test("typed original remains authoritative and a passive replay never reopens received or handled instructions", async () => {
  const x = await fixture();
  await x.records.appendInput("card", "project", { text: "Original secret-free typed wording", via: "composer", atSource: "typed", status: "received", agentId: "worker", messageId: "typed" }, { by: { kind: "human" }, sourceId: handoffMessageSource("worker", "typed") });
  const first = batch(); first.inputs.push({ id: "provider", source, text: "A transformed provider rendering", via: "session", atSource: "provider", status: "open", messageId: "typed", at }); x.setBatch(first);
  await x.observer.observe("card", "worker");
  const original = (await x.read()).inputs[0]; expect(original).toMatchObject({ text: "Original secret-free typed wording", atSource: "typed", status: "received" });
  await x.records.update("card", "project", { handoffRevision: (await x.read()).revision, inputs: [{ id: original.id, status: "done" }] }, flowly);
  await x.observer.observe("card", "worker"); expect((await x.read()).inputs[0].status).toBe("done");
});

test("timeline replay preserves equal words as separate inputs while narration and turn counters are idempotent", async () => {
  const x = await fixture();
  const timeline = [{ type: "user_message", text: "继续" }, { type: "user_message", text: "继续" }, { type: "assistant_message", text: "Current state" }];
  await x.observer.observe("card", "worker", { timeline, outcome: "completed" }); const record = await x.read();
  expect(record.inputs).toHaveLength(2); expect(record.inputs.every((i) => i.status === "received")).toBe(true); expect(record.ledger[0].measured?.turns).toBe(1);
  x.advance(1000); await x.observer.observe("card", "worker", { timeline, outcome: "completed" }); const replay = await x.read(); expect(replay.revision).toBe(record.revision); expect(replay.ledger[0].live).toEqual(record.ledger[0].live);
});

test("usage and native plus hook compaction counts are idempotent; observed compaction invalidates seen", async () => {
  const x = await fixture(); const first = batch(); first.usage.push({ id: "usage", source, at, contextTokens: 500, initialContextTokens: 50, windowTokens: 1000 }); first.compactions.push({ id: "compact", source, at }); x.setBatch(first);
  await x.observer.observe("card", "worker", { timeline: [{ type: "compaction", status: "completed", at }] }); const record = await x.read();
  expect(record.ledger[0].measured).toMatchObject({ C: 500, C0: 50, W: 1000, K: 1 }); expect(x.compaction).toHaveBeenCalledTimes(1);
  await x.observer.observe("card", "worker", { timeline: [{ type: "compaction", status: "completed", at }] }); expect((await x.read()).ledger[0].measured?.K).toBe(1); expect(x.compaction).toHaveBeenCalledTimes(1);
});

test("missing native cursor preserves pending resume; capture failures remain visible", async () => {
  const x = await fixture(); await x.observer.observe("card", "worker");
  await x.records.setSession("card", "project", { ...(await x.read()).ledger[0], provider: "unknown", model: undefined, launchModel: { provider: "codex", model: "chosen-at-launch" }, reason: "human_take_back" }, flowly);
  const next = batch(); delete next.cursor; next.gaps.push({ id: "missing", kind: "source_missing" }); next.coverage.complete = false; x.setBatch(next);
  await x.observer.observe("card", "worker"); const record = await x.read(); expect(record.ledger[0].through?.resume).toMatchObject(cursor()); expect(record.ledger[0].skeleton).toContain("source_missing"); expect(record.ledger[0]).toMatchObject({ provider: "codex", model: "gpt-fixture", launchModel: { model: "chosen-at-launch" }, reason: "human_take_back" });
  x.capture.mockRejectedValueOnce(new Error("synthetic failure")); await x.observer.observe("card", "worker"); expect((await x.read()).ledger[0].skeleton).toContain("Provider capture failed");
});

const rotation = (allowFinalize = true): RotationContext => ({ taskId: "card", rotationId: "rotation:fixture", role: "implementer", fromAgentId: "worker", reason: "run_again", allowFinalize, carry: { id: "instruction", role: "implementer", text: "Continue with exact requirements", fresh: "Continue", kind: "again" } });

test("a verbatim-comment rotation seals the complete prior work instruction as Flowly provenance, once", async () => {
  const x = await fixture(), continuation = { id: "old-instruction", text: "Exact prior work. ".repeat(500), fresh: "Exact prior fresh text", kind: "changes" };
  const context = { ...rotation(false), continuation };
  await x.observer.bridge.seal(context); await x.observer.bridge.seal(context);
  const record = await x.read(); expect(record.inputs).toHaveLength(1); const entry = record.inputs[0];
  expect(entry).toMatchObject({ via: "agent", atSource: "captured", status: "received", from: { title: "Flowly automation: pending work before this comment" } });
  expect(JSON.parse((await x.records.inputText("card", entry.sourceId!, 20000))!)).toEqual({ type: "pending_flowly_instruction", ...continuation });
});

test("the bridge only offers finalization for a stale, demonstrably small, idle, hot session", async () => {
  const x = await fixture(); expect((await x.observer.bridge.prepare(rotation())).finalize).toContain("update the card handoff");
  expect(x.noTimeline).not.toHaveBeenCalled(); x.actor.pendingPermissions.push({ id: "permission" }); expect((await x.observer.bridge.prepare(rotation())).finalize).toBeUndefined();
  x.actor.pendingPermissions = []; x.advance(3 * 60 * 60_000); expect((await x.observer.bridge.prepare(rotation())).finalize).toBeUndefined();
  x.actor.lastUserMessageAt = new Date(Date.parse(at) + 3 * 60 * 60_000).toISOString(); const huge = batch(); huge.coverage.fileBytes = 64 * 2 ** 20; x.setBatch(huge); expect((await x.observer.bridge.prepare(rotation())).finalize).toBeUndefined();
  expect(x.noTimeline).not.toHaveBeenCalled();
});

test("seal replays the same immutable revision; abandonment restores the old ledger's open lifecycle", async () => {
  const x = await fixture(); const first = await x.observer.bridge.seal(rotation(false));
  await x.records.appendNote("card", "project", { kind: "other", text: "A later note" }, flowly);
  const second = await x.observer.bridge.seal(rotation(false)); expect(second).toEqual(first); expect((await x.read()).ledger[0].endedAt).toBeTruthy();
  await x.observer.bridge.abandoned?.(rotation(false)); expect((await x.read()).ledger[0].endedAt).toBeUndefined();
});

test("stop returns within the host budget and late capture completion cannot write", async () => {
  let release!: (batch: CaptureBatch) => void;
  const x = await fixture({ override: { capture: () => new Promise((resolve) => { release = resolve; }) } });
  const observing = x.observer.observe("card", "worker");
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  const started = Date.now(); await x.observer.stop(); expect(Date.now() - started).toBeLessThan(1000);
  release(batch()); await expect(observing).rejects.toThrow("canceled"); expect((await x.read()).revision).toBe(0);
});

test("real bounded file capture resumes after observer restart and clears record-budget backlog", async () => {
  let home = "";
  const x = await fixture({ override: { capture: (actor, previous, options) => captureHandoff(actor, previous, { ...options, codexHome: home, claudeHome: join(home, "unused"), maxRecords: 2 }) } });
  home = join(x.directory, "synthetic-codex");
  const uuid = "019a15e5-0000-7abc-8def-0123456789ab", stamp = new Date(parseInt(uuid.replace(/-/g, "").slice(0, 12), 16));
  const folder = join(home, "sessions", String(stamp.getFullYear()), String(stamp.getMonth() + 1).padStart(2, "0"), String(stamp.getDate()).padStart(2, "0"));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `rollout-date-${uuid}.jsonl`), Array.from({ length: 3 }, (_, n) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "user_message", message_id: `user-${n}`, message: `Requirement ${n}` } }) + "\n").join(""));
  x.actor.persistence.nativeHandle = uuid;
  await x.observer.observe("card", "worker"); expect((await x.read()).inputs).toHaveLength(2); expect((await x.read()).ledger[0].through?.lagBytes).toBeGreaterThan(0);
  await x.observer.stop(); const replacement = x.restart();
  await replacement.observe("card", "worker"); const record = await x.read(); expect(record.inputs.map((i) => i.text)).toEqual(["Requirement 0", "Requirement 1", "Requirement 2"]); expect(record.ledger[0].through?.lagBytes).toBe(0); expect(record.ledger[0].through?.gaps).toBe(0);
});

test("a long turn without a checkpoint adds one durable hazard, but repeated end hooks do not multiply it", async () => {
  const x = await fixture(); x.actor.status = "running"; x.actor.activeTurn = { turnId: "turn-owned", startedAt: at };
  await x.observer.observe("card", "worker"); x.advance(6 * 60_000); x.actor.status = "idle"; x.actor.activeTurn = null;
  const options = { timeline: [{ type: "assistant_message", text: "Found a subtle environment constraint", messageId: "final" }], outcome: "completed" as const };
  await x.observer.observe("card", "worker", options); await x.observer.observe("card", "worker", options);
  expect((await x.read()).notes.filter((entry) => entry.kind === "hazard")).toHaveLength(1);
});

test("committed rotation upgrades a successor registered by an earlier start hook, so ACK stays required", async () => {
  const x = await fixture(); x.actor.id = "successor";
  await x.observer.ensureSession("card", "successor"); expect((await x.read()).ledger[0].reason).toBe("launch");
  await x.board.mutate((board) => { board.automation.push({ taskId: "card", projectId: "project", state: "working", role: "implementer", implementerId: "successor", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: at, updatedAt: at }); });
  await x.observer.ensureSession("card", "successor"); expect((await x.read()).ledger[0].role).toBe("implementer");
  await x.observer.bridge.committed?.({ ...rotation(), toAgentId: "successor" });
  const record = await x.read(); expect(record.ledger).toHaveLength(1); expect(record.ledger[0]).toMatchObject({ agentId: "successor", role: "implementer", reason: "run_again" }); expect(record.ledger[0].ack).toBeUndefined();
  await x.records.setSession("card", "project", { ...record.ledger[0], role: "manual", reason: "human_take_back" }, flowly);
  await x.observer.ensureSession("card", "successor"); expect((await x.read()).ledger[0].role).toBe("manual");
  await x.board.mutate((board) => { board.automation[0].implementerId = "someone-else"; });
  await expect(x.observer.bridge.committed?.({ ...rotation(), toAgentId: "successor" })).rejects.toThrow("no longer");
});

test("periodic observation is limited to eight supplied managed identities per pass and never sends", async () => {
  const x = await fixture();
  const observe = vi.spyOn(x.observer, "observe").mockResolvedValue(undefined);
  const known = Array.from({ length: 10 }, (_, n) => ({ taskId: `card-${n}`, agentId: `managed-${n}` }));
  // Exercise the same bounded pass used by the unref'd timer without fake timers around fsync.
  const poll = (x.observer as unknown as { poll: (sessions: () => Promise<typeof known>) => Promise<void> }).poll.bind(x.observer);
  await poll(async () => known); expect(observe).toHaveBeenCalledTimes(8); await poll(async () => known);
  expect(new Set(observe.mock.calls.map((args) => args[1])).size).toBe(10); expect(x.noTimeline).not.toHaveBeenCalled();
  x.observer.start(async () => known); await x.observer.stop();
});

test("recovering a retired session retains its original automation role and ended lifecycle", async () => {
  const x = await fixture();
  await x.board.mutate((board) => { board.automation.push({ taskId: "card", projectId: "project", state: "working", role: "implementer", implementerId: "successor", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: at, updatedAt: at, retired: [{ agentId: "worker", role: "implementer", at, reason: "history" }] }); });
  await x.observer.ensureSession("card", "worker");
  expect((await x.read()).ledger[0]).toMatchObject({ role: "implementer", endedAt: at, endReason: "history" });
  await x.observer.observe("card", "worker", { timeline: [{ type: "user_message", text: "A late instruction", messageId: "late" }], outcome: "completed" });
  expect((await x.read()).inputs[0]).toMatchObject({ status: "open", via: "retired_session" });
});

test("known Flowly instruction ids are filtered in both file and hook capture, and id-less proven automation has agent provenance", async () => {
  const x = await fixture();
  await x.board.mutate((board) => { board.automation.push({ taskId: "card", projectId: "project", state: "working", role: "implementer", implementerId: "worker", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: at, updatedAt: at,
    instruction: { id: "flowly-id", role: "implementer", text: "The exact current instruction", fresh: "The exact current instruction" }, workInstructions: { implementer: { id: "previous-id", role: "implementer", text: "Prior automation text", fresh: "Prior automation text" } } }); });
  const timeline = [{ type: "user_message", text: "The exact current instruction", messageId: "flowly-id" }, { type: "user_message", text: "Prior automation text", messageId: "previous-id" }, { type: "user_message", text: "The exact current instruction" }, { type: "user_message", text: "A real separate human request", messageId: "human-id" }];
  await x.observer.observe("card", "worker", { timeline, outcome: "completed" }); const record = await x.read();
  expect(x.capture.mock.calls[0][2]).toMatchObject({ sentMessageIds: ["flowly-id", "previous-id"] });
  expect(record.inputs).toHaveLength(2); expect(record.inputs[0]).toMatchObject({ via: "agent", from: { title: "Flowly automation" }, status: "received" }); expect(record.inputs[1]).toMatchObject({ via: "session", text: "A real separate human request" });
  await x.board.mutate((board) => { delete board.automation[0].instruction; }); await x.observer.observe("card", "worker", { timeline, outcome: "completed" });
  expect((await x.read()).inputs).toHaveLength(2);
});

test("the five-minute finalize heat cap never treats a merely idle old session as hot", async () => {
  const x = await fixture(); x.advance(6 * 60_000);
  expect((await x.observer.bridge.prepare(rotation())).finalize).toBeUndefined(); expect(x.noTimeline).not.toHaveBeenCalled();
});

test("provider and hook variants of an original input are retained as a visible conflict instead of stalling capture", async () => {
  const x = await fixture(); const first = batch(); first.inputs.push({ id: "original", source, messageId: "same-source", text: "First captured wording", via: "session", atSource: "provider", at, status: "open" }); x.setBatch(first);
  await x.observer.observe("card", "worker"); const second = batch(200); second.inputs.push({ ...first.inputs[0], text: "Different captured wording" }); x.setBatch(second);
  await x.observer.observe("card", "worker"); const record = await x.read();
  expect(record.ledger[0].through?.offset).toBe(200); expect(record.inputs.map((input) => input.text)).toEqual(expect.arrayContaining(["First captured wording", "Different captured wording"])); expect(record.gaps.some((gap) => gap.text.includes("different captured and typed bodies"))).toBe(true);
});

test("a usage drop refreshes the handoff view without inventing an additional confirmed compaction", async () => {
  const x = await fixture(); const first = batch(); first.usage.push({ id: "usage1", source, at, contextTokens: 1000 }); x.setBatch(first); await x.observer.observe("card", "worker");
  const second = batch(200); second.usage.push({ id: "usage2", source, at, contextTokens: 100 }); x.setBatch(second); await x.observer.observe("card", "worker");
  expect((await x.read()).ledger[0].measured?.K).toBe(0); expect(x.compaction).toHaveBeenCalledTimes(1); await x.observer.observe("card", "worker"); expect(x.compaction).toHaveBeenCalledTimes(1);
});

test("two distinct abandoned rotations each reopen the old ledger lifecycle", async () => {
  const x = await fixture();
  for (const id of ["rotation-first", "rotation-second"]) {
    const context = { ...rotation(false), rotationId: id };
    await x.observer.bridge.seal(context); expect((await x.read()).ledger[0].endedAt).toBeTruthy();
    await x.observer.bridge.abandoned?.(context); expect((await x.read()).ledger[0].endedAt).toBeUndefined();
  }
});

test("active background capacity never stops observation: the oldest items are merged into one counted entry and listed in a note", async () => {
  const x = await fixture(), first = batch();
  first.background = Array.from({ length: 40 }, (_, n) => ({ id: `background-${n}`, callId: `call-${n}`, source, kind: "exec" as const, handle: `handle-${n}`, status: "open" as const, at })); x.setBatch(first);
  await x.observer.observe("card", "worker"); const before = await x.records.openIds("card");
  const second = batch(200); second.background.push({ id: "background-41", callId: "call-41", source, kind: "exec", handle: "handle-41", status: "open", at }); x.setBatch(second);
  await x.observer.observe("card", "worker");
  const record = await x.read(), active = record.ledger[0].background.filter((item) => item.status !== "closed");
  expect(record.ledger[0].through?.offset).toBe(200); expect(active).toHaveLength(40);
  const after = await x.records.openIds("card"), dropped = before.filter((id) => !after.includes(id));
  expect(dropped).toHaveLength(2);
  expect(active).toContainEqual(expect.objectContaining({ status: "unknown", label: expect.stringMatching(/^2 more background items merged/) }));
  expect(record.notes.find((note) => note.text.includes("merged"))?.text).toMatch(/handle-0:.*handle-1:/);
});

test("narration omissions and trimmed characters remain explicit after idle polls and restart", async () => {
  const x = await fixture(), first = batch(); first.narrationOmitted = 7; first.narrationTrimmedChars = 1157; first.live.push({ id: "long-narration", source, at, atSource: "provider", text: "x".repeat(800), truncated: true }); x.setBatch(first);
  await x.observer.observe("card", "worker"); const record = await x.read();
  expect(record.ledger[0].skeleton).toContain("1157"); expect(record.ledger[0].live[0].truncated).toBe(true); expect(record.ledger[0].through?.gaps).toBe(0); expect(record.ledger[0].skeleton).toContain("Narration preview incomplete");
  x.setBatch(batch()); await x.observer.observe("card", "worker"); expect((await x.read()).ledger[0].skeleton).toContain("1157");
  await x.observer.stop(); const replacement = x.restart(); await replacement.observe("card", "worker"); expect((await x.read()).ledger[0].skeleton).toContain("1157");
});

test("a known missing handoff file refuses observation and registration instead of resetting its history", async () => {
  const x = await fixture();
  await x.board.mutate((board) => { board.handoffIndex.push({ taskId: "card", fresh: false, open: 2, sessions: 3 }); });
  await expect(x.observer.observe("card", "worker")).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" });
  await expect(x.observer.ensureSession("card", "worker")).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" });
  expect(await x.records.read("card")).toBeNull(); expect(x.capture).not.toHaveBeenCalled();
});
