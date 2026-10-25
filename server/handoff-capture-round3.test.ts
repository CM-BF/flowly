/**
 * Review round 3 (loss-r3-L1–L3, noise-r3-1–4): what a background completion, a sub-agent and the agent itself said must
 * reach the card, and host bookkeeping must not become gaps that reopen. Every text is synthetic; the shapes follow this
 * machine's Codex rollouts and Claude Code SDK transcripts (structure and counts only), paseo-async-shell
 * (server/notifications.ts) and Paseo's browser tools. Run through the real HandoffObserver and HandoffStore.
 */
import { afterEach, expect, test } from "vitest";
import { captureTimeline } from "./handoff-capture";
import { claudeBase, cleanupObserverFixtures, codexEvent, codexItem, codexResponse, codexTyped, observerFixture, successorView } from "./handoff-observer-fixture";

afterEach(cleanupObserverFixtures);
const call = (callId: string, name: string, args: Record<string, unknown>) => codexResponse("function_call", { name, call_id: callId, arguments: JSON.stringify(args) });
const result = (callId: string, output: string) => codexResponse("function_call_output", { call_id: callId, output });
const spawn = (callId: string, name: string, message: string) => [call(callId, "spawn_agent", { task_name: name, message, fork_turns: "none" }), result(callId, JSON.stringify({ task_name: `/root/${name}` }))];
const activity = (name: string, kind: string) => codexItem({ type: "SubAgentActivity", id: `sa-${name}-${kind}`, agent_path: `/root/${name}`, agent_thread_id: "019a15e5-1111-7abc-8def-0123456789ab", kind });
/** Codex multi-agent: a message between threads, a `Message Type` header block then (sometimes) an encrypted copy. */
const channel = (id: string, author: string, recipient: string, text: string, encrypted = false) => codexResponse("agent_message", { id, author, recipient, content: [...(text ? [{ type: "input_text", text }] : []), ...(encrypted ? [{ type: "encrypted_content", encrypted_content: "gAAAAsynthetic0paque1token2" }] : [])], internal_chat_message_metadata_passthrough: {} });
const header = (type: string, sender: string, payload: string) => `Message Type: ${type}\nTask name: /root\nSender: ${sender}\nPayload:\n${payload}`;
const answer = "Committed 1a2b3c4 on branch sub/migration-0042. Migration 0042 still FAILS on staging: column legacy_id is referenced by view v_orders; I did not drop it. Do not deploy until the view is changed.";

// ---------------------------------------------------------------- a Codex native sub-agent's final answer (loss-r3-L1, noise-r3-4)
test("R3-B1 what a native sub-agent reported when it finished reaches the card, as a Paseo child's last message does", async () => {
  const x = await observerFixture();
  await x.append([...spawn("sp-1", "db_migration_owner", "Write migration 0042 and run it against staging"), activity("db_migration_owner", "started"),
    channel("am-9", "/root/db_migration_owner", "/root", header("FINAL_ANSWER", "/root/db_migration_owner", answer)), activity("db_migration_owner", "completed")]);
  await x.poll(); await x.poll();
  const view = successorView(await x.read());
  expect(view.background).toEqual([expect.stringMatching(/^subagent:closed:\/root\/db_migration_owner:.*completed$/)]);
  expect(view.notes).toEqual([`background:Sub-agent /root/db_migration_owner reported its final answer: ${answer}`]);
  expect(view.gaps).toEqual([]); expect(view.inputs).toEqual([]); expect(view.open).toBe(0);
});

test("R3-B2 comparison: a Paseo child agent's finished notification keeps its last message as a note", async () => {
  const x = await observerFixture();
  await x.hook([{ type: "tool_call", name: "mcp__paseo__create_agent", callId: "ca-1", status: "completed", detail: { input: { title: "db migration" }, output: { structuredContent: { agentId: "agent-child-9" } } } }]);
  await x.append([codexTyped("01a170bb-0402", `<paseo-system version="1" kind="agent-notification" source-agent-id="agent-child-9" message-id="msg-2" source-agent-title="db migration" event="finished">\n${answer}\n</paseo-system>`)]);
  await x.poll();
  expect(successorView(await x.read()).notes.join("\n")).toContain("still FAILS on staging");
});

test("an interrupted sub-agent's answer is a hazard note, whichever comes first; a long answer is bounded and redacted", async () => {
  const x = await observerFixture();
  const long = `${"synthetic partial result ".repeat(150)} token=sk-abcdefghijklmnopqrstuvwx`;
  await x.append([...spawn("sp-1", "perf_probe", "Profile the import"), activity("perf_probe", "started"),
    channel("am-1", "/root/perf_probe", "/root", header("FINAL_ANSWER", "/root/perf_probe", "Stopped halfway: branch sub/perf has an uncommitted profile.")), activity("perf_probe", "interrupted"),
    ...spawn("sp-2", "lint_owner", "Fix lint"), activity("lint_owner", "started"), call("in-1", "interrupt_agent", { target: "lint_owner" }), result("in-1", JSON.stringify({ previous_status: "running" })),
    channel("am-2", "/root/lint_owner", "/root", header("FINAL_ANSWER", "/root/lint_owner", long))]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.notes).toEqual([
    "hazard:Sub-agent /root/perf_probe (interrupted) reported its final answer: Stopped halfway: branch sub/perf has an uncommitted profile.",
    expect.stringMatching(/^hazard:Sub-agent \/root\/lint_owner \(interrupted\) reported its final answer: synthetic partial result .*\(Excerpt; the whole answer is in that session's raw history\.\)$/)]);
  expect(view.notes[1].length).toBeLessThanOrEqual(2000 + "hazard:".length); expect(view.notes[1]).not.toContain("sk-abcdefghijklmnop");
});

test("encrypted-only messages and the root's own instructions are metadata; a report whose header cannot be read is one grouped gap", async () => {
  const x = await observerFixture();
  await x.append([...spawn("sp-1", "docs_owner", "Update the README"), activity("docs_owner", "started"),
    channel("am-1", "/root", "/root/docs_owner", "Also fix the install guide.", true),
    channel("am-2", "/root/docs_owner", "/root", header("MESSAGE", "/root/docs_owner", ""), true),
    channel("am-3", "/root/docs_owner", "/root", "", true),
    channel("am-4", "/root/docs_owner", "/root", "Synthetic report without a header"), channel("am-5", "/root/docs_owner", "/root", "Another synthetic report without a header")]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.notes).toEqual([]); expect(view.inputs).toEqual([]);
  expect(view.gaps).toEqual([expect.stringMatching(/^open:2:Capture gap \(unknown_response_type\): agent_message \(unparsed header\)\./)]);
});

test("R3-S1 a sub-agent whose task text is one opaque token is labelled by its task name, never with a redaction marker", async () => {
  const x = await observerFixture();
  // Real spawn_agent / followup_task `message` arguments are one opaque 600-900 character token (129 of 129 spawns this month).
  const opaque = Array.from({ length: 24 }, (_, n) => `Ab3dEf${n}GhIjK9lMnOpQ7rStUvWx`).join("");
  await x.append([...spawn("sp-1", "db_owner", opaque), activity("db_owner", "started"),
    channel("am-1", "/root/db_owner", "/root", header("FINAL_ANSWER", "/root/db_owner", "Migration 0042 applied; table orders still has the legacy column, do not drop it yet."), true),
    activity("db_owner", "completed"), call("fu-1", "followup_task", { target: "db_owner", message: opaque }), result("fu-1", "")]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.background).toEqual(["subagent:open:/root/db_owner:db_owner"]);
  expect(view.notes.join(" ")).toContain("legacy column");
});

