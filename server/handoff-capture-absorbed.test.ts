import { afterEach, expect, test } from "vitest";
import { captureTimeline } from "./handoff-capture";
import { claudeBase, cleanupObserverFixtures, observerFixture, successorView } from "./handoff-observer-fixture";

// Claude background-task notices that never reach the card as a message: absorbed into a running turn (Claude Code writes
// them only as queue-operation records) or projected by Paseo 0.12 into a `task_notification` tool_call row. Synthetic
// records with the shapes observed on this machine (40 days of sdk-cli transcripts: 174 enqueued task notices, 114 removed
// with reason absorbed_mid_turn, 102 of them nowhere else in the transcript) and in Paseo's
// providers/claude/task-notification-tool-call.js.
afterEach(cleanupObserverFixtures);

const bashStart = [
  { ...claudeBase, type: "assistant", uuid: "a1", message: { id: "r1", content: [{ type: "tool_use", id: "toolu_bg1", name: "Bash", input: { command: "npm run migrate:staging", run_in_background: true, description: "Run the staging migration" } }] } },
  { ...claudeBase, type: "user", uuid: "u1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg1", content: "Command running in background with ID: bk7p2q9x1. Output is being written to: /tmp/synthetic/tasks/bk7p2q9x1.output" }] } },
];
const notice = (status: string, summary: string) => `<task-notification>\n<task-id>bk7p2q9x1</task-id>\n<tool-use-id>toolu_bg1</tool-use-id>\n<output-file>/tmp/synthetic/tasks/bk7p2q9x1.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
const failed = notice("failed", 'Background command "npm run migrate:staging" failed with exit code 1');
const absorbed = (text: string) => [
  { type: "queue-operation", operation: "enqueue", timestamp: claudeBase.timestamp, sessionId: claudeBase.sessionId, content: text },
  { type: "queue-operation", operation: "remove", timestamp: claudeBase.timestamp, sessionId: claudeBase.sessionId, commandUuid: "cmd-1", deliveryId: "del-1", reason: "absorbed_mid_turn", content: text },
];
const continuing = { ...claudeBase, type: "assistant", uuid: "a2", message: { id: "r2", content: [{ type: "text", text: "Continuing with the docs." }] } };

test("a background command's failure absorbed mid-turn (queue-operation records only) closes its item and leaves a hazard note", async () => {
  const x = await observerFixture({ provider: "claude" });
  await x.append([...bashStart, ...absorbed(failed), continuing]);
  await x.poll(); await x.poll();
  const view = successorView(await x.read());
  expect(view.background).toEqual([expect.stringMatching(/^exec_session:closed:bk7p2q9x1:.*:failed$/)]);
  expect(view.notes).toEqual(['hazard:Background task bk7p2q9x1 ended with status failed: Background command "npm run migrate:staging" failed with exit code 1. Output file: /tmp/synthetic/tasks/bk7p2q9x1.output.']);
  expect(view.gaps).toEqual([]); expect(view.inputs).toEqual([]); expect(view.open).toBe(0);
});

test("an absorbed completion keeps its output file, and the same notice delivered again later adds nothing", async () => {
  const x = await observerFixture({ provider: "claude" });
  const completed = notice("completed", 'Background command "npm run migrate:staging" completed (exit code 0)');
  await x.append([...bashStart, absorbed(completed)[0]]); // enqueued; the session stopped before it was absorbed or delivered
  await x.poll();
  const first = await x.read();
  expect(successorView(first).background).toEqual([expect.stringMatching(/^exec_session:closed:bk7p2q9x1:.*:completed$/)]);
  expect(successorView(first).notes).toEqual([expect.stringMatching(/^background:Background task bk7p2q9x1 ended with status completed: .*Output file: \/tmp\/synthetic\/tasks\/bk7p2q9x1\.output\./)]);
  await x.append([absorbed(completed)[1], { ...claudeBase, type: "attachment", uuid: "att-1", attachment: { type: "queued_command", commandMode: "task-notification", prompt: completed } }]);
  await x.poll();
  await x.hook([{ type: "tool_call", callId: "task_notification_cmd-1", name: "task_notification", status: "completed", error: null, detail: { type: "plain_text", label: 'Background command "npm run migrate:staging" completed (exit code 0)', text: completed }, metadata: { synthetic: true, source: "claude_task_notification", taskId: "bk7p2q9x1", status: "completed" } }]);
  const view = successorView(await x.read());
  expect(view.notes).toHaveLength(1); expect(view.background).toHaveLength(1); expect(view.inputs).toEqual([]); expect(view.gaps).toEqual([]);
});

/** Paseo 0.12: every Claude task notice reaches the turn-end timeline as this row; detail.text is the raw notice when Paseo had it. */
const row = (status: "failed" | "completed", detail: Record<string, unknown>) => ({ type: "tool_call", callId: "task_notification_u-77", name: "task_notification", status, error: status === "failed" ? { message: 'Background command "npm run migrate:staging" failed with exit code 1' } : null,
  detail: { type: "plain_text", label: 'Background command "npm run migrate:staging" failed with exit code 1', icon: "wrench", ...detail },
  metadata: { synthetic: true, source: "claude_task_notification", taskId: "bk7p2q9x1", toolUseId: "toolu_bg1", status, outputFile: "/tmp/synthetic/tasks/bk7p2q9x1.output" } });
const shell = { type: "tool_call", callId: "toolu_bg1", name: "Bash", status: "completed", detail: { type: "shell", command: "npm run migrate:staging", input: { command: "npm run migrate:staging", run_in_background: true }, output: "Command running in background with ID: bk7p2q9x1. Output is being written to: /tmp/synthetic/tasks/bk7p2q9x1.output" } };

test("the turn-end timeline's task_notification row closes the item and keeps the failure", async () => {
  const x = await observerFixture({ provider: "claude" }); // empty transcript: only the hook speaks
  await x.hook([shell, row("failed", { text: failed }), { type: "assistant_message", text: "Continuing with the docs." }]);
  const view = successorView(await x.read());
  expect(view.background).toEqual([expect.stringMatching(/^exec_session:closed:bk7p2q9x1:.*:failed$/)]);
  expect(view.notes).toEqual(['hazard:Background task bk7p2q9x1 ended with status failed: Background command "npm run migrate:staging" failed with exit code 1. Output file: /tmp/synthetic/tasks/bk7p2q9x1.output.']);
  expect(view.gaps).toEqual([]); expect(view.open).toBe(0);
});

test("a task_notification row without the raw notice is read from its metadata, error and label", async () => {
  const semantics = captureTimeline("agent", [shell, row("failed", {})], { outcome: "completed" });
  expect(semantics.background.filter((item) => item.closeOnly)).toEqual([expect.objectContaining({ handle: "bk7p2q9x1", status: "closed", outcome: "failed" })]);
  expect(semantics.background.find((item) => item.closeOnly)?.note).toMatchObject({ kind: "hazard", text: expect.stringContaining('ended with status failed: Background command "npm run migrate:staging" failed with exit code 1. Output file: /tmp/synthetic/tasks/bk7p2q9x1.output.') });
  expect(semantics.gaps).toEqual([]);
  // Neither a task id nor a status: nothing to close, and the row is not silently dropped.
  const unknown = captureTimeline("agent", [{ type: "tool_call", callId: "task_notification_x", name: "task_notification", status: "completed", detail: { type: "plain_text", label: "Background task notification" }, metadata: { source: "claude_task_notification" } }], { outcome: "completed" });
  expect(unknown.gaps).toEqual([expect.objectContaining({ kind: "unknown_timeline_type", typeHint: "tool_call/task_notification" })]);
});

test("other queue-operation records stay host bookkeeping; an unreadable queued notice is a gap, not dropped", async () => {
  const x = await observerFixture({ provider: "claude" });
  await x.append([
    { type: "queue-operation", operation: "enqueue", timestamp: claudeBase.timestamp, sessionId: claudeBase.sessionId },
    { type: "queue-operation", operation: "dequeue", timestamp: claudeBase.timestamp, sessionId: claudeBase.sessionId },
    { type: "queue-operation", operation: "remove", timestamp: claudeBase.timestamp, sessionId: claudeBase.sessionId, commandUuid: "cmd-2", deliveryId: "del-2", reason: "absorbed_mid_turn" },
  ]);
  await x.poll();
  expect(successorView(await x.read())).toMatchObject({ notes: [], gaps: [], inputs: [], background: [] });
  await x.append([{ type: "queue-operation", operation: "enqueue", timestamp: claudeBase.timestamp, sessionId: claudeBase.sessionId, content: "<task-notification>\n<summary>no id and no status</summary>\n</task-notification>" }]);
  await x.poll();
  expect(successorView(await x.read()).gaps).toEqual([expect.stringMatching(/^open:1:Capture gap \(unknown_record_type\): queue-operation\/task-notification/)]);
});

// Claude Code's Monitor tool (shapes from 7 Monitor starts in this machine's sdk-cli transcripts): a tool_use named Monitor
// ({command, description, timeout_ms}) whose result names its own task ("Monitor started (task bn9u7frii, …"). Each event
// is a task notice with that task id, an <event> and no <status> (absorbed mid-turn, delivered or queued through the SDK);
// its end is a <status>completed</status> "stream ended" notice whose <event> is the last thing it saw. Paseo maps a notice
// to a task_notification row whose own status defaults to "completed" and whose metadata has no status, and the tool call
// to a generic tool_call row (detail type "unknown", the raw input and output).
const monitorInput = { command: "until grep -q \"deploy exit=\" /tmp/deploy.log; do sleep 3; done; tail -5 /tmp/deploy.log", description: "watch the staging deploy", timeout_ms: 1800000 };
const monitorStarted = "Monitor started (task bn9u7frii, expires in 30m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.";
const monitorCall = { ...claudeBase, type: "assistant", uuid: "a-mon", message: { id: "r-mon", content: [{ type: "tool_use", id: "toolu_mon1", name: "Monitor", input: monitorInput }] } };
const monitorResult = { ...claudeBase, type: "user", uuid: "u-mon", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mon1", content: monitorStarted }] } };
const event = (text: string, task = "bn9u7frii") => `<task-notification>\n<task-id>${task}</task-id>\n<summary>Monitor event: "watch the staging deploy"</summary>\n<event>${text}</event>\n</task-notification>`;
const ended = (last: string) => `<task-notification>\n<task-id>bn9u7frii</task-id>\n<tool-use-id>toolu_mon1</tool-use-id>\n<output-file>/tmp/synthetic/tasks/bn9u7frii.output</output-file>\n<status>completed</status>\n<summary>Monitor "watch the staging deploy" stream ended</summary>\n<event>${last}</event>\n</task-notification>`;
const absorbedAs = (text: string, n: number) => absorbed(text).map((record) => record.operation === "remove" ? { ...record, commandUuid: `cmd-m${n}`, deliveryId: `del-m${n}` } : record);
const watching = /^exec_session:open:bn9u7frii:Monitor: watch the staging deploy/;

test("a running Monitor is open work under its own task id: events keep the latest one on it, its end closes it and keeps the last event", async () => {
  const x = await observerFixture({ provider: "claude", running: true });
  await x.append([monitorCall, monitorResult, ...absorbedAs(event("step 3/4 eu-west: health check failing"), 1), continuing]);
  await x.poll();
  let record = await x.read(), view = successorView(record);
  expect(view.background).toEqual(["exec_session:open:bn9u7frii:Monitor: watch the staging deploy:event=step 3/4 eu-west: health check failing"]);
  // Started in the running turn: on the card, not yet an id to acknowledge; the turn ends with the watch still running, so it is open work.
  expect(view).toMatchObject({ notes: [], gaps: [], inputs: [], open: 0 });
  x.actor.status = "idle"; x.actor.activeTurn = null; await x.poll();
  record = await x.read(); view = successorView(record);
  expect(view.background).toEqual(["exec_session:open:bn9u7frii:Monitor: watch the staging deploy:event=step 3/4 eu-west: health check failing"]);
  expect(view).toMatchObject({ notes: [], gaps: [], inputs: [], open: 1 });
  // More events, absorbed, delivered as the next prompt and queued through the SDK: progress written in place, nothing else.
  const revision = record.revision;
  await x.append([...absorbedAs(event("step 4/4 eu-west: retrying"), 2), { ...claudeBase, type: "user", uuid: "u-e3", message: { role: "user", content: event("step 4/4 us-east: healthy") } }, { ...claudeBase, type: "attachment", uuid: "att-e4", attachment: { type: "queued_command", commandMode: "task-notification", prompt: event("step 4/4 ap-south: healthy") } }]);
  await x.poll();
  record = await x.read(); view = successorView(record);
  expect(view.background).toEqual(["exec_session:open:bn9u7frii:Monitor: watch the staging deploy:event=step 4/4 ap-south: healthy"]);
  expect(view).toMatchObject({ notes: [], gaps: [], inputs: [], open: 1 }); expect(record.revision).toBe(revision);
  // A successor taking it over acknowledges it; later events keep it open, the end closes it with the last event in its note.
  await x.ack("doing", "the deploy watch is still running");
  await x.append(absorbedAs(event("step 4/4 eu-west: health check failing"), 5)); await x.poll();
  expect(successorView(await x.read()).background).toEqual([expect.stringMatching(watching)]);
  await x.append(absorbedAs(ended("deploy exit=1: eu-west rolled back"), 6)); await x.poll();
  view = successorView(await x.read());
  expect(view.background).toEqual([expect.stringMatching(/^exec_session:closed:bn9u7frii:Monitor: watch the staging deploy:completed/)]);
  expect(view.notes).toEqual(['background:Background task bn9u7frii ended with status completed: Monitor "watch the staging deploy" stream ended. Output file: /tmp/synthetic/tasks/bn9u7frii.output. Last event: deploy exit=1: eu-west rolled back']);
  expect(view).toMatchObject({ gaps: [], inputs: [], open: 0 });
  // Events after the end never reopen it; a notice without a readable task id is still a gap.
  await x.append([...absorbedAs(event("late"), 7), { type: "queue-operation", operation: "enqueue", timestamp: claudeBase.timestamp, sessionId: claudeBase.sessionId, content: "<task-notification>\n<summary>Monitor event</summary>\n<event>{}</event>\n</task-notification>" }]);
  await x.poll();
  view = successorView(await x.read());
  expect(view.background).toEqual([expect.stringMatching(/^exec_session:closed:bn9u7frii:/)]);
  expect(view.gaps).toEqual([expect.stringMatching(/^open:1:Capture gap \(unknown_record_type\): queue-operation\/task-notification/)]);
});

test("a Monitor still running when its session is sealed is on the sealed card and in the successor's ACK; a failed start leaves its error", async () => {
  const x = await observerFixture({ provider: "claude", running: true });
  await x.append([monitorCall]); await x.poll();
  // Caught before its result: a call in flight, already labelled with what it watches.
  expect(successorView(await x.read()).background).toEqual(["exec_session:unknown:unknown:toolu_mon1:Monitor: watch the staging deploy"]);
  await x.append([monitorResult, ...absorbedAs(event("step 1/4: building"), 1)]); await x.poll();
  const sealed = await x.seal();
  expect(sealed.prompt).toContain("Monitor: watch the staging deploy");
  const record = await x.read(), item = record.ledger[0].background.find((entry) => entry.ref === "bn9u7frii")!;
  expect(item).toMatchObject({ status: "open", event: "step 1/4: building" });
  expect(successorView(record).open).toBe(1);
  // A Monitor that could not start started nothing: its error is a note, no item.
  const failing = await observerFixture({ provider: "claude" });
  await failing.append([{ ...monitorCall, uuid: "a-m2", message: { id: "r-m2", content: [{ type: "tool_use", id: "toolu_mon2", name: "Monitor", input: monitorInput }] } }, { ...claudeBase, type: "user", uuid: "u-m2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mon2", is_error: true, content: "Monitor could not start: /tmp/deploy.log is not readable" }] } }]);
  await failing.poll();
  expect(successorView(await failing.read())).toMatchObject({ background: [], notes: [expect.stringContaining("Monitor failed (call toolu_mon2)")], open: 0 });
  expect(successorView(await failing.read()).notes[0]).toContain("/tmp/deploy.log is not readable");
});

/** Paseo 0.12 turn-end rows: the Monitor call (generic detail), and its notices as task_notification rows. */
const monitorRow = { type: "tool_call", callId: "toolu_mon1", name: "Monitor", status: "completed", error: null, detail: { type: "unknown", input: monitorInput, output: monitorStarted } };
const noticeRow = (n: number, text?: string, label = 'Monitor event: "watch the staging deploy"') => ({ type: "tool_call", callId: `task_notification_u-${n}`, name: "task_notification", status: "completed", error: null,
  detail: { type: "plain_text", label, icon: "wrench", ...(text ? { text } : {}) }, metadata: { synthetic: true, source: "claude_task_notification", taskId: "bn9u7frii", ...(text?.includes("<status>") ? { status: "completed", outputFile: "/tmp/synthetic/tasks/bn9u7frii.output" } : {}) } });

test("the turn-end timeline's Monitor rows: its call opens the item, event rows keep it open, the end row closes it with the last event", async () => {
  const x = await observerFixture({ provider: "claude" }); // empty transcript: only the hook speaks
  await x.hook([monitorRow, noticeRow(1, event("step 3/4 eu-west: health check failing")), { type: "assistant_message", text: "Watching the deploy." }]);
  let view = successorView(await x.read());
  expect(view.background).toEqual(["exec_session:open:bn9u7frii:Monitor: watch the staging deploy:event=step 3/4 eu-west: health check failing"]);
  expect(view).toMatchObject({ notes: [], gaps: [], inputs: [] });
  // A row rebuilt from metadata alone has no status and no event text: still progress, never "ended with status completed".
  const semantics = captureTimeline("agent", [noticeRow(2)], { outcome: "completed" });
  expect(semantics).toMatchObject({ notices: [], gaps: [] });
  expect(semantics.background).toEqual([expect.objectContaining({ handle: "bn9u7frii", status: "open", keepLabel: true })]);
  expect(semantics.background[0].event).toBeUndefined();
  await x.hook([monitorRow, noticeRow(1, event("step 3/4 eu-west: health check failing")), noticeRow(2), { type: "assistant_message", text: "Watching the deploy." },
    noticeRow(9, ended("deploy exit=1: eu-west rolled back"), 'Monitor "watch the staging deploy" stream ended'), { type: "assistant_message", text: "Done." }]);
  view = successorView(await x.read());
  expect(view.background).toEqual([expect.stringMatching(/^exec_session:closed:bn9u7frii:Monitor: watch the staging deploy:completed/)]);
  expect(view.notes).toEqual([expect.stringMatching(/^background:Background task bn9u7frii ended with status completed: Monitor "watch the staging deploy" stream ended\..*Last event: deploy exit=1: eu-west rolled back/)]);
});
