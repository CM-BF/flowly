import { afterEach, expect, test } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureHandoff, captureLimits, captureTimeline, type CaptureCursor } from "./handoff-capture";
import { forgetHistory, historyBytes, locateProviderHistory } from "./provider-history";
const roots: string[] = [];
afterEach(async () => { forgetHistory(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const at = "2026-10-24T00:00:00.000Z";
const uuid = "019a15e5-0000-7abc-8def-0123456789ab";
const json = (value: unknown) => JSON.stringify(value) + "\n";
const event = (type: string, data: Record<string, unknown> = {}) => ({ timestamp: at, type: "event_msg", payload: { type, ...data } });
const response = (type: string, data: Record<string, unknown>) => ({ timestamp: at, type: "response_item", payload: { type, ...data } });
async function fixture(provider: "codex" | "claude" = "codex") {
  const root = await mkdtemp(join(tmpdir(), "flowly-handoff-capture-")); roots.push(root);
  const home = join(root, provider), date = new Date(parseInt(uuid.replace(/-/g, "").slice(0, 12), 16));
  const dir = provider === "codex" ? join(home, "sessions", String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")) : join(home, "projects", "old-project-name");
  await mkdir(dir, { recursive: true }); const path = join(dir, provider === "codex" ? `rollout-date-${uuid}.jsonl` : `${uuid}.jsonl`);
  await writeFile(path, "");
  const agent = { id: "managed-agent", provider, cwd: join(root, "moved-project"), persistence: { provider, nativeHandle: uuid, sessionId: uuid } };
  const options = { codexHome: provider === "codex" ? home : join(root, "unused-codex"), claudeHome: provider === "claude" ? home : join(root, "unused-claude"), now: () => Date.parse(at) };
  return { root, home, path, agent, options, capture: (cursor?: CaptureCursor, extra: Parameters<typeof captureHandoff>[2] = {}) => captureHandoff(agent, cursor, { ...options, ...extra }) };
}

test("native source ids preserve repeated human words, replay exactly, and append resumes without re-reading earlier messages", async () => {
  const x = await fixture(); await writeFile(x.path, json(event("user_message", { message: "继续" })) + json(event("user_message", { message: "继续" })));
  const first = await x.capture(), replay = await x.capture();
  expect(first.inputs.map((m) => m.text)).toEqual(["继续", "继续"]); expect(new Set(first.inputs.map((m) => m.id)).size).toBe(2);
  expect(replay.inputs.map((m) => m.id)).toEqual(first.inputs.map((m) => m.id)); expect(first.coverage.complete).toBe(true);
  await appendFile(x.path, json(event("user_message", { message: "下一步", message_id: "human-3" })));
  const next = await x.capture(first.cursor); expect(next.inputs.map((m) => m.messageId)).toEqual(["human-3"]); expect(next.coverage.from).toBe(first.cursor!.offset);
  expect((await x.capture(next.cursor)).inputs).toEqual([]);
});

test("partial lines stay before cursor until completed; malformed and unknown complete records are visible gaps", async () => {
  const x = await fixture(); const first = json(event("user_message", { message: "first" })), second = json(event("user_message", { message: "second" }));
  await writeFile(x.path, first + second.slice(0, -2)); const a = await x.capture();
  expect(a.inputs.map((m) => m.text)).toEqual(["first"]); expect(a.cursor!.offset).toBe(Buffer.byteLength(first)); expect(a.gaps.map((g) => g.kind)).toContain("partial_line");
  await appendFile(x.path, second.slice(-2) + "{broken}\n" + json({ type: "future-kind", payload: { doNotKeep: "unrelated" } }));
  const b = await x.capture(a.cursor); expect(b.inputs.map((m) => m.text)).toEqual(["second"]); expect(b.gaps.map((g) => g.kind)).toEqual(expect.arrayContaining(["parse_failed", "unknown_record_type"])); expect(b.coverage.complete).toBe(true);
});

test("long lines use a resumable skip state, exact byte growth and a gap instead of retaining tool output", async () => {
  const x = await fixture(); const secret = "sk-THISISASECRETVALUE1234567890123456789";
  const huge = json(response("function_call_output", { output: secret + "x".repeat(320_000) }));
  const last = json(event("user_message", { message: "after long output" })); await writeFile(x.path, huge + last);
  let cursor: CaptureCursor | undefined, skipped = 0, growth = 0, got: string[] = [], complete = false;
  for (let i = 0; i < 8 && !complete; i++) {
    const batch = await x.capture(cursor, { maxBytes: 70_000, maxLineBytes: 16_000 });
    expect(batch.coverage.readBytes).toBeLessThanOrEqual(70_000); expect(JSON.stringify(batch)).not.toContain(secret);
    skipped += batch.coverage.skippedBytes; growth += Object.values(batch.growth).reduce((n, v) => n + v.bytes, 0); got.push(...batch.inputs.map((m) => m.text)); cursor = batch.cursor; complete = batch.coverage.complete;
  }
  expect(complete).toBe(true); expect(skipped).toBe(Buffer.byteLength(huge)); expect(growth).toBe(Buffer.byteLength(huge + last)); expect(got).toEqual(["after long output"]);
});

test("default 256 KiB cap skips an oversized human input without claiming its original text was preserved", async () => {
  const x = await fixture(); await writeFile(x.path, json(event("user_message", { message: "u".repeat(captureLimits.line + 1) })));
  const b = await x.capture(); expect(b.inputs).toEqual([]); expect(b.gaps).toContainEqual(expect.objectContaining({ kind: "long_line", bytes: (await readFile(x.path)).length }));
});

test("file truncation, same-inode rewrite and archived relocation preserve explicit continuity coverage", async () => {
  const x = await fixture(); await writeFile(x.path, json(event("user_message", { message: "original original original" }))); const a = await x.capture();
  await writeFile(x.path, json(event("user_message", { message: "new" }))); const b = await x.capture(a.cursor);
  expect(b.gaps.map((g) => g.kind)).toContain("file_truncated"); expect(b.inputs[0].id).not.toBe(a.inputs[0].id);
  await writeFile(x.path, json(event("user_message", { message: "rewritten and longer than original" }))); const c = await x.capture(b.cursor); expect(c.gaps.map((g) => g.kind)).toContain("file_replaced");
  const archive = join(x.home, "archived_sessions"); await mkdir(archive); await rename(x.path, join(archive, `rollout-date-${uuid}.jsonl`));
  const d = await x.capture(c.cursor); expect(d.inputs).toEqual([]); expect(d.gaps.map((g) => g.kind)).toContain("file_moved");
});

test("capture handles provider messages and real Paseo envelopes without mistaking notifications for human instructions", async () => {
  const x = await fixture(); const wrapped = '<paseo-system version="1" kind="agent-notification" source-agent-id="child-1" message-id="notice-1" source-agent-title="Child" event="finished">\nDone &amp; verified\n</paseo-system>';
  const humanQuoted = '<paseo-system version="1" kind="user-message" message-id="human-quoted">\n&lt;paseo-system&gt;quoted&lt;/paseo-system&gt;\n</paseo-system>';
  await writeFile(x.path, [event("user_message", { message: "[Flowly automation] retry" }), event("user_message", { message: "[async-shell finished task-owned] done" }), event("user_message", { message: wrapped }), event("user_message", { message: humanQuoted }), event("user_message", { message: "already saved", message_id: "saved-1" }), event("agent_message", { message: wrapped })].map(json).join(""));
  const b = await x.capture(undefined, { sentMessageIds: ["saved-1"] });
  expect(b.inputs.map((m) => [m.via, m.text])).toEqual([["agent", "Done & verified"], ["session", "<paseo-system>quoted</paseo-system>"]]);
  expect(b.background.map((v) => [v.kind, v.handle, v.status])).toEqual([["async_shell", "task-owned", "closed"], ["agent", "child-1", "closed"]]);
  expect(b.live[0].text).toBe(wrapped); // assistant quotes cannot fabricate a completion notification
});

test("pending native calls survive a batch boundary; only proven handles and terminal results change background state", async () => {
  const x = await fixture(); await writeFile(x.path, json(response("function_call", { name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: "TOKEN=secret-value-123 run" }) })));
  const a = await x.capture(); expect(a.background[0].status).toBe("unknown"); expect(a.gaps.map((g) => g.kind)).toContain("background_handle_pending");
  await appendFile(x.path, json(response("function_call_output", { call_id: "c1", output: JSON.stringify({ session_id: 12345, output: "large result should not be kept" }) })));
  const b = await x.capture(a.cursor); expect(b.background).toContainEqual(expect.objectContaining({ kind: "exec", handle: "12345", status: "open" })); expect(JSON.stringify(b)).not.toContain("secret-value-123");
  await appendFile(x.path, [response("function_call", { name: "write_stdin", call_id: "c2", arguments: JSON.stringify({ session_id: 12345 }) }), response("function_call_output", { call_id: "c2", output: JSON.stringify({ exit_code: 0, output: "not retained" }) }), response("function_call", { name: "functions.exec", call_id: "opaque", arguments: "nested source" })].map(json).join(""));
  const c = await x.capture(b.cursor); expect(c.background).toContainEqual(expect.objectContaining({ handle: "12345", status: "closed" })); expect(c.gaps.map((g) => g.kind)).toContain("opaque_tool_background");
});

test("Codex usage/compaction and narration have independent stable ids, bounded text and credential redaction", async () => {
  const x = await fixture(); await writeFile(x.path, [event("token_count", { info: null }), event("token_count", { info: { last_token_usage: { total_tokens: 500 }, model_context_window: 475000 } }), { type: "compacted", payload: {} }, { type: "compacted", payload: { latest_token_usage_record: { valid: true } } }, ...Array.from({ length: 12 }, (_, i) => event("agent_message", { message: `${i} Authorization: Bearer secret-token-value-123\n${"content ".repeat(150)}` }))].map(json).join(""));
  const b = await x.capture(); expect(b.usage[0]).toMatchObject({ contextTokens: 500, initialContextTokens: 500, windowTokens: 475000 }); expect(b.compactions).toHaveLength(1);
  expect(b.live.length).toBeLessThanOrEqual(8); expect(b.live.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(4000); expect(b.narrationOmitted).toBeGreaterThan(0); expect(b.narrationTrimmedChars).toBeGreaterThan(0); expect(JSON.stringify(b)).not.toContain("secret-token-value-123");
});

test("Claude main-chain records preserve user ids, ignore sidechains/tool results, and capture real cache and compact fields", async () => {
  const x = await fixture("claude"); await writeFile(x.path, [
    { type: "user", uuid: "u1", timestamp: at, message: { content: "Keep the actual long requirement " + "x".repeat(10000) } },
    { type: "user", uuid: "tool-result", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "unused", content: "PRIVATE TOOL RESULT" }, { type: "text", text: "not a person's instruction" }] } },
    { type: "assistant", isSidechain: true, uuid: "child", message: { content: [{ type: "text", text: "private child" }] } },
    { type: "assistant", uuid: "a1", timestamp: at, message: { id: "request-1", content: [{ type: "text", text: "Observed current state" }], usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 100 } } } },
    { type: "system", subtype: "compact_boundary", timestamp: at, compactMetadata: { preTokens: 967000 } },
  ].map(json).join(""));
  const b = await x.capture(); expect(b.inputs).toHaveLength(1); expect(b.inputs[0].messageId).toBe("u1"); expect(b.inputs[0].text.length).toBeGreaterThan(10000); expect(b.live.map((m) => m.text)).toEqual(["Observed current state"]);
  expect(b.usage[0]).toMatchObject({ contextTokens: 135, initialContextTokens: 135, cacheTtlSeconds: 3300, messageId: "request-1" }); expect(b.compactions[0].preTokens).toBe(967000); expect(JSON.stringify(b)).not.toContain("PRIVATE TOOL RESULT");
  expect(await historyBytes(x.agent, x.options.codexHome)).toBeNull(); // P1 does not repurpose Codex's guard for Claude.
});

