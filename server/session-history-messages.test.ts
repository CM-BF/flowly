import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionHistoryExcerpts, sessionHistoryLimits, type SessionHistoryEntry, type SessionHistoryPage } from "../shared/session-history";
import { rotationLimits } from "../shared/session-rotation";
import { SessionHistory } from "./session-history";
import { filler, releaseHistory } from "./session-history-fixture";

// Messages have a bounded share of the index too (SESSION-HANDOFF-SPEC §8.1, §21.15): a long, chatty Claude session used
// to fill the 2 MiB with its oldest narration, keep no tool entry and refuse its newest prompt, narration and result.
const roots: string[] = [], readers: SessionHistory[] = [];
// Every manifest these tests publish is one read() accepts (SESSION-HANDOFF-SPEC §21.16).
afterEach(async () => { expect(await releaseHistory(readers, roots)).toEqual([]); });
const cwd = "/tmp/plugin-test-history-messages";

async function build(id: string, text: string, maxSkeletonBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "flowly-history-messages-")); roots.push(root);
  const folder = join(root, "claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${id}.jsonl`), text);
  const reader = new SessionHistory(join(root, "derived"), { claudeHome: join(root, "claude"), ...(maxSkeletonBytes ? { maxSkeletonBytes } : {}) }); readers.push(reader);
  const agent = { id: `messages-${id.slice(-4)}`, provider: "claude", cwd, persistence: { provider: "claude", nativeHandle: id, sessionId: id } } as never;
  await reader.read(agent, { session: "#1" });
  let page!: SessionHistoryPage;
  await vi.waitFor(async () => { page = await reader.read(agent, { session: "#1" }); expect(page.status).toBe("ready"); }, { timeout: 120_000, interval: 50 });
  const body = await readFile(join(root, "derived", page.evidenceRef!), "utf8");
  const entries = body.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionHistoryEntry);
  const find = async (query: string) => (await reader.read(agent, { session: "#1", query, limit: 20 })).entries;
  return { page, body, entries, find, gaps: new Map(page.gaps.map((gap) => [gap.kind, gap.count])) };
}

/**
 * A Claude Code transcript with Claude's per-call shape: a Bash call, its 3 KB result (repeated in toolUseResult), a
 * 200-character narration every other call, a thinking block every third, and optionally a person's note every
 * `noteEvery` calls. The first and last prompts, the last narration and the last result are marked.
 */
function claudeSession(id: string, bytes: number, noteEvery = 0) {
  const parts: string[] = []; let size = 0, n = 0;
  const record = (type: string, extra: Record<string, unknown>) => { const line = JSON.stringify({ parentUuid: `p${parts.length}`, isSidechain: false, userType: "external", cwd, sessionId: id, version: "2.9.0", type, uuid: `u${parts.length}`, timestamp: new Date(Date.parse("2026-10-25T10:00:00Z") + parts.length * 1000).toISOString(), ...extra }) + "\n"; parts.push(line); size += line.length; };
  const assistant = (content: unknown[]) => record("assistant", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: "claude-opus-5-5", content, usage: { input_tokens: 4, cache_read_input_tokens: 80_000 + n, output_tokens: 210 } } });
  const result = (toolId: string, out: string) => record("user", { message: { role: "user", content: [{ tool_use_id: toolId, type: "tool_result", content: out, is_error: false }] }, toolUseResult: { stdout: out, stderr: "", interrupted: false, isImage: false } });
  record("user", { message: { role: "user", content: "FIRST-PROMPT: fix the flaky checkout test." } });
  let notes = 0;
  for (; size < bytes; n++) {
    if (n % 3 === 0) assistant([{ type: "thinking", thinking: filler(1500, n), signature: "sig".repeat(100) }]);
    if (n % 2) assistant([{ type: "text", text: `step ${n}: ${filler(200, n)}` }]);
    if (noteEvery && n % noteEvery === 0) { record("user", { message: { role: "user", content: `person-note-${notes++}: ${filler(400, n)}` } }); }
    assistant([{ type: "tool_use", id: `toolu_${n}`, name: "Bash", input: { command: `npm test -- part-${n}`, description: "Run tests" } }]);
    result(`toolu_${n}`, `${filler(3000, n)}\nTests ${n % 5} failed | 40 passed (run ${n})`);
  }
  record("user", { message: { role: "user", content: "LAST-PROMPT: do not touch migrations; ship only the test fix." } });
  assistant([{ type: "text", text: "LAST-NARRATION: the flaky test is fixed by awaiting the cart reload." }]);
  assistant([{ type: "tool_use", id: "toolu_last", name: "Bash", input: { command: "npm test -- checkout" } }]);
  result("toolu_last", `${filler(2000, 9)}\nLAST-RESULT: PASS checkout.test.ts (12 tests)`);
  return { text: parts.join(""), calls: n, notes };
}

async function expectNewestKept(x: Awaited<ReturnType<typeof build>>) {
  expect(Buffer.byteLength(x.body)).toBeLessThanOrEqual(sessionHistoryLimits.skeletonBytes);
  for (const marker of ["FIRST-PROMPT", "LAST-PROMPT", "LAST-NARRATION", "LAST-RESULT"]) expect(await x.find(marker), marker).toHaveLength(1);
  // The newest result is whole, at the widest level; older narration was shortened and the oldest left, and the index says so.
  const last = x.entries.filter((entry) => entry.tool?.kind === "output").at(-1)!;
  expect(last.text).toContain("LAST-RESULT"); expect(last.text).not.toMatch(/characters not indexed/);
  expect(x.entries.filter((entry) => entry.tool).length).toBeGreaterThan(100);
  expect(x.gaps.get("message_index_budget")).toBeGreaterThan(0);
  expect(x.page.coverage).toMatchObject({ omittedEntries: 0, complete: false });
}

