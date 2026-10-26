import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionHistoryLimits, type SessionHistoryEntry, type SessionHistoryPage } from "../shared/session-history";
import { rotationLimits } from "../shared/session-rotation";
import { SessionHistory } from "./session-history";
import { forgetHistory } from "./provider-history";
import { filler, replicaCodeword } from "./session-history-fixture";

const roots: string[] = [], readers: SessionHistory[] = [];
afterEach(async () => { await Promise.all(readers.splice(0).map((reader) => reader.stop())); forgetHistory(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/**
 * One long automation run at the size Flowly rotates at, with the per-call shape of the live P2 predecessor: a 1.2 KB
 * code-mode script, a 16 KB output, Codex's 33 KB item_completed copy, 4.3 KB of encrypted reasoning, usage records and
 * narration every other call. The last call's progress note names the codeword past 300 characters; the last output
 * ends with the test result that names it.
 */
function rotationRollout(id: string, bytes: number) {
  const at = "2026-10-25T23:29:05.000Z", line = (type: string, payload: unknown) => JSON.stringify({ timestamp: at, type, payload }) + "\n";
  const parts = [line("session_meta", { id })];
  let size = 0, calls = Infinity;
  for (let n = 0; n < calls; n++) {
    const call = `call_${n}`, last = n === calls - 1;
    const script = last ? `const t = await tools.mcp__flowly__flowly_get_task({});\n${filler(600, n)}\nawait tools.mcp__flowly__flowly_report_progress({kind:"question", note:"Stage A is ready; I mentioned ${replicaCodeword} once for the history lookup."});\n` : `const r = await tools.exec_command({cmd:"npm test -- step-${n}"});\n${filler(1100, n)}\ntext(r.output);\n`;
    const printed = `${filler(14_000, n)}\n${last ? `PASS stage-a.json parses; ${replicaCodeword}` : `Tests ${n % 5} failed | 40 passed (run ${n})`}\n`;
    let text = line("response_item", { type: "reasoning", summary: [], encrypted_content: "gAAAA" + "x".repeat(4300) });
    text += line("response_item", { type: "custom_tool_call", call_id: call, name: "exec", input: script });
    text += line("token_usage_record", { usage: { input_tokens: 40_000 + n, note: "y".repeat(800) } }) + line("event_msg", { type: "token_count", info: { note: "z".repeat(700) } });
    text += line("event_msg", { type: "item_completed", item: { type: "McpToolCall", result: "w ".repeat(16_500) } });
    text += line("response_item", { type: "custom_tool_call_output", call_id: call, output: [{ type: "input_text", text: "Script completed\nWall time 0.4 seconds\nOutput:\n" }, { type: "input_text", text: printed }] });
    if (n % 2) text += line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: `step ${n}: ${filler(900, n)}` }] });
    parts.push(text); size += Buffer.byteLength(text);
    // The calls are of a size; the last one lands past the limit.
    if (n === 0) calls = Math.ceil(bytes / size) + 1;
  }
  return { text: parts.join(""), calls };
}

test("a predecessor at the rotation size keeps its newest calls and outputs whole: the last progress note and test result are found", async () => {
  const id = "01a17565-6df7-7f20-b755-0000000000a1", { text, calls } = rotationRollout(id, rotationLimits.bytesRotate);
  expect(Buffer.byteLength(text)).toBeGreaterThanOrEqual(rotationLimits.bytesRotate);
  const root = await mkdtemp(join(tmpdir(), "flowly-history-rotation-")); roots.push(root);
  const folder = join(root, "codex", "sessions", "2026", "10", "25"); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `rollout-rotation-${id}.jsonl`), text);
  const reader = new SessionHistory(join(root, "derived"), { codexHome: join(root, "codex") }); readers.push(reader);
  const agent = { id: "rotation", provider: "codex", persistence: { provider: "codex", nativeHandle: id, sessionId: id } };
  await reader.read(agent as never, { session: "#1" });
  let page!: SessionHistoryPage;
  await vi.waitFor(async () => { page = await reader.read(agent as never, { session: "#1" }); expect(page.status).toBe("ready"); }, { timeout: 120_000, interval: 50 });
  const body = await readFile(join(root, "derived", page.evidenceRef!), "utf8"), lines = body.split("\n").filter(Boolean).map((entry) => JSON.parse(entry) as SessionHistoryEntry);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(sessionHistoryLimits.skeletonBytes);
  // The newest call and output are at the widest level, so the codeword past the old 300-character preview and the result line are there.
  const hits = (await reader.read(agent as never, { session: "#1", query: replicaCodeword, limit: 20 })).entries;
  expect(hits.some((entry) => entry.tool?.kind === "call" && entry.text.includes("flowly_report_progress") && entry.text.includes(`I mentioned ${replicaCodeword} once`))).toBe(true);
  expect(hits.some((entry) => entry.tool?.kind === "output" && entry.text.includes(`PASS stage-a.json parses; ${replicaCodeword}`))).toBe(true);
  const tools = lines.filter((entry) => entry.tool), last = tools.at(-1)!;
  expect(last.tool?.kind).toBe("output"); expect(last.text).not.toMatch(/characters not indexed/);
  expect(last.text.split("\n[…")[0].length).toBeGreaterThan(1000);
  // A recent stretch of results is searchable too, not just the last one.
  const recent = (await reader.read(agent as never, { session: "#1", query: `(run ${calls - 40})`, roles: ["tool"] })).entries;
  expect(recent).toHaveLength(1);
  // Older entries pay for it: stepped down or gone, and the index says so.
  const kinds = new Map(page.gaps.map((gap) => [gap.kind, gap.count]));
  expect((kinds.get("output_index_budget") ?? 0) + (kinds.get("output_index_reduced") ?? 0)).toBeGreaterThan(0);
  expect(page.coverage!.excerpts!.output).toBeLessThan(3000);
  // Every narration message stays.
  expect(lines.filter((entry) => entry.role === "assistant")).toHaveLength(Math.floor(calls / 2));
}, 300_000);