test("timeline replays distinguish repeated id-less words and use the same message id keys as provider capture", async () => {
  const items = [{ type: "user_message", text: "继续" }, { type: "user_message", text: "继续" }, { type: "user_message", text: "id message", messageId: "same-id" }, { type: "assistant_message", text: "done" }];
  const a = captureTimeline("managed-agent", items, { outcome: "completed", now: () => Date.parse(at) }), b = captureTimeline("managed-agent", items, { outcome: "failed", now: () => Date.parse(at) });
  expect(a.inputs).toHaveLength(3); expect(a.inputs[0].id).not.toBe(a.inputs[1].id); expect(a.inputs.map((m) => m.id)).toEqual(b.inputs.map((m) => m.id)); expect(a.inputs.every((m) => m.status === "received")).toBe(true); expect(b.inputs.every((m) => m.status === "open")).toBe(true);
  const x = await fixture(); await writeFile(x.path, json(event("user_message", { message: "id message", message_id: "same-id" }))); expect((await x.capture()).inputs[0].id).toBe(a.inputs[2].id);
});

test("record and byte budgets leave visible backlog; abort can resume from the last committed source range", async () => {
  const x = await fixture(); await writeFile(x.path, Array.from({ length: 30 }, (_, i) => json(event("user_message", { message: `message ${i}` }))).join(""));
  const first = await x.capture(undefined, { maxRecords: 2 }); expect(first.inputs).toHaveLength(2); expect(first.gaps.map((g) => g.kind)).toContain("record_budget");
  let checks = 0; const signal = { get aborted() { return ++checks > 8; } } as AbortSignal;
  const aborted = await x.capture(first.cursor, { signal }); expect(aborted.coverage.aborted).toBe(true);
  const resumed = await x.capture(aborted.cursor ?? first.cursor); const ids = [...first.inputs, ...aborted.inputs, ...resumed.inputs].map((m) => m.id); expect(new Set(ids).size).toBe(30); expect(ids).toHaveLength(30);
});

