/**
 * Codex native sub-agents (multi-agent mode) and the item types of Codex `item_completed` (review round 2, loss-r2-L4).
 * Every text is synthetic; the shapes follow this machine's Codex rollouts (structure and counts only):
 * spawn_agent {task_name, message} -> {"task_name": "/root/<name>"}, followup_task {target, message} -> "",
 * interrupt_agent {target} -> {previous_status}, SubAgentActivity {agent_path, kind}, failures "collab ... failed: ...".
 */
import { afterEach, expect, test } from "vitest";
import { cleanupObserverFixtures, codexItem, codexResponse, observerFixture, successorView } from "./handoff-observer-fixture";

afterEach(cleanupObserverFixtures);
const call = (callId: string, name: string, args: Record<string, unknown>) => codexResponse("function_call", { name, call_id: callId, arguments: JSON.stringify(args) });
const result = (callId: string, output: string) => codexResponse("function_call_output", { call_id: callId, output });
const spawn = (callId: string, name: string, message: string, printed = `/root/${name}`) => [call(callId, "spawn_agent", { task_name: name, message, fork_turns: "none" }), result(callId, JSON.stringify({ task_name: printed }))];
const activity = (name: string, kind: string) => codexItem({ type: "SubAgentActivity", id: `sa-${name}-${kind}`, agent_path: `/root/${name}`, agent_thread_id: "019a15e5-1111-7abc-8def-0123456789ab", kind });
const agents = (view: ReturnType<typeof successorView>) => view.background.filter((entry) => entry.startsWith("subagent:"));

test("R2-B1 a running Codex sub-agent is on the card by its task name and what it was told", async () => {
  const x = await observerFixture();
  await x.append([...spawn("sp-1", "db_migration_owner", "Write migration 0042 and run it against staging"), activity("db_migration_owner", "started"),
    // Some Codex builds print the bare name; it is the same agent.
    ...spawn("sp-2", "docs_owner", "Update the README", "docs_owner"), activity("docs_owner", "interacted")]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.gaps).toEqual([]);
  expect(agents(view)).toEqual([
    "subagent:open:/root/db_migration_owner:db_migration_owner: Write migration 0042 and run it against staging",
    "subagent:open:/root/docs_owner:docs_owner: Update the README"]);
});

test("R2-B2 a sub-agent that completed or was interrupted is closed with that outcome; a failed spawn started nothing", async () => {
  const x = await observerFixture();
  await x.append([...spawn("sp-1", "docs_owner", "Update the README"), activity("docs_owner", "started"), activity("docs_owner", "completed"),
    ...spawn("sp-2", "perf_probe", "Profile the import"), activity("perf_probe", "started"), activity("perf_probe", "interrupted"),
    call("sp-3", "spawn_agent", { task_name: "extra", message: "Something" }), result("sp-3", "collab spawn failed: agent thread limit reached (max 6)"),
    ...spawn("sp-4", "lint_owner", "Fix lint"), call("in-1", "interrupt_agent", { target: "lint_owner" }), result("in-1", JSON.stringify({ previous_status: "running" }))]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.gaps).toEqual([]); expect(view.open).toBe(0);
  expect(agents(view)).toEqual([
    "subagent:closed:/root/docs_owner:docs_owner: Update the README:completed",
    "subagent:closed:/root/perf_probe:perf_probe: Profile the import:interrupted",
    "subagent:closed:/root/lint_owner:lint_owner: Fix lint:interrupted"]);
});

test("R2-B3 a follow-up task given to an existing sub-agent reopens it, also after an ACK settled it", async () => {
  const x = await observerFixture();
  await x.append([...spawn("sp-1", "docs_owner", "Update the README"), activity("docs_owner", "started"), call("sp-x", "spawn_agent", { task_name: "spare", message: "Wait" })]);
  await x.poll();
  await x.ack("obsolete", "checked: the spare spawn has no result yet; not needed");
  await x.append([result("sp-x", JSON.stringify({ task_name: "/root/spare" })), activity("docs_owner", "completed")]);
  await x.poll();
  expect(agents(successorView(await x.read())).filter((entry) => entry.includes(":open:"))).toEqual([]);
  await x.append([call("fu-1", "followup_task", { target: "/root/docs_owner", message: "Now also rewrite the install guide" }), result("fu-1", ""),
    call("fu-2", "followup_task", { target: "spare", message: "Start now" }), result("fu-2", ""),
    call("fu-3", "followup_task", { target: "docs_owner", message: "And the changelog" }), result("fu-3", "collab tool failed: agent docs_owner is busy")]);
  await x.poll();
  const view = successorView(await x.read());
  expect(agents(view)).toEqual([
    "subagent:open:/root/docs_owner:docs_owner: Now also rewrite the install guide",
    "subagent:open:/root/spare:spare: Start now"]);
  expect(view.gaps).toEqual([]);
});

test("Codex item types: known metadata items are skipped, an unknown one is a grouped gap; the root's instructions and encrypted-only messages are not gaps", async () => {
  const x = await observerFixture();
  const metadata = ["Reasoning", "FileChange", "ContextCompaction", "AgentMessage", "Extension", "ImageView", "CollabAgentToolCall", "FunctionCallOutput"].map((type, n) => codexItem({ type, id: `it-${n}` }));
  await x.append([...metadata, codexItem({ type: "FutureItem", id: "f-1" }), codexItem({ type: "FutureItem", id: "f-2" }),
    // A sub-agent's readable report is a note (handoff-capture-round3.test.ts); these two carry nothing readable to keep.
    codexResponse("agent_message", { author: "/root", recipient: "/root/docs_owner", id: "am-1", content: [{ type: "input_text", text: "synthetic instruction" }] }),
    codexResponse("agent_message", { author: "/root/docs_owner", recipient: "/root", id: "am-2", content: [{ type: "input_text", text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/docs_owner\nPayload:\n" }, { type: "encrypted_content", encrypted_content: "gAAAAsynthetic" }] }),
    call("w-1", "wait_agent", { timeout_ms: 30000 }), result("w-1", JSON.stringify({ message: "synthetic", timed_out: false })), call("l-1", "list_agents", {}), result("l-1", JSON.stringify({ agents: [] })),
    call("m-1", "send_message", { target: "/root/docs_owner", message: "synthetic" }), result("m-1", "")]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.gaps).toEqual([expect.stringMatching(/^open:2:Capture gap \(unknown_item_type\): FutureItem\./)]);
  expect(view.background).toEqual([]);
});
