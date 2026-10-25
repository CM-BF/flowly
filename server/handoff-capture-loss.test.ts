/**
 * Information-loss invariants of passive capture (review of 2026-10-25, after the noise fix).
 * Every text is synthetic; the record shapes follow Codex rollouts, Paseo timelines and the
 * paseo-dynamic-workflow / paseo-async-shell plugin sources.
 */
import { afterEach, expect, test, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { captureHandoff, captureTimeline, type CaptureCursor } from "./handoff-capture";
import { HandoffObserver, type HandoffObserverDeps } from "./handoff-observer";
import { HandoffStore } from "./handoff-store";
import { BoardStore } from "./store";
import { forgetHistory } from "./provider-history";
import { handoffOpenIds, type CardHandoff } from "../shared/handoff";

const roots: string[] = [], observers: HandoffObserver[] = [];
afterEach(async () => { forgetHistory(); await Promise.all(observers.splice(0).map((observer) => observer.stop())); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const at = "2026-10-25T02:00:00.000Z";
const uuid = "019a15e5-0000-7abc-8def-0123456789ab";
const json = (value: unknown) => JSON.stringify(value) + "\n";
const event = (type: string, data: Record<string, unknown> = {}) => ({ timestamp: at, type: "event_msg", payload: { type, ...data } });
const response = (type: string, data: Record<string, unknown>) => ({ timestamp: at, type: "response_item", payload: { type, ...data } });
const item = (value: Record<string, unknown>) => event("item_completed", { thread_id: uuid, turn_id: "t", item: value });
const script = (callId: string, input: string) => response("custom_tool_call", { call_id: callId, id: `ctc_${callId}`, status: "completed", name: "exec", input });
const scriptOutput = (callId: string, ...printed: string[]) => response("custom_tool_call_output", { call_id: callId, output: [{ type: "input_text", text: "Script completed\nWall time 0.5 seconds\nOutput:\n" }, ...printed.map((text) => ({ type: "input_text", text }))] });
const commandDone = (itemId: string, pid: string, cmd: string, exit = 0, output = "") => item({ type: "CommandExecution", id: itemId, process_id: pid, command: ["/bin/zsh", "-lc", cmd], status: "completed", exit_code: exit, aggregated_output: output });
const folder = (home: string) => { const stamp = new Date(parseInt(uuid.replace(/-/g, "").slice(0, 12), 16)); return join(home, "sessions", String(stamp.getFullYear()), String(stamp.getMonth() + 1).padStart(2, "0"), String(stamp.getDate()).padStart(2, "0")); };

async function codex(options: { maxLineBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "flowly-capture-loss-")); roots.push(root);
  const home = join(root, "codex"); await mkdir(folder(home), { recursive: true });
  const path = join(folder(home), `rollout-loss-${uuid}.jsonl`); await writeFile(path, "");
  const agent = { id: "managed-agent", provider: "codex", cwd: root, persistence: { provider: "codex", nativeHandle: uuid, sessionId: uuid } };
  const capture = (cursor?: CaptureCursor) => captureHandoff(agent, cursor, { codexHome: home, claudeHome: join(root, "unused"), now: () => Date.parse(at), ...options });
  return { capture, write: (lines: unknown[]) => writeFile(path, lines.map(json).join("")), append: (lines: unknown[]) => appendFile(path, lines.map(json).join("")) };
}
/** What a capture leaves for the card: background that is not closed, gaps, inputs and notes. */
const visible = (b: Awaited<ReturnType<typeof captureHandoff>>) => ({
  background: b.background.filter((entry) => !entry.closeOnly && entry.status !== "closed").map((entry) => `${entry.kind}:${entry.status}:${entry.handle ?? ""}:${entry.label ?? ""}`),
  gaps: b.gaps.map((gap) => gap.kind), inputs: b.inputs.map((input) => input.text) });

async function observerFixture(options: { maxLineBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "flowly-capture-loss-observer-")); roots.push(directory);
  const board = new BoardStore(directory), records = new HandoffStore(directory), home = join(directory, "synthetic-codex");
  await board.mutate((value) => {
    value.projects.push({ id: "project", title: "P", description: "", paseoProjectId: "native", primaryPath: directory, repos: [directory], revision: 1, createdAt: at, updatedAt: at, archivedAt: null });
    value.tasks.push({ id: "card", projectId: "project", workspaceId: "workspace", sourcePath: directory, repoPaths: [], title: "Card", description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: "create", createdAt: at, updatedAt: at, archivedAt: null });
  });
  await mkdir(folder(home), { recursive: true });
  const rollout = join(folder(home), `rollout-loss-${uuid}.jsonl`);
  await writeFile(rollout, json({ timestamp: at, type: "session_meta", payload: { id: uuid, session_id: uuid, cwd: directory } }));
  const actor = { id: "worker", provider: "codex", model: "gpt-fixture", workspaceId: "workspace", status: "idle", activeTurn: null, pendingPermissions: [] as unknown[], createdAt: at, updatedAt: at, lastUserMessageAt: at, persistence: { provider: "codex", nativeHandle: uuid }, archivedAt: null };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: actor }) }) } } as unknown as PaseoApi;
  const deps: HandoffObserverDeps = { records, board, paseo: () => paseo, serial: <T>(_: string, fn: () => Promise<T>) => fn(), syncIndex: async () => undefined, clock: () => Date.parse(at),
    capture: (agent, previous, o) => captureHandoff(agent, previous, { ...o, codexHome: home, claudeHome: join(home, "unused"), ...(options.maxLineBytes ? { maxLineBytes: options.maxLineBytes } : {}) }),
    git: vi.fn(async () => ({ snapshots: [], unchecked: [] })) };
  const observer = new HandoffObserver(deps); observers.push(observer);
  const read = () => records.read("card", "project");
  const ack = async (disposition: "done" | "obsolete", note: string, filter: (id: string) => boolean = () => true) => {
    const record = await read();
    await records.update("card", "project", { handoffRevision: record.revision, ack: { handoffRevision: record.revision, heads: [], understanding: "synthetic", items: handoffOpenIds(record).filter(filter).map((id) => ({ id, disposition, note })) } }, { by: { kind: "agent", agentId: "worker" } }, { agentId: "worker", actualHeads: [] });
  };
  return { observer, records, rollout, read, ack, append: (lines: unknown[]) => appendFile(rollout, lines.map(json).join("")), poll: () => observer.observe("card", "worker") };
}
const background = (record: CardHandoff) => record.ledger.flatMap((session) => session.background);
const pending = (record: CardHandoff) => background(record).filter((entry) => entry.status !== "closed");