test("locator refuses path handles, outside symlinks and unsupported providers, preserving the Codex size guard", async () => {
  const x = await fixture(); await writeFile(x.path, json(event("user_message", { message: "safe" })));
  expect(await historyBytes(x.agent, x.home)).toBe((await readFile(x.path)).length);
  expect(await locateProviderHistory({ ...x.agent, persistence: { provider: "codex", nativeHandle: "../../etc/passwd" } }, x.options)).toEqual({ reason: "invalid_session" });
  const outside = join(x.root, "outside.jsonl"); await writeFile(outside, "outside-private"); await rm(x.path); await symlink(outside, x.path);
  const b = await x.capture(); expect(b.inputs).toEqual([]); expect(b.gaps[0].kind).toBe("source_missing");
  expect((await captureHandoff({ id: "managed-other", provider: "pi" }, undefined, x.options)).gaps[0].kind).toBe("unsupported_provider");
});

test("a production 64 MiB read ceiling holds even for a larger caller budget and a sparse synthetic long line", async () => {
  const x = await fixture(); const { truncate } = await import("node:fs/promises");
  await truncate(x.path, captureLimits.bytes + 1024); await appendFile(x.path, "\n" + json(event("user_message", { message: "after budget" })));
  const first = await x.capture(undefined, { maxBytes: captureLimits.bytes * 2 });
  expect(first.coverage.readBytes).toBe(captureLimits.bytes); expect(first.cursor!.offset).toBe(captureLimits.bytes); expect(first.cursor!.skipping).toBeDefined(); expect(first.coverage.complete).toBe(false);
  const next = await x.capture(first.cursor); expect(next.inputs.map((m) => m.text)).toEqual(["after budget"]); expect(next.coverage.complete).toBe(true);
});

