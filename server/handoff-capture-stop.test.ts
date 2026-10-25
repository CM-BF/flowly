import { afterEach, expect, test } from "vitest";
import { claudeBase, cleanupObserverFixtures, observerFixture, successorView } from "./handoff-observer-fixture";

// Claude Code stops a background task or a Monitor with TaskStop (KillShell / KillBash in older versions): tool_use
// {task_id} and a tool_result {"message":"Successfully stopped task: <id> (<command>)","task_id","task_type","command"}.
// No task notice follows (23 of 23 TaskStop calls in this machine's transcripts; Claude Code's own later notice says stops
// "via the UI or TaskStop — these leave no transcript marker"), so the stop is the only evidence that the work ended
// (SESSION-HANDOFF-SPEC §5.7). Synthetic records with those shapes, the real HandoffObserver and HandoffStore.
afterEach(cleanupObserverFixtures);

const monitorInput = { command: "tail -f /tmp/deploy.log | grep --line-buffered exit=", description: "watch the staging deploy", timeout_ms: 1800000 };
const monitorStarted = "Monitor started (task bn9u7frii, expires in 30m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event.";
const monitorStart = [
  { ...claudeBase, type: "assistant", uuid: "a-mon", message: { id: "r-mon", content: [{ type: "tool_use", id: "toolu_mon1", name: "Monitor", input: monitorInput }] } },
  { ...claudeBase, type: "user", uuid: "u-mon", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mon1", content: monitorStarted }] } },
];
const bashStart = [
  { ...claudeBase, type: "assistant", uuid: "a1", message: { id: "r1", content: [{ type: "tool_use", id: "toolu_bg1", name: "Bash", input: { command: "npm run dev", run_in_background: true, description: "Start the dev server" } }] } },
  { ...claudeBase, type: "user", uuid: "u1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg1", content: "Command running in background with ID: bk7p2q9x1. Output is being written to: /tmp/synthetic/tasks/bk7p2q9x1.output" }] } },
];
const stopResult = (task: string, type: string, command: string) => ({ message: `Successfully stopped task: ${task} (${command})`, task_id: task, task_type: type, command });
const stop = (task: string, n: number, result: unknown, options: { error?: boolean; name?: string; input?: Record<string, unknown> } = {}) => [
  { ...claudeBase, type: "assistant", uuid: `a-stop${n}`, message: { id: `r-stop${n}`, content: [{ type: "tool_use", id: `toolu_stop${n}`, name: options.name ?? "TaskStop", input: options.input ?? { task_id: task } }] } },
  { ...claudeBase, type: "user", uuid: `u-stop${n}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_stop${n}`, content: typeof result === "string" ? result : JSON.stringify(result), ...(options.error ? { is_error: true } : {}) }] }, ...(typeof result === "object" ? { toolUseResult: result } : {}) },
];
const done = { ...claudeBase, type: "assistant", uuid: "a-end", message: { id: "r-end", content: [{ type: "text", text: "Stopped the watch and the dev server; done." }] } };
type Fixture = Awaited<ReturnType<typeof observerFixture>>;
const turn = (x: Fixture, running: boolean) => { x.actor.status = running ? "running" : "idle"; x.actor.activeTurn = running ? { turnId: `turn-${Date.now()}`, startedAt: claudeBase.timestamp } : null; };

test("a Monitor and a background command left running by an earlier turn and stopped with TaskStop are closed as stopped, out of the seal and the ACK", async () => {
  const x = await observerFixture({ provider: "claude", running: true });
  await x.append([...monitorStart, ...bashStart]); await x.poll();
  turn(x, false); await x.poll();
  expect(successorView(await x.read())).toMatchObject({ background: [expect.stringMatching(/^exec_session:open:bn9u7frii:/), expect.stringMatching(/^exec_session:open:bk7p2q9x1:/)], open: 2 });
  // The next turn: the agent stops both (Claude Code's loop guidance: "If you armed a Monitor for this loop, TaskStop it now").
  turn(x, true);
  await x.append([...stop("bn9u7frii", 1, stopResult("bn9u7frii", "local_monitor", monitorInput.command)), ...stop("bk7p2q9x1", 2, stopResult("bk7p2q9x1", "local_bash", "npm run dev")), done]);
  await x.poll();
  turn(x, false); await x.poll();
  const sealed = await x.seal(), view = successorView(await x.read());
  expect(view.background).toEqual([expect.stringMatching(/^exec_session:closed:bn9u7frii:Monitor: watch the staging deploy:stopped$/), expect.stringMatching(/^exec_session:closed:bk7p2q9x1:npm run dev:stopped$/)]);
  expect(view).toMatchObject({ open: 0, notes: [], gaps: [] });
  expect(JSON.parse(sealed.prompt.slice(sealed.prompt.indexOf("\n") + 1)).openIds).toEqual([]);
});

