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
