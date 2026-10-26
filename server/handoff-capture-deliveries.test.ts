/**
 * What reaches a session in the middle of its work (review round 2: loss-r2-L1–L3, noise-r2-4/5): async-shell
 * notices, background-task notices, Paseo agent envelopes and Claude's queued deliveries. Every text is synthetic;
 * the shapes follow paseo-async-shell (shared/message-format.ts, server/notifications.ts), paseo-dynamic-workflow
 * (server/views.ts), Paseo 0.12 (agent-messages projectAgentMessage) and Claude Code SDK transcripts.
 */
import { afterEach, expect, test } from "vitest";
import { captureTimeline } from "./handoff-capture";
import { handoffRefusalFingerprint } from "./handoff-requirements";
import { claudeBase, cleanupObserverFixtures, codexTyped, observerFixture, successorView } from "./handoff-observer-fixture";

afterEach(cleanupObserverFixtures);

// ---------------------------------------------------------------- async-shell notices (loss-r2-L2, noise-r2-4)
const task = "task-0123456789ab", other = "task-00000000feed";
const registered = { type: "plugin", id: `async-shell-${task}`, pluginId: "paseo-async-shell", kind: "async-shell-task", version: 1, data: { taskId: task, description: "wait for review", status: "running", commandPreview: "./synthetic-poll.sh", startedAt: "2026-10-25T01:00:00.000Z", finishedAt: null, exitCode: null } };
const logs = `Logs: /tmp/synthetic/${task}/stdout and /tmp/synthetic/${task}/stderr. Page through them with read_async_shell_output or \`paseo-shell output ${task} [--stderr] [--offset N]\`.`;
const notices = {
  finished: `[async-shell finished ${task}] "wait for review" exited with code 0 after 1m 2s.\n\nstdout (9 B):\nall green\n\nstderr: (empty)\n\n${logs}\n\nContinue your work.`,
  failed: `[async-shell failed ${task}] "wait for review" exited with code 2 after 4m 10s.\n\nstderr (120 B):\nrunning migration 0042\nError: synthetic schema mismatch at migration 0042\n\nstdout: (empty)\n\n${logs}\n\nInvestigate and continue.`,
  timed_out: `[async-shell timed_out ${task}] "wait for review" hit its 600 s deadline after 10m 0s and was stopped.\n\nstderr (40 B):\nwaiting for the review service\n\nstdout: (empty)\n\n${logs}\n\nCheck what it got done, then continue or register a new shell.`,
  lost: `[async-shell lost ${task}] "wait for review" ended while the plugin was not watching and left no exit code.\n\nstderr: (empty)\n\nstdout: (empty)\n\n${logs}\n\nCheck its logs and continue.`,
  still_running: `[async-shell still_running ${task}] "wait for review" has been running for 2h 0m (deadline in 4h 0m). Its result will be delivered when it exits; no action needed unless you want to cancel it.`,
  sendback: `[async-shell sendback ${task}] Update from your async shell "wait for review":\n\nReview service returned 3 blocking findings; details in /tmp/synthetic/review.json`,
  message: `[async-shell message ${other}] Message from agent "Reviewer" (agent-synthetic-2) via its async shell "relay". It is not from the user.\n\nThe staging database is frozen until 18:00; do not run migrations against it.`,
  request: `[async-shell request ${other}] Request from agent "Planner" (agent-synthetic-1) via its async shell "ask the implementer". It is not from the user. Answer it in this turn; your final message is returned to that shell.\n\nWhich schema version are you migrating to? Do not drop the legacy column until I confirm.`,
};
type Event = keyof typeof notices;
const expected: Record<Event, { background: string; note?: RegExp; input?: { status: "open" | "received"; title: string; text: string } }> = {
  finished: { background: "closed:finished", note: /^background:Async shell task-0123456789ab finished: "wait for review" exited with code 0 after 1m 2s\. stdout \(9 B\): all green Logs: \/tmp\/synthetic\/task-0123456789ab\/stdout and \/tmp\/synthetic\/task-0123456789ab\/stderr\.$/ },
  failed: { background: "closed:failed", note: /^hazard:Async shell task-0123456789ab failed: "wait for review" exited with code 2.*Error: synthetic schema mismatch at migration 0042.*\/tmp\/synthetic\/task-0123456789ab\/stdout and \/tmp\/synthetic\/task-0123456789ab\/stderr/ },
  timed_out: { background: "closed:timed_out", note: /^hazard:Async shell task-0123456789ab timed_out: .*600 s deadline.*waiting for the review service.*stderr/ },
  lost: { background: "closed:lost", note: /^hazard:Async shell task-0123456789ab lost: .*left no exit code.*Logs: \/tmp\/synthetic/ },
  still_running: { background: "open" },
  sendback: { background: "open", note: /^background:Async shell task-0123456789ab \("wait for review"\) sent an update: Review service returned 3 blocking findings; details in \/tmp\/synthetic\/review\.json/ },
  message: { background: "open", input: { status: "received", title: "Reviewer", text: "do not run migrations against it" } },
  request: { background: "open", input: { status: "open", title: "Planner", text: "Do not drop the legacy column until I confirm" } },
};
const shell = (view: ReturnType<typeof successorView>) => view.background.filter((entry) => entry.startsWith(`async_shell:`)).map((entry) => entry.split(":").slice(1, 2).concat(entry.match(/:(finished|failed|timed_out|lost)$/)?.[1] ?? []).join(":"));