test("a Claude session at the rotation size, with a person's notes, keeps its newest prompt, narration and result and every note", async () => {
  const id = "e1a17565-6df7-4f20-b755-0000000000e5", session = claudeSession(id, rotationLimits.bytesRotate, 7);
  const x = await build(id, session.text);
  await expectNewestKept(x);
  // The person's words are kept before any narration: every note is still there.
  const kept = x.entries.filter((entry) => entry.role === "user" && entry.text.startsWith("person-note-")).length;
  expect(kept).toBe(session.notes);
}, 300_000);

test("a Claude session above the rotation size keeps its newest prompt, narration and result", async () => {
  const id = "e1a17565-6df7-4f20-b755-0000000000e6", x = await build(id, claudeSession(id, 100 * 2 ** 20).text);
  await expectNewestKept(x);
}, 300_000);

test("under a small budget older narration is shortened, then the oldest leaves before any person's words; the first prompt always stays", async () => {
  const budget = 64 * 1024, id = "e1a17565-6df7-4f20-b755-0000000000e7";
  const parts: string[] = [], record = (type: string, message: unknown) => parts.push(JSON.stringify({ type, sessionId: id, uuid: `u${parts.length}`, timestamp: new Date(Date.parse("2026-10-25T10:00:00Z") + parts.length * 1000).toISOString(), message }) + "\n");
  record("user", { role: "user", content: "FIRST-PROMPT: keep the API stable." });
  for (let n = 0; n < 300; n++) {
    record("assistant", { role: "assistant", content: [{ type: "text", text: `narration-${n}: ${filler(900, n)}` }, { type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `make step-${n}` } }] });
    record("user", { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: `${filler(600, n)} result-${n}` }] });
    if (n % 10 === 0) record("user", { role: "user", content: `note-${n}: ${filler(300, n)}` });
  }
  const x = await build(id, parts.join(""), budget);
  expect(Buffer.byteLength(x.body)).toBeLessThanOrEqual(budget);
  const narration = x.entries.filter((entry) => entry.role === "assistant"), notes = x.entries.filter((entry) => entry.role === "user");
  // Every person's note and the first prompt stay; the narration kept is the newest, the newest whole, older ones shortened.
  expect(notes.map((entry) => entry.text.split(":")[0])).toEqual(["FIRST-PROMPT", ...Array.from({ length: 30 }, (_, k) => `note-${k * 10}`)]);
  const numbers = narration.map((entry) => Number(/^narration-(\d+)/.exec(entry.text)![1]));
  expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, k) => 300 - numbers.length + k));
  expect(narration.at(-1)!.truncated).toBe(false); expect(narration[0].truncated).toBe(true);
  expect(narration[0].text.split("\n[…")[0].length).toBeLessThanOrEqual(sessionHistoryExcerpts.message[1].head + 64);
  expect(x.gaps.get("message_index_reduced")).toBeGreaterThan(0); expect(x.gaps.get("message_index_budget")).toBe(300 - numbers.length);
  // Messages stay within their share once the index is full, so the newest tool entries keep their room.
  const bytes = (list: SessionHistoryEntry[]) => list.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1, 0);
  expect(bytes([...narration, ...notes])).toBeLessThanOrEqual(0.6 * budget + 2048);
  expect(x.entries.filter((entry) => entry.tool).at(-1)!.text).toContain("result-299");
});

test("when the person's words alone pass the share, the oldest leave but the first prompt and the newest narration stay", async () => {
  const budget = 64 * 1024, id = "e1a17565-6df7-4f20-b755-0000000000e8";
  const parts: string[] = [], record = (type: string, message: unknown) => parts.push(JSON.stringify({ type, sessionId: id, uuid: `u${parts.length}`, timestamp: "2026-10-25T10:00:00.000Z", message }) + "\n");
  record("user", { role: "user", content: "FIRST-PROMPT: keep the API stable." });
  for (let n = 0; n < 120; n++) record("user", { role: "user", content: `pasted-${n}: ${filler(1800, n)}` });
  record("assistant", { role: "assistant", content: [{ type: "text", text: "NEWEST-NARRATION: reading the pasted logs now." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "make test" } }] });
  record("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "NEWEST-RESULT: 3 failed" }] });
  const x = await build(id, parts.join(""), budget);
  expect(Buffer.byteLength(x.body)).toBeLessThanOrEqual(budget);
  for (const marker of ["FIRST-PROMPT", "pasted-119", "NEWEST-NARRATION", "NEWEST-RESULT"]) expect(await x.find(marker), marker).toHaveLength(1);
  expect(await x.find("pasted-1:")).toEqual([]);
  expect(x.gaps.get("message_index_budget")).toBeGreaterThan(0);
});

test("coverage names the narrowest width only for kinds the index keeps", async () => {
  const id = "e1a17565-6df7-4f20-b755-0000000000e9";
  const x = await build(id, JSON.stringify({ type: "user", sessionId: id, uuid: "u0", timestamp: "2026-10-25T10:00:00.000Z", message: { role: "user", content: "Only a prompt." } }) + "\n");
  expect(x.page.coverage!.excerpts).toEqual({ message: 2000 });
});
