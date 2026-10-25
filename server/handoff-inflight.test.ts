import { afterEach, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { handoffOpenIds, type HandoffSession } from "../shared/handoff";
import { handoffRefusalFingerprint } from "./handoff-requirements";
import { cleanupObserverFixtures, codexEvent, codexResponse, observerFixture } from "./handoff-observer-fixture";
import type { HandoffStore } from "./handoff-store";

// A poll that lands while a call runs (a code-mode script, an exec_command, a browser tab being opened) sees the call but
// not its result yet: an evidence-free in-flight placeholder. It must surface while the call runs, and once the result
// settles it, leave no archived ledger version, no closed entry and no new delivery-gate requirement behind.
afterEach(cleanupObserverFixtures);

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
  const x = await observerFixture();
  await x.poll();
  for (let n = 1; n <= 5; n++) {
    await x.append([codexEvent("token_count", { info: { last_token_usage: { total_tokens: 1000 + n } } }), script(`s${n}`)]);
    await x.poll();
    const running = await x.read();
    expect(background(running.ledger[0])).toEqual([`exec_session:unknown:unknown:s${n}:script running:in flight`]);
    expect(handoffOpenIds(running)).toContain(running.ledger[0].background[0].id);
    await x.append([completion(4000 + n), scriptOutput(`s${n}`)]);
    await x.poll();
    expect((await x.read()).ledger[0].background).toEqual([]);
  }
  expect(await archivedLedgerVersions(x.records)).toBe(0);
  const page = await x.records.page("card", { scope: "all" });
  expect(page.items.filter((item) => item.origin === "archive")).toEqual([]); expect(page.complete).toBe(true);
});

test("a script that keeps running stays on the card across polls and in the sealed handoff; a yielded cell becomes real work", async () => {
  const x = await observerFixture();
  await x.append([script("s1", "await longTask();")]);
  for (let n = 0; n < 4; n++) await x.poll();
  const record = await x.read(), id = record.ledger[0].background[0].id;
  expect(background(record.ledger[0])).toEqual(["exec_session:unknown:unknown:s1:script running:in flight"]);
  expect(handoffOpenIds(record)).toEqual([id]);
  const sealed = await x.seal();
  expect(sealed.prompt).toContain("script running");
  await x.append([scriptOutput("s1", "Script running with cell ID 7")]);
  await x.poll();
  expect(background((await x.read()).ledger[0])).toEqual(["exec_session:open:cell:7:script cell 7 still running"]);
});

test("an in-flight start that returns a handle becomes a real item; one that fails or exits leaves only its note", async () => {
  const x = await observerFixture();
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
  const x = await observerFixture();
  await x.poll();
  const before = handoffRefusalFingerprint(await x.read());
  await x.append([script("s1")]); await x.poll();
  expect((await x.read()).ledger[0].background).toHaveLength(1);
  expect(handoffRefusalFingerprint(await x.read())).toBe(before);
});