test.each((Object.keys(notices) as Event[]).flatMap((event) => [[event, "timeline"], [event, "provider"]] as const))("async-shell %s notice (%s path): no anonymous gap, and what it says reaches the card", async (event, path) => {
  const x = await observerFixture();
  await x.hook([registered]);
  if (path === "timeline") await x.hook([registered, { type: "user_message", text: notices[event], messageId: `m-${event}` }, { type: "assistant_message", text: "ok" }]);
  else { await x.append([codexTyped(`01a170bb-${event}`, notices[event])]); await x.poll(); }
  const view = successorView(await x.read()), want = expected[event];
  expect(view.gaps).toEqual([]);
  expect(shell(view)).toEqual([want.background]);
  if (want.note) expect(view.notes).toEqual([expect.stringMatching(want.note)]); else expect(view.notes).toEqual([]);
  if (want.input) expect(view.inputs).toEqual([`agent:${path === "provider" ? "open" : want.input.status}:${want.input.title}:${notices[event]}`]);
  else expect(view.inputs).toEqual([]);
});

test("a still_running reminder after an ACK neither reopens anything nor changes the delivery fingerprint", async () => {
  const x = await observerFixture();
  await x.hook([registered, { type: "user_message", text: notices.still_running, messageId: "m-1" }]);
  await x.ack("doing", "the review poll is still running; I keep it");
  const before = await x.read();
  await x.append([codexTyped("01a170bb-sr2", notices.still_running.replace("2h 0m", "4h 0m"))]); await x.poll();
  await x.hook([registered, { type: "user_message", text: notices.still_running, messageId: "m-1" }, { type: "user_message", text: notices.still_running.replace("2h 0m", "4h 0m"), messageId: "m-2" }]);
  const after = await x.read();
  expect(after.gaps).toEqual([]);
  expect(handoffRefusalFingerprint(after)).toBe(handoffRefusalFingerprint(before));
  expect(successorView(after).background).toEqual([expect.stringMatching(/^async_shell:open:task-0123456789ab:/)]);
});

test("a text that only starts like an async-shell notice is still a visible gap, never silently dropped", () => {
  const b = captureTimeline("agent", [{ type: "user_message", text: "[async-shell rebooted task-0123456789ab] synthetic future event" }], { outcome: "completed" });
  expect(b.gaps).toEqual([expect.objectContaining({ kind: "unknown_background_notice" })]);
  expect(b.inputs).toEqual([]);
});

