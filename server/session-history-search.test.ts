import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionHistoryPage } from "../shared/session-history";
import { SessionHistory } from "./session-history";
import { HistoryRecords } from "./session-history-records";
import { releaseHistory } from "./session-history-fixture";

const roots: string[] = [], readers: SessionHistory[] = [];
// Every manifest these tests publish is one read() accepts (SESSION-HANDOFF-SPEC §21.16).
afterEach(async () => { expect(await releaseHistory(readers, roots)).toEqual([]); });
const id = "01a1756e-0561-7d21-845f-0000000000b2";
const json = (value: unknown) => JSON.stringify(value) + "\n";

async function indexed(records: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "flowly-history-search-")); roots.push(root);
  const folder = join(root, "codex", "sessions", "2026", "10", "25"); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `rollout-search-${id}.jsonl`), [{ type: "session_meta", payload: { id } }, ...records].map(json).join(""));
  const reader = new SessionHistory(join(root, "derived"), { codexHome: join(root, "codex") }); readers.push(reader);
  const agent = { id: "search", provider: "codex", persistence: { provider: "codex", nativeHandle: id, sessionId: id } };
  await reader.read(agent as never, { session: "#1" });
  await vi.waitFor(async () => { expect((await reader.read(agent as never, { session: "#1" })).status).toBe("ready"); }, { timeout: 10_000, interval: 10 });
  return (query: string): Promise<SessionHistoryPage> => reader.read(agent as never, { session: "#1", query });
}

test("escaped text kept as written is found by its decoded words: quotes, escaped newlines and \\u-escaped CJK", async () => {
  const inner = JSON.stringify({ content: [{ type: "text", text: 'FAIL src/sum.test.ts > adds\nAssertionError: expected "3" to be "4"\n' }] });
  const python = '{"summary": "\\u6d4b\\u8bd5\\u5931\\u8d25\\uff1a\\u7b49\\u5f85\\u4fee\\u590d", "ok": false}'; // json.dumps, ensure_ascii
  const search = await indexed([
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: "text(JSON.stringify(await tools.run_tests({})));" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: `Script completed\nOutput:\n${JSON.stringify(inner)}` }] } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "c2", name: "exec", input: "text(await tools.py_report({}));" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c2", output: [{ type: "input_text", text: `Script completed\nOutput:\n${python}` }] } },
  ]);
  expect((await search("AssertionError: expected")).entries).toHaveLength(1);
  const quoted = (await search('expected "3" to be "4"')).entries;
  expect(quoted).toHaveLength(1); expect(quoted[0]).toMatchObject({ decoded: true, tool: { kind: "output" } }); expect(quoted[0].text).toContain('AssertionError: expected "3" to be "4"');
  expect((await search("adds\nAssertionError")).entries).toHaveLength(1);
  const cjk = (await search("测试失败")).entries;
  expect(cjk).toHaveLength(1); expect(cjk[0].text).toContain("测试失败：等待修复");
  // A plain match is shown as stored, still escaped, so its characters keep mapping onto the source.
  const plain = (await search("AssertionError: expected")).entries[0];
  expect(plain.decoded).toBeUndefined(); expect(plain.text).toContain('\\\\\\"3\\\\\\"');
});

test("readable Claude thinking that the index leaves out is reported as an intentional gap", () => {
  const sid = "019a15e5-0000-7abc-8def-0123456789ab", index = new HistoryRecords(sid);
  let offset = 0;
  for (const record of [
    { type: "user", sessionId: sid, timestamp: "2026-10-25T10:00:00.000Z", message: { role: "user", content: "run the tests" } },
    { type: "assistant", sessionId: sid, timestamp: "2026-10-25T10:00:01.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "THINKING-MARKER: the flaky test is sum.test.ts", signature: "sig" }, { type: "redacted_thinking", data: "opaque" }, { type: "text", text: "Running them." }] } },
  ]) { const raw = Buffer.from(json(record)); index.line(raw, "claude", "main", offset, offset + raw.length, false); offset += raw.length; }
  const meta = index.metadata();
  expect(index.body()).not.toContain("THINKING-MARKER"); expect(index.body()).toContain("Running them.");
  expect(meta.gaps).toContainEqual({ kind: "thinking_omitted", count: 2 });
  // Like Codex's encrypted reasoning: the index never claims the model's reasoning (§21.3), so it stays complete.
  expect(meta.coverage.complete).toBe(true);
});