test("failed tools, large results, detached shell commands and unknown system envelopes never invent successful work", () => {
  const b = captureTimeline("a", [
    { type: "tool_call", name: "register_async_shell", callId: "fail", status: "failed", detail: { input: {}, output: { task_id: "not-proven", error: "create failed" } } },
    { type: "tool_call", name: "exec_command", callId: "large", status: "completed", detail: { input: { cmd: "run" }, output: "private-result".repeat(30000) } },
    { type: "tool_call", name: "exec_command", callId: "nohup", status: "completed", detail: { input: { cmd: "nohup my-task &" }, output: { exit_code: 0 } } },
    { type: "user_message", text: "<paseo-system version=unknown>notification</paseo-system>" },
  ]);
  expect(b.inputs).toEqual([]); expect(b.background.every((item) => item.status === "unknown")).toBe(true);
  expect(b.gaps.map((g) => g.kind)).toEqual(expect.arrayContaining(["background_tool_failed", "large_tool_result_omitted", "detached_background_untracked", "unknown_system_envelope"])); expect(JSON.stringify(b)).not.toContain("private-result");
});

test("JSON-form credentials and incomplete private keys are removed before originals or labels leave capture", () => {
  const token = "my-sensitive-value-123", key = "verySecretPrivateKeyMaterial";
  const b = captureTimeline("a", [{ type: "user_message", text: `Use config {"api_key": "${token}"}; keep docs in /repo/docs.\n-----BEGIN PRIVATE KEY-----\n${key}` }]);
  expect(JSON.stringify(b)).not.toContain(token); expect(JSON.stringify(b)).not.toContain(key); expect(b.inputs[0].text).toContain("/repo/docs");
});