// ---------------------------------------------------------------- background-task notices: every block is kept or named (loss-r2-L3)
const marker = "[paseo-dynamic-workflow] A background workflow you launched has ended. This is an automated event from the plugin, not a message from the user: it does not answer anything you asked the user and is not their approval.";
const wfLaunch = { type: "tool_call", name: "mcp__dynamic_workflow__workflow", callId: "wf-1", status: "completed", detail: { input: { scriptPath: "/tmp/wf/impl.js" }, output: "Workflow launched in background. Run ID: wf_synthetic01\nSummary: implement" } };
const notice = (status: string, ...blocks: string[]) => [marker, "<task-notification>", "<task-id>wf_synthetic01</task-id>", `<status>${status}</status>`, ...blocks, "</task-notification>"].join("\n");
const workflowNote = async (text: string) => {
  const x = await observerFixture();
  await x.hook([wfLaunch, { type: "user_message", text, messageId: "m-wf" }, { type: "assistant_message", text: "ok" }]);
  const record = await x.read();
  expect(record.inputs).toEqual([]); expect(record.gaps).toEqual([]);
  expect(successorView(record).background).toEqual([expect.stringMatching(/^subagent:closed:wf_synthetic01:/)]);
  expect(record.notes).toHaveLength(1);
  return record.notes[0].text;
};