test("a stop in the same turn as the start leaves no open work", async () => {
  const x = await observerFixture({ provider: "claude", running: true });
  await x.append([...monitorStart, ...bashStart]); await x.poll();
  await x.append([...stop("bn9u7frii", 1, stopResult("bn9u7frii", "local_monitor", monitorInput.command)), ...stop("bk7p2q9x1", 2, stopResult("bk7p2q9x1", "local_bash", "npm run dev")), done]);
  turn(x, false); await x.poll(); await x.poll();
  const sealed = await x.seal(), view = successorView(await x.read());
  expect(view.open).toBe(0);
  expect(view.background.filter((item) => !item.includes(":closed:"))).toEqual([]);
  expect(JSON.parse(sealed.prompt.slice(sealed.prompt.indexOf("\n") + 1)).openIds).toEqual([]);
});

test("a failed stop, or a result that does not say it stopped, leaves the task as it was", async () => {
  const x = await observerFixture({ provider: "claude" });
  await x.append([...bashStart]); await x.poll();
  await x.append([...stop("bk7p2q9x1", 1, "<tool_use_error>No task found with ID: bk7p2q9x1</tool_use_error>", { error: true }), ...stop("bk7p2q9x1", 2, "Task bk7p2q9x1 is not running.")]);
  await x.poll();
  const view = successorView(await x.read());
  expect(view.background).toEqual([expect.stringMatching(/^exec_session:open:bk7p2q9x1:/)]);
  expect(view.open).toBe(1);
  expect(view.notes).toEqual([expect.stringMatching(/^background:TaskStop failed \(call toolu_stop1\); what it targeted keeps its state: .*No task found with ID: bk7p2q9x1/)]);
});

test("Paseo's TaskStop row in the turn-end timeline, and KillShell from older Claude Code versions, close their task", async () => {
  const x = await observerFixture({ provider: "claude" }); // empty transcript: only the hook speaks
  const shellRow = { type: "tool_call", callId: "toolu_bg1", name: "Bash", status: "completed", detail: { type: "shell", command: "npm run dev", input: { command: "npm run dev", run_in_background: true }, output: "Command running in background with ID: bk7p2q9x1. Output is being written to: /tmp/synthetic/tasks/bk7p2q9x1.output" } };
  const stopRow = { type: "tool_call", callId: "toolu_stop1", name: "TaskStop", status: "completed", error: null, detail: { type: "unknown", input: { task_id: "bk7p2q9x1" }, output: JSON.stringify(stopResult("bk7p2q9x1", "local_bash", "npm run dev")) } };
  await x.hook([shellRow, { type: "assistant_message", text: "Started the dev server." }]);
  expect(successorView(await x.read()).open).toBe(1);
  await x.hook([shellRow, { type: "assistant_message", text: "Started the dev server." }, stopRow, { type: "assistant_message", text: "Stopped it." }]);
  expect(successorView(await x.read())).toMatchObject({ background: [expect.stringMatching(/^exec_session:closed:bk7p2q9x1:.*:stopped$/)], open: 0 });
  // Older Claude Code: background shells are bash_<n>, stopped with KillShell {shell_id}.
  const legacy = await observerFixture({ provider: "claude" });
  await legacy.append([
    { ...claudeBase, type: "assistant", uuid: "a1", message: { id: "r1", content: [{ type: "tool_use", id: "toolu_old1", name: "Bash", input: { command: "npm run dev", run_in_background: true } }] } },
    { ...claudeBase, type: "user", uuid: "u1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old1", content: "Command running in background with ID: bash_1" }] } },
  ]);
  await legacy.poll();
  expect(successorView(await legacy.read()).open).toBe(1);
  await legacy.append(stop("bash_1", 1, { success: true, message: "Successfully killed shell: bash_1 (npm run dev)", shell_id: "bash_1" }, { name: "KillShell", input: { shell_id: "bash_1" } }));
  await legacy.poll();
  expect(successorView(await legacy.read())).toMatchObject({ background: [expect.stringMatching(/^exec_session:closed:bash_1:npm run dev:stopped$/)], open: 0 });
});
