import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claudeBase, cleanupObserverFixtures, observerFixture, successorView } from "./handoff-observer-fixture";
import { HandoffStore, type HandoffContext } from "./handoff-store";

// One Claude task notice reaches Flowly in two copies: the provider file holds the notice itself (absorbed mid-turn as
// queue-operation records, or delivered), and Paseo 0.12's turn-end timeline holds a task_notification row. When Paseo
// built that row from the SDK's live system message it has no raw text: detail.text is only the summary, and taskId,
// status and outputFile are metadata (app.asar providers/claude, toTaskNotificationToolCall: detailText = rawText ??
// summary). Both copies write the note under one source id; the note rebuilt from the row must never stand in for the
// notice's own blocks (SESSION-HANDOFF-SPEC §5.7). Synthetic records, the real HandoffObserver and HandoffStore.
afterEach(cleanupObserverFixtures);
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const monitorInput = { command: "until grep -q \"deploy exit=\" /tmp/deploy.log; do sleep 3; done; tail -5 /tmp/deploy.log", description: "watch the staging deploy", timeout_ms: 1800000 };
const monitorStarted = "Monitor started (task bn9u7frii, expires in 30m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event.";
const monitorCall = { ...claudeBase, type: "assistant", uuid: "a-mon", message: { id: "r-mon", content: [{ type: "tool_use", id: "toolu_mon1", name: "Monitor", input: monitorInput }] } };
const monitorResult = { ...claudeBase, type: "user", uuid: "u-mon", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mon1", content: monitorStarted }] } };
const monitorEnd = `<task-notification>\n<task-id>bn9u7frii</task-id>\n<tool-use-id>toolu_mon1</tool-use-id>\n<output-file>/tmp/synthetic/tasks/bn9u7frii.output</output-file>\n<status>completed</status>\n<summary>Monitor "watch the staging deploy" stream ended</summary>\n<event>deploy exit=1: eu-west rolled back</event>\n</task-notification>`;
const absorbed = (text: string) => [
  { type: "queue-operation", operation: "enqueue", timestamp: claudeBase.timestamp, sessionId: claudeBase.sessionId, content: text },
  { type: "queue-operation", operation: "remove", timestamp: claudeBase.timestamp, sessionId: claudeBase.sessionId, commandUuid: "cmd-9", deliveryId: "del-9", reason: "absorbed_mid_turn", content: text },
];
const monitorRow = { type: "tool_call", callId: "toolu_mon1", name: "Monitor", status: "completed", error: null, detail: { type: "unknown", input: monitorInput, output: monitorStarted } };
const metadataRow = (n: number, task: string, status: "completed" | "failed", summary: string) => ({ type: "tool_call", callId: `task_notification_u-${n}`, name: "task_notification", status, error: status === "failed" ? { message: summary } : null,
  detail: { type: "plain_text", label: summary, icon: "wrench", text: summary },
  metadata: { synthetic: true, source: "claude_task_notification", taskId: task, toolUseId: `toolu_${task}`, status, outputFile: `/tmp/synthetic/tasks/${task}.output` } });
const monitorEndRow = metadataRow(9, "bn9u7frii", "completed", 'Monitor "watch the staging deploy" stream ended');
const workflowFailed = `<task-notification>\n<task-id>w3634wt08</task-id>\n<tool-use-id>toolu_wf1</tool-use-id>\n<output-file>/tmp/synthetic/tasks/w3634wt08.output</output-file>\n<status>failed</status>\n<summary>Background workflow "migrate" failed</summary>\n<error>agent migrate-2 threw: relation "orders_v2" does not exist</error>\n<failures>\nmigrate-2: relation "orders_v2" does not exist\n</failures>\n</task-notification>`;
const workflowRow = metadataRow(10, "w3634wt08", "failed", 'Background workflow "migrate" failed');
const idle = (x: Awaited<ReturnType<typeof observerFixture>>) => { x.actor.status = "idle"; x.actor.activeTurn = null; };

test("the notice's own copy and Paseo's metadata-only row read in one turn-end observe: the note keeps the error, the failures and the last event", async () => {
  const x = await observerFixture({ provider: "claude", running: true });
  await x.append([monitorCall, monitorResult]); await x.poll();
  // The end notice is absorbed in the turn's last minute and the turn ends before the next pass: one observe reads both copies.
  await x.append([...absorbed(monitorEnd), { ...claudeBase, type: "user", uuid: "u-wf", message: { role: "user", content: workflowFailed } }]);
  idle(x);
  await x.hook([monitorRow, monitorEndRow, workflowRow, { type: "assistant_message", text: "The deploy watch ended; the migration workflow failed." }]);
  const notes = successorView(await x.read()).notes;
  expect(notes).toHaveLength(2);
  expect(notes.find((note) => note.includes("bn9u7frii"))).toContain("Last event: deploy exit=1: eu-west rolled back");
  expect(notes.find((note) => note.includes("w3634wt08"))).toMatch(/^hazard:.*Error: agent migrate-2 threw: relation "orders_v2" does not exist.*Failures: migrate-2: relation "orders_v2" does not exist/);
  expect(notes.join("\n")).not.toContain("Rebuilt from Paseo's timeline row");
});

test("a note rebuilt from Paseo's row says so, and the notice's own copy read later upgrades it in place", async () => {
  const x = await observerFixture({ provider: "claude", running: true });
  // The provider copy lags behind the hook (or its capture failed): only the row speaks at the turn end.
  idle(x);
  await x.hook([workflowRow, { type: "assistant_message", text: "The migration workflow failed." }]);
  let record = await x.read();
  expect(successorView(record).notes).toEqual([expect.stringMatching(/^hazard:Background task w3634wt08 ended with status failed: Background workflow "migrate" failed\. Output file: \/tmp\/synthetic\/tasks\/w3634wt08\.output\. \(Rebuilt from Paseo's timeline row/)]);
  expect(record.notes[0].metadataOnly).toBe(true);
  const revision = record.revision, id = record.notes[0].id;
  await x.append([{ ...claudeBase, type: "user", uuid: "u-wf", message: { role: "user", content: workflowFailed } }]);
  await x.poll();
  record = await x.read();
  expect(record.notes).toHaveLength(1);
  expect(record.notes[0]).toMatchObject({ id, kind: "hazard" });
  expect(record.notes[0].metadataOnly).toBeUndefined();
  expect(record.notes[0].text).toContain('Error: agent migrate-2 threw: relation "orders_v2" does not exist');
  expect(record.notes[0].text).not.toContain("Rebuilt from Paseo's timeline row");
  // New information on the card: a new revision, so a reader of the poorer note reads again.
  expect(record.revision).toBe(revision + 1);
  // The row read again at the next turn end changes nothing.
  await x.hook([workflowRow, { type: "assistant_message", text: "The migration workflow failed." }, { type: "assistant_message", text: "Next turn." }]);
  expect((await x.read()).notes.map((note) => note.text)).toEqual(record.notes.map((note) => note.text));
});

test("copies of a notice whose note was archived: the notice's own copy upgrades a rebuilt note, a rebuilt or re-stamped copy is no conflict", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowly-handoff-notices-")); folders.push(dir);
  const store = new HandoffStore(dir), flowly: HandoffContext = { by: { kind: "flowly" } };
  const note = (sourceId: string, text: string, extra: Record<string, unknown> = {}) => ({ entries: [{ section: "notes" as const, value: { id: `nt:${sourceId}`, sourceId, kind: "hazard", at: "2026-10-25T02:00:00.000Z", text, ...extra } }] });
  await store.capture("card", "project", note("notice:rebuilt", "Background task t1 ended with status failed. (Rebuilt from Paseo's timeline row.)", { metadataOnly: true }), flowly);
  await store.capture("card", "project", note("notice:raw", "Background task t2 ended with status failed. Error: the real one."), flowly);
  // 100 later notes move both out of the current record.
  for (let n = 0; n < 100; n++) await store.appendNote("card", "project", { kind: "background", text: `Later note ${n}` }, { ...flowly, sourceId: `later:${n}` });
  const archived = await store.read("card", "project");
  expect(archived.notes.some((entry) => entry.sourceId?.startsWith("notice:"))).toBe(false);
  // The rebuilt copy of the raw note, and the raw note at another time: kept as they are, nothing written.
  await expect(store.capture("card", "project", note("notice:raw", "Background task t2 ended with status failed. (Rebuilt from Paseo's timeline row.)", { metadataOnly: true }), flowly)).resolves.toMatchObject({ stored: "none" });
  await expect(store.capture("card", "project", { entries: [{ section: "notes", value: { ...note("notice:raw", "Background task t2 ended with status failed. Error: the real one.").entries[0].value, at: "2026-10-25T03:00:00.000Z" } }] }, flowly)).resolves.toMatchObject({ stored: "none" });
  // The notice's own copy of the rebuilt one: upgraded, back on the card under its id.
  const upgraded = await store.capture("card", "project", note("notice:rebuilt", "Background task t1 ended with status failed. Error: relation \"orders_v2\" does not exist."), flowly);
  expect(upgraded).toMatchObject({ stored: "revision", handoffRevision: archived.revision + 1 });
  const record = await store.read("card", "project");
  expect(record.notes.filter((entry) => entry.sourceId === "notice:rebuilt")).toEqual([expect.objectContaining({ id: "nt:notice:rebuilt", text: expect.stringContaining("orders_v2") })]);
  expect(record.notes.find((entry) => entry.sourceId === "notice:rebuilt")!.metadataOnly).toBeUndefined();
  // An agent's own note under a reused source id is still a conflict.
  await expect(store.appendNote("card", "project", { kind: "background", text: "Something else" }, { by: { kind: "agent", agentId: "worker" }, sourceId: "later:3" })).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
});
