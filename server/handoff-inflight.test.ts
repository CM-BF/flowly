import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffOpenIds, type HandoffSession } from "../shared/handoff";
import { handoffRefusalFingerprint } from "./handoff-requirements";
import { cleanupObserverFixtures, codexEvent, codexResponse, observerFixture } from "./handoff-observer-fixture";
import { HandoffService } from "./handoff-service";
import type { HandoffStore } from "./handoff-store";
import { BoardStore } from "./store";

// A poll that lands while a call runs (a code-mode script, an exec_command, a browser tab being opened) sees the call but
// not its result yet: an evidence-free in-flight placeholder. It must surface while the call runs, and once the result
// settles it, leave no archived ledger version, no closed entry, no revision and no new requirement (delivery gate or ACK)
// behind. A call is in flight only while its session is in a turn: once the session is idle, gone or ended, a call without
// a result is leftover work like any evidence-free placeholder, and an ACK must cover it.
const folders: string[] = [], at = "2026-10-25T02:00:00.000Z";
afterEach(async () => { await cleanupObserverFixtures(); await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const script = (callId: string, input = "const r = await tools.exec_command({ cmd: \"npm test\" }); text(r);") => codexResponse("custom_tool_call", { call_id: callId, id: `ctc_${callId}`, status: "completed", name: "exec", input });
const scriptOutput = (callId: string, header = "Script completed", ...printed: string[]) => codexResponse("custom_tool_call_output", { call_id: callId, output: [{ type: "input_text", text: `${header}\nWall time 0.5 seconds\nOutput:\n` }, ...printed.map((text) => ({ type: "input_text", text }))] });
const call = (callId: string, name: string, args: Record<string, unknown>) => codexResponse("function_call", { name, call_id: callId, arguments: JSON.stringify(args) });
const result = (callId: string, output: string) => codexResponse("function_call_output", { call_id: callId, output });
const completion = (processId: number, exitCode = 0) => codexEvent("item_completed", { thread_id: "019a15e5-0000-7abc-8def-0123456789ab", turn_id: "t", item: { type: "CommandExecution", id: `ce-${processId}`, command: ["bash", "-lc", "npm test"], process_id: processId, exit_code: exitCode, aggregated_output: "ok" } });
const background = (session: HandoffSession) => session.background.map((entry) => `${entry.kind}:${entry.status}:${entry.ref}:${entry.label}${entry.inFlight ? ":in flight" : ""}`);
async function archivedLedgerVersions(records: HandoffStore) {
  const text = await readFile(join(records.root, "card", "archive.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { section: string }).filter((pointer) => pointer.section === "ledger").length;
}

test("a script caught running surfaces as one in-flight item, and once it returns leaves no ledger version or entry behind", async () => {
  const x = await observerFixture({ running: true });
  await x.poll();
  for (let n = 1; n <= 5; n++) {
    await x.append([codexEvent("token_count", { info: { last_token_usage: { total_tokens: 1000 + n } } }), script(`s${n}`)]);
    await x.poll();
    const running = await x.read();
    expect(background(running.ledger[0])).toEqual([`exec_session:unknown:unknown:s${n}:script running:in flight`]);
    expect(handoffOpenIds(running)).not.toContain(running.ledger[0].background[0].id);
    await x.append([completion(4000 + n), scriptOutput(`s${n}`)]);
    await x.poll();
    expect((await x.read()).ledger[0].background).toEqual([]);
  }
  expect(await archivedLedgerVersions(x.records)).toBe(0);
  const page = await x.records.page("card", { scope: "all" });
  expect(page.items.filter((item) => item.origin === "archive")).toEqual([]); expect(page.complete).toBe(true);
});

test("a script that keeps running stays on the card across polls and in the sealed handoff; a yielded cell becomes real work", async () => {
  const x = await observerFixture({ running: true });
  await x.append([script("s1", "await longTask();")]);
  for (let n = 0; n < 4; n++) await x.poll();
  const record = await x.read(), id = record.ledger[0].background[0].id;
  expect(background(record.ledger[0])).toEqual(["exec_session:unknown:unknown:s1:script running:in flight"]);
  expect(handoffOpenIds(record)).toEqual([]); // on the card, but its own session is still running it
  const sealed = await x.seal();
  expect(sealed.prompt).toContain("script running");
  // Sealed, the session gets no result any more: the call is leftover work, no longer in flight, and the successor's ACK must cover it.
  expect(background((await x.read()).ledger[0])).toEqual(["exec_session:unknown:unknown:s1:script running"]);
  expect(handoffOpenIds(await x.read())).toEqual([id]);
  // Its result, read later, ends the handed-over placeholder (history now, so it closes rather than vanishes) and the yielded
  // cell is work of the turn the session still runs: on the card now, an id to acknowledge once that turn is over.
  await x.append([scriptOutput("s1", "Script running with cell ID 7")]);
  await x.poll();
  expect(background((await x.read()).ledger[0])).toEqual(["exec_session:closed:unknown:s1:script running", "exec_session:open:cell:7:script cell 7 still running"]);
  expect(handoffOpenIds(await x.read())).toEqual([]);
  Object.assign(x.actor, { status: "idle", activeTurn: null }); await x.poll();
  expect(handoffOpenIds(await x.read())).toEqual([(await x.read()).ledger[0].background[1].id]);
});

test("an in-flight start that returns a handle becomes a real item; one that fails or exits leaves only its note", async () => {
  const x = await observerFixture({ running: true });
  await x.append([call("c1", "mcp__async_shell__register_async_shell", { command: "make long-build", description: "build" }), call("c2", "mcp__paseo__browser_new_tab", { url: "https://app.paseo.sh" }), call("c3", "exec_command", { cmd: "npm test" })]);
  await x.poll();
  expect(background((await x.read()).ledger[0])).toEqual([
    "async_shell:unknown:unknown:c1:make long-build:in flight", "browser_tab:unknown:unknown:c2:browser tab: https://app.paseo.sh:in flight", "exec_session:unknown:unknown:c3:npm test:in flight"]);
  // A late completion of the same kind is not the result of a call whose result has not been read.
  await x.append([codexEvent("user_message", { message: "[async-shell finished task-old] \"other\" exited with code 0 after 1s." })]);
  await x.poll();
  expect((await x.read()).ledger[0].background[0]).toMatchObject({ ref: "unknown:c1", status: "unknown", inFlight: true });
  await x.append([result("c1", JSON.stringify({ task: { taskId: "task-77", status: "running" } })), result("c2", JSON.stringify({ isError: true, error: "plugin not ready" })), result("c3", "Process exited with code 0\nOutput:\nok")]);
  await x.poll();
  const record = await x.read(), mine = record.ledger[0].background.filter((entry) => entry.ref !== "task-old");
  expect(background({ ...record.ledger[0], background: mine })).toEqual(["async_shell:open:task-77:make long-build"]);
  expect(record.notes.map((note) => note.text)).toContainEqual(expect.stringContaining("browser_new_tab failed (call c2)"));
});

test("an in-flight placeholder is not a new delivery-gate requirement", async () => {
  const x = await observerFixture({ running: true });
  await x.poll();
  const before = handoffRefusalFingerprint(await x.read());
  await x.append([script("s1")]); await x.poll();
  expect((await x.read()).ledger[0].background).toHaveLength(1);
  expect(handoffRefusalFingerprint(await x.read())).toBe(before);
});

test("the board index does not count an in-flight placeholder, so catching a call running does not rewrite board.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowly-inflight-index-")); folders.push(directory);
  const board = new BoardStore(directory), handoffs = new HandoffService(board);
  await board.mutate((value) => {
    value.projects.push({ id: "project", title: "P", description: "", paseoProjectId: "native", primaryPath: directory, repos: [directory], revision: 1, createdAt: at, updatedAt: at, archivedAt: null });
    value.tasks.push({ id: "card", projectId: "project", workspaceId: "workspace", sourcePath: directory, repoPaths: [], title: "Card", description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: "create", createdAt: at, updatedAt: at, archivedAt: null });
  });
  const session = { agentId: "worker", n: 1, role: "implementer" as const, provider: "codex", reason: "launch", startedAt: at, finalized: false, turns: [], live: [] };
  await handoffs.records.setSession("card", "project", { ...session, background: [] }, { by: { kind: "flowly" }, sourceId: "session:worker" });
  await handoffs.syncIndex("card");
  const before = await readFile(join(directory, "board.json"), "utf8");
  await handoffs.records.setSession("card", "project", { ...session, background: [{ id: "bg:in-flight", callId: "s1", kind: "exec_session", ref: "unknown:s1", label: "script running", startedAt: at, status: "unknown", source: "live", inFlight: true }] }, { by: { kind: "flowly" }, sourceId: "session:worker" });
  await handoffs.syncIndex("card");
  expect(await readFile(join(directory, "board.json"), "utf8")).toBe(before);
  // Real background work still counts.
  await handoffs.records.setSession("card", "project", { ...session, background: [{ id: "bg:server", kind: "exec_session", ref: "4242", label: "dev server", startedAt: at, status: "open", source: "live" }] }, { by: { kind: "flowly" }, sourceId: "session:worker" });
  await handoffs.syncIndex("card");
  expect((await board.read()).handoffIndex.find((entry) => entry.taskId === "card")?.open).toBe(1);
});

/** The board index entry of the fixture card after a sync by the real HandoffService. */
async function indexed(x: Awaited<ReturnType<typeof observerFixture>>) {
  const service = new HandoffService(x.board);
  await service.syncIndex("card");
  return (await x.board.read()).handoffIndex.find((entry) => entry.taskId === "card");
}

test("a call whose session is sealed, stopped or idle without its result counts on the board, in the gate and in history", async () => {
  // Sealed mid-call: the deploy script may still be running, and nothing will ever report it.
  const sealed = await observerFixture({ running: true });
  await sealed.poll();
  const fingerprint = handoffRefusalFingerprint(await sealed.read());
  await sealed.append([script("s1", "await tools.exec_command({ cmd: \"./deploy.sh production\" });")]); await sealed.poll();
  expect(handoffRefusalFingerprint(await sealed.read())).toBe(fingerprint); // in flight while the turn runs
  await sealed.seal();
  const record = await sealed.read();
  expect(record.ledger[0].endedAt).toBeTruthy();
  expect(handoffRefusalFingerprint(record)).not.toBe(fingerprint);
  expect((await indexed(sealed))?.open).toBe(1);
  // The turn ends (the session stopped mid-call): the next poll settles the placeholder as leftover work, archived as history.
  const stopped = await observerFixture({ running: true });
  await stopped.append([script("s2")]); await stopped.poll();
  expect((await indexed(stopped))?.open).toBe(0);
  const archived = await archivedLedgerVersions(stopped.records);
  Object.assign(stopped.actor, { status: "idle", activeTurn: null });
  await stopped.poll(); await stopped.poll();
  expect(background((await stopped.read()).ledger[0])).toEqual(["exec_session:unknown:unknown:s2:script running"]);
  expect((await indexed(stopped))?.open).toBe(1);
  expect(await archivedLedgerVersions(stopped.records)).toBe(archived + 1);
  // A call first seen while the session is already idle is never in flight.
  const idle = await observerFixture();
  await idle.append([script("s3")]); await idle.poll(); await idle.poll();
  expect(background((await idle.read()).ledger[0])).toEqual(["exec_session:unknown:unknown:s3:script running"]);
  expect((await indexed(idle))?.open).toBe(1);
});

const shells = (count: number) => Array.from({ length: count }, (_, n) => [call(`r${n}`, "mcp__async_shell__register_async_shell", { command: `make watch-${n}`, description: `watch ${n}` }), result(`r${n}`, JSON.stringify({ task: { taskId: `task-${String(n).padStart(4, "0")}`, status: "running" } }))]).flat();

test("a call in flight at the 40-entry capacity never merges real background items", async () => {
  const x = await observerFixture({ running: true });
  await x.poll();
  await x.append(shells(40)); await x.poll();
  const archived = await archivedLedgerVersions(x.records);
  const notes = (await x.read()).notes.length;
  await x.append([script("s1", "const files = await readFiles(); text(files.length);")]); await x.poll();
  const during = await x.read();
  expect(during.ledger[0].skeleton).toContain("1 call in flight is not listed");
  await x.append([scriptOutput("s1")]); await x.poll();
  await x.append([codexEvent("user_message", { message: "[async-shell finished task-0000] \"make watch-0\" exited with code 0 after 9s." })]); await x.poll();
  const after = await x.read(), entries = after.ledger[0].background;
  expect(entries.filter((entry) => entry.ref.startsWith("merged:"))).toEqual([]);
  expect(entries.filter((entry) => entry.ref.startsWith("task-"))).toHaveLength(40);
  expect(entries.find((entry) => entry.ref === "task-0000")).toMatchObject({ status: "closed", label: "make watch-0" });
  expect(after.notes).toHaveLength(notes + 1); // the finished notice's own note, no merge note
  expect(await archivedLedgerVersions(x.records)).toBe(archived + 1); // only task-0000's end is history
  expect(after.ledger[0].skeleton).not.toContain("in flight");
});

test("more than 40 calls in flight in a quiet running turn: 40 listed, the rest counted, and no poll writes", async () => {
  const x = await observerFixture({ running: true });
  await x.poll();
  await x.append(Array.from({ length: 45 }, (_, n) => script(`p${n}`, "const files = await readFiles(); text(files.length);")));
  await x.poll();
  const first = await x.read();
  expect(first.ledger[0].background.filter((entry) => entry.inFlight)).toHaveLength(40);
  expect(first.ledger[0].skeleton).toContain("5 calls in flight are not listed");
  for (let n = 0; n < 5; n++) await x.poll();
  const later = await x.read();
  expect(later.revision).toBe(first.revision);
  expect(later.notes).toEqual(first.notes);
  expect(await archivedLedgerVersions(x.records)).toBe(0);
});

// A sealed predecessor can be woken later (a late notification, the finalize prompt's "if a later notification wakes you"):
// its later turn is a turn like any other, so a call caught in flight there is observation state until that turn is over.
test("a sealed session's later turn keeps a call caught in flight out of the revision, the ACK ids and the archive", async () => {
  const x = await observerFixture();
  await x.poll(); await x.seal();
  const sealed = await x.read(), archived = await archivedLedgerVersions(x.records);
  Object.assign(x.actor, { status: "running", activeTurn: { turnId: "late", startedAt: "2026-10-25T02:05:00.000Z" } });
  await x.append([script("s9")]); await x.poll();
  const flying = await x.read();
  expect(background(flying.ledger[0])).toEqual(["exec_session:unknown:unknown:s9:script running:in flight"]);
  expect([flying.revision, handoffOpenIds(flying)]).toEqual([sealed.revision, handoffOpenIds(sealed)]);
  await x.append([completion(4009), scriptOutput("s9")]); await x.poll();
  const done = await x.read();
  expect([done.revision, handoffOpenIds(done), done.ledger[0].background]).toEqual([sealed.revision, handoffOpenIds(sealed), []]);
  expect(await archivedLedgerVersions(x.records)).toBe(archived);
  // A call still without its result when that later turn is over is leftover work, as in any session.
  await x.append([script("s10")]); await x.poll();
  Object.assign(x.actor, { status: "idle", activeTurn: null }); await x.poll();
  const over = await x.read();
  expect(background(over.ledger[0])).toEqual(["exec_session:unknown:unknown:s10:script running"]);
  expect(handoffOpenIds(over)).toEqual([over.ledger[0].background[0].id]); expect(over.revision).toBe(sealed.revision + 1);
});