test("R2-C1 the worktree branches that hold a completed workflow's changes are on the card, and the note says it is an excerpt", async () => {
  const text = await workflowNote(notice("completed", '<summary>Dynamic workflow "implement" completed</summary>', "<output-file>/tmp/wf/runs/wf_synthetic01/result.json</output-file>", '<result>{"ok":true}</result>',
    "<diagnostics>Per-agent results and errors: /tmp/wf/runs/wf_synthetic01/journal.jsonl. Read this journal if the result is empty or unexpected.</diagnostics>",
    "<worktrees>\napi-change: branch wf/api-change-7f3a at /tmp/wt/api-change\nmigration: branch wf/migration-19bc; child creation/cleanup is unresolved (agent agent-synthetic-9); inspect the run snapshot before merging or deleting it.\n</worktrees>",
    "<usage><agent_count>2</agent_count><agents_done>2</agents_done></usage>"));
  expect(text).toContain("api-change: branch wf/api-change-7f3a at /tmp/wt/api-change");
  expect(text).toContain("migration: branch wf/migration-19bc; child creation/cleanup is unresolved (agent agent-synthetic-9)");
  expect(text).toMatch(/Not kept here: diagnostics, usage\b/);
  expect(text).toMatch(/\(Excerpt; the whole notice is in that session's raw history\.\)$/);
});

test("R2-C2 the user's stop instruction relayed in a stopped workflow's notice is on the card verbatim", async () => {
  const text = await workflowNote(notice("stopped", '<summary>Dynamic workflow "implement" was stopped</summary>', "<error>stopped by the user</error>",
    "<note>The user stopped this run in Paseo. Do not resume or relaunch it unless they ask; tell them briefly what had finished if that helps.</note>",
    "<diagnostics>Per-agent results and errors: /tmp/wf/runs/wf_synthetic01/journal.jsonl.</diagnostics>"));
  expect(text).toContain("Note: The user stopped this run in Paseo. Do not resume or relaunch it unless they ask; tell them briefly what had finished if that helps.");
  expect(text).toMatch(/\(Excerpt; the whole notice is in that session's raw history\.\)$/);
});

test("worktrees and the note keep their place in a long failed notice; the excerpt marker survives the note budget", async () => {
  const failures = Array.from({ length: 40 }, (_, n) => `[reviewer-${n}] failed: synthetic timeout ${"x".repeat(40)}`).join("\n");
  const text = await workflowNote(notice("failed", `<summary>Dynamic workflow "implement" failed: ${"synthetic error ".repeat(30)}</summary>`, `<error>${"synthetic error detail ".repeat(60)}</error>`,
    "<recovery>Resume with resumeFromRunId wf_synthetic01: completed agent() calls return their cached results.</recovery>", `<failures>\n${failures}\n</failures>`,
    "<worktrees>\napi-change: branch wf/api-change-7f3a at /tmp/wt/api-change\n</worktrees>", "<guidance>synthetic future guidance</guidance>", "<future-block>synthetic</future-block>"));
  expect(text.length).toBeLessThanOrEqual(2000);
  expect(text).toContain("wf/api-change-7f3a at /tmp/wt/api-change");
  expect(text).toContain("resumeFromRunId");
  expect(text).toMatch(/Not kept here: .*guidance.*future-block/);
  expect(text).toMatch(/\(Excerpt; the whole notice is in that session's raw history\.\)$/);
});

test("a Claude task notice with only the blocks it keeps is written whole, without an excerpt marker", () => {
  const b = captureTimeline("agent", [{ type: "user_message", text: "<task-notification>\n<task-id>bsh7</task-id>\n<tool-use-id>tu-7</tool-use-id>\n<output-file>/tmp/synthetic/bsh7.output</output-file>\n<status>completed</status>\n<summary>Background command \"npm run e2e\" completed (exit code 0)</summary>\n<note>Its output was larger than the preview; read the output file.</note>\n</task-notification>" }], { outcome: "completed" });
  const note = b.background.find((entry) => entry.handle === "bsh7")!.note!;
  expect(note).toMatchObject({ kind: "background" });
  expect(note.text).toContain("Note: Its output was larger than the preview; read the output file.");
  expect(note.text).not.toContain("Excerpt");
});

// ---------------------------------------------------------------- Paseo agent envelopes and their 0.12 turn-end rows (noise-r2-5)
const envelope = (kind: string, messageId: string, body: string, event?: string) => `<paseo-system version="1" kind="${kind}" source-agent-id="agent-child-9" message-id="${messageId}" source-agent-title="Orchestrator"${event ? ` event="${event}"` : ""}>\n${body}\n</paseo-system>`;
/** Paseo 0.12 projectAgentMessage: an envelope with a source reaches the timeline as a tool_call row named agent_message. */
const agentRow = (messageId: string, event: string, text: string) => ({ type: "tool_call", callId: `paseo-agent-message:${messageId}`, agentMessage: { event, sender: { id: "agent-child-9", title: "Orchestrator" }, text }, name: "agent_message", status: "completed", error: null, detail: { type: "plain_text", text, icon: "bot" } });
const steer = "Rebase on main before you continue.", finished = "Agent child-9 finished. Last message: synthetic summary of the audit";
const created = { type: "tool_call", name: "mcp__paseo__create_agent", callId: "ca-1", status: "completed", detail: { input: { title: "audit helper" }, output: { structuredContent: { agentId: "agent-child-9" } } } };

test("an agent message and a child's finished notification captured from the rollout are settled by Paseo 0.12's turn-end rows", async () => {
  const x = await observerFixture();
  await x.hook([created]);
  await x.append([codexTyped("01a170bb-0401", envelope("agent-message", "msg-1", steer)), codexTyped("01a170bb-0402", envelope("agent-notification", "msg-2", finished, "finished"))]);
  await x.poll();
  let view = successorView(await x.read());
  expect(view.inputs).toEqual([`agent:open:Orchestrator:${steer}`]);
  expect(view.notes).toEqual([`background:Agent "Orchestrator" (agent-child-9) finished: ${finished}`]);
  expect(view.background).toEqual([expect.stringMatching(/^subagent:closed:agent-child-9:.*:finished$/)]);
  for (let n = 0; n < 2; n++) await x.hook([created, agentRow("msg-1", "message", steer), agentRow("msg-2", "finished", finished), { type: "assistant_message", text: "rebased" }]);
  const record = await x.read(); view = successorView(record);
  expect(view.inputs).toEqual([`agent:received:Orchestrator:${steer}`]);
  expect(view.notes).toHaveLength(1);
  expect(view.open).toBe(0);
});

test("without a provider copy, the 0.12 rows alone keep the message, and an errored child is a hazard note", async () => {
  const x = await observerFixture();
  await x.hook([created, agentRow("msg-3", "message", steer), agentRow("msg-4", "errored", "Agent child-9 errored: synthetic crash"), agentRow("msg-5", "permission-required", "Agent child-9 needs permission to run rm -rf build")], "failed");
  const view = successorView(await x.read());
  // The turn failed: nothing it delivered is proven handled.
  expect(view.inputs).toEqual([`agent:open:Orchestrator:${steer}`, "agent:open:Orchestrator:Agent child-9 needs permission to run rm -rf build"]);
  expect(view.notes).toEqual(['hazard:Agent "Orchestrator" (agent-child-9) errored: Agent child-9 errored: synthetic crash']);
  expect(view.background).toEqual([expect.stringMatching(/^subagent:closed:agent-child-9:.*:errored$/)]);
});

// ---------------------------------------------------------------- Claude Code through the SDK: deliveries during a turn are attachment records (loss-r2-L1)
const queued = (n: number, mode: string, prompt: unknown) => ({ ...claudeBase, type: "attachment", uuid: `att-${n}`, parentUuid: null, attachment: { type: "queued_command", commandMode: mode, prompt, ...(mode === "task-notification" ? { origin: { kind: "task-notification", producer: "session-task" } } : {}), delivery_id: `d-${n}`, source_uuid: `q-${n}`, timestamp: claudeBase.timestamp } });
const routine = (n: number) => [
  ...["total_tokens_reminder", "deferred_tools_delta", "deferred_tools_record", "environment", "date", "model", "skill_listing", "instructions", "session_context", "credential_org", "remote_session_change", "silent_turn_reminder", "prompt_snapshot", "mcp_instructions_delta", "agent_listing_delta", "auto_mode", "task_reminder", "edited_text_file", "budget_usd", "command_permissions", "nested_memory", "ultra_effort_enter", "ultra_effort_exit", "thinking_drop", "file", "compact_file_reference", "invoked_skills", "read_truncation_notice", "workflow_size_guideline_change"]
    .map((type, k) => ({ ...claudeBase, type: "attachment", uuid: `r-${n}-${k}`, attachment: { type, text: "synthetic" } })),
  { ...claudeBase, type: "atis-latch", atis: {} }, { ...claudeBase, type: "cost-state", totalCostUSD: n }, { ...claudeBase, type: "mode", mode: "default" },
  { ...claudeBase, type: "file-history-delta", messageId: `m-${n}`, trackingPath: "/tmp/synthetic/a.ts" }, { ...claudeBase, type: "permission-mode", permissionMode: "bypassPermissions" }, { ...claudeBase, type: "agent-name", agentName: "synthetic" },
  { ...claudeBase, type: "last-prompt", lastPrompt: "synthetic" }, { ...claudeBase, type: "queue-operation", operation: "enqueue", content: "synthetic" }];

test("R2-D1 a background task's failure delivered mid-turn as a queued_command attachment closes its item and leaves its note", async () => {
  const x = await observerFixture({ provider: "claude" });
  await x.append([
    { ...claudeBase, type: "assistant", uuid: "a1", message: { id: "r1", content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "npm test", run_in_background: true } }] } },
    { ...claudeBase, type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "Command running in background with ID: bsh1. Output is being written to: /tmp/synthetic/bsh1.output" }] } },
    queued(1, "task-notification", "<task-notification>\n<task-id>bsh1</task-id>\n<tool-use-id>tu-1</tool-use-id>\n<output-file>/tmp/synthetic/bsh1.output</output-file>\n<status>failed</status>\n<summary>Background command \"npm test\" failed with exit code 1</summary>\n</task-notification>"),
  ]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.background).toEqual([expect.stringMatching(/^exec_session:closed:bsh1:.*:failed$/)]);
  expect(view.notes).toEqual([expect.stringMatching(/^hazard:Background task bsh1 ended with status failed: Background command "npm test" failed with exit code 1\. Output file: \/tmp\/synthetic\/bsh1\.output\./)]);
  expect(view.gaps).toEqual([]); expect(view.inputs).toEqual([]);
});