// ---------------------------------------------------------------- background completion notices (loss-F1, loss-F7)
test("a failed Workflow keeps its outcome on the closed item and leaves a note with its status, failures and recovery", async () => {
  const x = await observerFixture();
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [
    { type: "tool_call", name: "Workflow", callId: "wf-ok", status: "completed", detail: { input: { scriptPath: "/tmp/wf/review.js" }, output: "Workflow launched in background. Task ID: task_wf1 Summary: synthetic review" } },
    { type: "user_message", text: "<task-notification>\n<task-id>task_wf1</task-id>\n<tool-use-id>wf-ok</tool-use-id>\n<status>failed</status>\n<summary>Workflow \"review\" failed: 2 of 5 agents failed</summary>\n<failures>reviewer-3: synthetic timeout</failures>\n<recovery>Resume with resumeFromRunId to reuse 3 cached results.</recovery>\n</task-notification>" },
  ] });
  const record = await x.read();
  expect(background(record)).toEqual([expect.objectContaining({ ref: "task_wf1", status: "closed", outcome: "failed" })]);
  const notes = record.notes.filter((note) => note.text.includes("task_wf1"));
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ kind: "hazard" });
  expect(notes[0].text).toMatch(/status failed/); expect(notes[0].text).toContain("reviewer-3: synthetic timeout"); expect(notes[0].text).toContain("resumeFromRunId");
  expect(record.inputs).toEqual([]);
  // A replay of the same timeline adds nothing.
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [{ type: "user_message", text: "<task-notification>\n<task-id>task_wf1</task-id>\n<status>failed</status>\n<summary>Workflow \"review\" failed: 2 of 5 agents failed</summary>\n<failures>reviewer-3: synthetic timeout</failures>\n<recovery>Resume with resumeFromRunId to reuse 3 cached results.</recovery>\n</task-notification>" }] });
  expect((await x.read()).notes.filter((note) => note.text.includes("task_wf1"))).toHaveLength(1);
});

