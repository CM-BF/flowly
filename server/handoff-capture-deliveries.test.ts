/**
 * What reaches a session in the middle of its work (review round 2: loss-r2-L1–L3, noise-r2-4/5): async-shell
 * notices, background-task notices, Paseo agent envelopes and Claude's queued deliveries. Every text is synthetic;
 * the shapes follow paseo-async-shell (shared/message-format.ts, server/notifications.ts), paseo-dynamic-workflow
 * (server/views.ts), Paseo 0.12 (agent-messages projectAgentMessage) and Claude Code SDK transcripts.
 */
import { afterEach, expect, test } from "vitest";
import { captureTimeline } from "./handoff-capture";
import { handoffRefusalFingerprint } from "./handoff-requirements";
import { cleanupObserverFixtures, codexTyped, observerFixture, successorView } from "./handoff-observer-fixture";

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
  finished: { background: "closed:finished" },
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