test("R2-D2 words a person typed while Claude was working (queued prompt) are on the card, and the turn-end copy links to them", async () => {
  const x = await observerFixture({ provider: "claude" });
  await x.append([queued(2, "prompt", [{ type: "text", text: "Also keep the old endpoint working" }]), queued(3, "prompt", "And do not touch the migrations")]);
  await x.poll();
  expect(successorView(await x.read()).inputs).toEqual(["session:open:-:Also keep the old endpoint working", "session:open:-:And do not touch the migrations"]);
  await x.hook([{ type: "user_message", text: "Also keep the old endpoint working", messageId: "paseo-1" }, { type: "user_message", text: "And do not touch the migrations", messageId: "paseo-2" }, { type: "assistant_message", text: "ok" }]);
  const view = successorView(await x.read());
  expect(view.inputs).toEqual(["session:received:-:Also keep the old endpoint working", "session:received:-:And do not touch the migrations"]);
  expect(view.gaps).toEqual([]);
});

test("queued deliveries follow their own rules: another agent's envelope, an async-shell notice, a workflow notice, an image", async () => {
  const x = await observerFixture({ provider: "claude" });
  await x.append([
    queued(4, "prompt", '<paseo-system version="1" kind="agent-message" source-agent-id="agent-parent-1" message-id="pm-1" source-agent-title="Orchestrator">\nPause before the release step.\n</paseo-system>'),
    queued(5, "prompt", `[async-shell request ${other}] Request from agent "Planner" (agent-synthetic-1) via its async shell "ask". It is not from the user. Answer it in this turn; your final message is returned to that shell.\n\nWhich port does the dev server use?`),
    queued(6, "prompt", "[paseo-dynamic-workflow] A background workflow you launched has ended.\n<task-notification>\n<task-id>wf_q1</task-id>\n<status>failed</status>\n<summary>Dynamic workflow \"lint\" failed: synthetic</summary>\n<error>synthetic lint crash</error>\n</task-notification>"),
    queued(7, "prompt", [{ type: "text", text: "See the screenshot" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]),
  ]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.inputs).toEqual(["agent:open:Orchestrator:Pause before the release step.", expect.stringMatching(/^agent:open:Planner:\[async-shell request task-00000000feed\]/), "session:open:-:See the screenshot"]);
  expect(view.notes).toEqual([expect.stringMatching(/^hazard:Background task wf_q1 ended with status failed: .*Error: synthetic lint crash/)]);
  expect(view.gaps).toEqual([expect.stringMatching(/^open:1:Capture gap \(image_not_captured\)/)]);
});

test("R2-D3 Claude's routine host records are metadata, not gaps that grow every turn; an unknown attachment subtype is still a gap", async () => {
  const x = await observerFixture({ provider: "claude" });
  await x.append(routine(1)); await x.poll();
  expect(successorView(await x.read()).gaps).toEqual([]);
  await x.append(routine(2)); await x.poll();
  let view = successorView(await x.read());
  expect(view.gaps).toEqual([]); expect(view.open).toBe(0);
  await x.append([{ ...claudeBase, type: "attachment", uuid: "fut-1", attachment: { type: "teammate_mailbox", text: "synthetic" } }, { ...claudeBase, type: "attachment", uuid: "fut-2", attachment: { type: "teammate_mailbox", text: "synthetic" } }]);
  await x.poll();
  view = successorView(await x.read());
  expect(view.gaps).toEqual([expect.stringMatching(/^open:2:Capture gap \(unknown_record_type\): attachment\/teammate_mailbox\./)]);
});

test("a pull request Claude Code linked to the session is kept as an anchor of its ledger entry", async () => {
  const x = await observerFixture({ provider: "claude" });
  await x.append([{ ...claudeBase, type: "pr-link", prNumber: 12, prRepository: "synthetic/repo", prUrl: "https://github.com/synthetic/repo/pull/12" }]);
  await x.poll(); await x.poll();
  const record = await x.read();
  expect(record.ledger[0].anchors).toEqual(["https://github.com/synthetic/repo/pull/12"]);
  expect(record.gaps).toEqual([]);
});