test("the notice of a launch Flowly never itemized is still on the card: an interrupted dynamic workflow and a background agent's result", async () => {
  const x = await observerFixture();
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [
    { type: "user_message", text: "[paseo-dynamic-workflow] A background workflow you launched has ended. This message comes from the plugin, not from the user.\n<task-notification>\n<task-id>wf_cli1</task-id>\n<status>interrupted</status>\n<summary>Dynamic workflow \"audit\" was interrupted</summary>\n<recovery>Resume with resumeFromRunId wf_cli1.</recovery>\n<interrupted-agents>\n1 agent(s) were cut off and their partial work is not cached.\naudit-3: agent agent-synthetic-77\n</interrupted-agents>\n</task-notification>" },
    { type: "user_message", text: "<task-notification>\n<task-id>a1b2c3d4</task-id>\n<tool-use-id>ag-1</tool-use-id>\n<status>completed</status>\n<summary>Agent \"audit\" completed</summary>\n<result>Found 3 synthetic issues; the second needs the owner's decision.</result>\n</task-notification>" },
    { type: "user_message", text: "<task-notification>\n<task-id>bsh42</task-id>\n<output-file>/tmp/synthetic/bsh42.output</output-file>\n<status>completed</status>\n<summary>Background command \"npm test\" completed (exit code 0)</summary>\n</task-notification>" },
  ] });
  const record = await x.read(), texts = record.notes.map((note) => note.text).join("\n");
  expect(texts).toContain("wf_cli1"); expect(texts).toContain("interrupted"); expect(texts).toContain("agent-synthetic-77");
  expect(texts).toContain("Found 3 synthetic issues");
  // Untracked and completed without result blocks: the note is the only trace, so it is kept too.
  expect(texts).toContain("bsh42"); expect(texts).toContain("/tmp/synthetic/bsh42.output");
  expect(record.inputs).toEqual([]); expect(record.gaps).toEqual([]);
});

test("a tracked completion without result blocks only closes its item; long results are bounded and redacted in the note", () => {
  const long = `${"synthetic finding ".repeat(1200)} token=sk-abcdefghijklmnopqrstuvwx`;
  const b = captureTimeline("agent", [
    { type: "tool_call", name: "Workflow", callId: "wf-1", status: "completed", detail: { input: { name: "lint" }, output: "Workflow launched in background. Task ID: task_lint" } },
    { type: "user_message", text: "<task-notification>\n<task-id>task_lint</task-id>\n<status>completed</status>\n<summary>Workflow \"lint\" completed</summary>\n</task-notification>" },
    { type: "tool_call", name: "Workflow", callId: "wf-2", status: "completed", detail: { input: { name: "audit" }, output: "Workflow launched in background. Task ID: task_audit" } },
    { type: "user_message", text: `<task-notification>\n<task-id>task_audit</task-id>\n<status>completed</status>\n<summary>Workflow "audit" completed</summary>\n<result>${long}</result>\n</task-notification>` },
  ], { outcome: "completed" });
  const lint = b.background.find((entry) => entry.handle === "task_lint" && entry.closeOnly)!, audit = b.background.find((entry) => entry.handle === "task_audit" && entry.closeOnly)!;
  expect(lint).toMatchObject({ status: "closed", outcome: "completed" }); expect(lint.note?.always).toBe(false);
  expect(audit.note).toMatchObject({ always: true, kind: "background" });
  expect(audit.note!.text.length).toBeLessThanOrEqual(2000); expect(audit.note!.text).toContain("synthetic finding"); expect(audit.note!.text).not.toContain("sk-abcdefghijklmnop");
});

test("the dynamic-workflow plugin's relay of the user's Ultracode setting is kept as words on the card, not an anonymous gap", async () => {
  const x = await observerFixture();
  await x.observer.observe("card", "worker", { outcome: "completed", timeline: [
    { type: "user_message", text: "[paseo-dynamic-workflow] The user turned Ultracode off for you in Paseo. This message comes from the plugin, not from the user.\n<ultracode>off</ultracode>\nWorkflows are also turned off for you: do not launch any until the user enables them again. Reply only \"Ultracode off.\" and wait for the user's next request." },
  ] });
  const record = await x.read();
  expect(record.gaps).toEqual([]);
  expect(record.inputs).toEqual([expect.objectContaining({ via: "agent", from: expect.objectContaining({ title: "paseo-dynamic-workflow" }), status: "received", text: expect.stringContaining("do not launch any") })]);
});