test("background schedule and heartbeat triggers do not count as their cancellation", () => {
  const b = captureTimeline("a", [
    { type: "tool_call", name: "create_schedule", callId: "s", status: "completed", detail: { input: {}, output: { scheduleId: "schedule-1" } } },
    { type: "user_message", text: '<paseo-system version="1" kind="agent-message" source-agent-id="scheduler" message-id="trigger">\nSchedule fired\n</paseo-system>' },
    { type: "user_message", text: "<paseo-system>\nHeartbeat fired\n</paseo-system>" },
  ]);
  expect(b.background).toContainEqual(expect.objectContaining({ kind: "schedule", handle: "schedule-1", status: "open" })); expect(b.background.some((item) => item.status === "closed")).toBe(false); expect(b.inputs.every((input) => input.via === "agent")).toBe(true); expect(b.inputs).toHaveLength(2);
});

test("a mismatched native session header prevents later text from a different session being captured", async () => {
  const x = await fixture(); await writeFile(x.path, json({ type: "session_meta", payload: { id: "another-session" } }) + json(event("user_message", { message: "foreign private requirement" })));
  const batch = await x.capture(); expect(batch.inputs).toEqual([]); expect(batch.gaps[0].kind).toBe("session_identity_mismatch"); expect(batch.coverage.complete).toBe(false); expect(batch.cursor).toBeUndefined();
  await appendFile(x.path, json(event("user_message", { message: "another foreign requirement" }))); expect((await x.capture(batch.cursor)).inputs).toEqual([]);
});

test("invalid persisted probe ranges are reset without allocating an arbitrary large buffer", async () => {
  const x = await fixture(); await writeFile(x.path, json(event("user_message", { message: "safe" }))); const first = await x.capture();
  const next = await x.capture({ ...first.cursor!, prefix: { length: Number.MAX_SAFE_INTEGER, hash: "bad" } });
  expect(next.inputs.map((m) => m.text)).toEqual(["safe"]); expect(next.coverage.readBytes).toBeLessThan(1024); expect(next.gaps.map((g) => g.kind)).toContain("file_replaced");
});

test("quoted JSON credential headers are redacted in both original messages and narration", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  for (const text of [`{"Authorization":"Bearer ${secret}"}`, `{'Authorization': 'Basic ${secret}'}`, `{"api-key":"${secret}"}`]) {
    const batch = captureTimeline("managed", [{ type: "user_message", text }, { type: "assistant_message", text }]);
    expect(JSON.stringify(batch)).not.toContain(secret); expect(batch.inputs[0].redacted).toBe(true);
  }
});
