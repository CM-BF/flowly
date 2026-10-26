import { afterEach, expect, test, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, open, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionHistoryPage, SessionHistoryQuery } from "../shared/session-history";
import { SessionHistory } from "./session-history";
import { filler, releaseHistory } from "./session-history-fixture";

// Claude Code keeps a large tool result out of the transcript (a <persisted-output> stub with a 2 KB preview; the text
// is in <session>/tool-results/), and writes an agent-<id>.meta.json beside each subagent transcript
// (SESSION-HANDOFF-SPEC §8.1, §21.16). Synthetic records with the shapes of this machine's sdk-cli transcripts.
const roots: string[] = [], readers: SessionHistory[] = [];
afterEach(async () => { expect(await releaseHistory(readers, roots)).toEqual([]); });
const cwd = "/tmp/plugin-test-history-claude-files", at = "2026-10-25T10:00:00.000Z";

async function claude(id: string) {
  const root = await mkdtemp(join(tmpdir(), "flowly-history-claude-files-")); roots.push(root);
  const folder = join(root, "claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); await mkdir(folder, { recursive: true });
  const path = join(folder, `${id}.jsonl`), session = join(folder, id);
  const reader = new SessionHistory(join(root, "derived"), { claudeHome: join(root, "claude") }); readers.push(reader);
  const agent = { id: `claude-files-${id.slice(-4)}`, provider: "claude", cwd, persistence: { provider: "claude", nativeHandle: id, sessionId: id } } as never;
  const query = (q: SessionHistoryQuery) => reader.read(agent, q);
  const ready = async (q: SessionHistoryQuery = { session: "#1" }) => {
    await query(q);
    let page!: SessionHistoryPage;
    await vi.waitFor(async () => { page = await query({ session: "#1" }); expect(page.status).not.toBe("building"); }, { timeout: 10_000, interval: 10 });
    return page;
  };
  const record = (type: string, extra: Record<string, unknown>) => JSON.stringify({ parentUuid: null, isSidechain: false, userType: "external", entrypoint: "sdk-cli", cwd, sessionId: id, version: "2.9.0", type, uuid: `u-${Math.random().toString(36).slice(2)}`, timestamp: at, ...extra }) + "\n";
  const find = async (text: string) => (await query({ session: "#1", query: text, limit: 20 })).entries;
  return { root, folder, path, session, query, ready, record, find };
}
type Claude = Awaited<ReturnType<typeof claude>>;
const full = `${filler(60_000, 3)}\n FAIL  server/checkout.test.ts > applies the coupon\nAssertionError: expected 3 to be 2\n Test Files  1 failed | 230 passed (231)\n      Tests  1 failed | 2273 passed (2274)\n`;
/** The stub Claude Code writes in place of a large tool result. */
const stub = (saved: string, text: string) => `<persisted-output>\nOutput too large (${(Buffer.byteLength(text) / 1024).toFixed(1)}KB). Full output saved to: ${saved}\n\nPreview (first 2KB):\n${text.slice(0, 2048)}\n...\n</persisted-output>`;
async function persisted(x: Claude, saved: string, content: (stub: string) => unknown = (text) => text) {
  await writeFile(x.path, x.record("user", { message: { role: "user", content: "Run the tests and fix what fails." } })
    + x.record("assistant", { message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test", description: "Run tests" } }] } })
    + x.record("user", { message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: content(stub(saved, full)), is_error: true }] } })
    + x.record("assistant", { message: { role: "assistant", content: [{ type: "text", text: "One test fails; fixing the coupon rounding." }] } }));
}

test("a persisted tool result is indexed from its file: its tail is searchable and its middle located in that file's bytes", async () => {
  const x = await claude("e1a17565-6df7-4f20-b755-0000000000c7"), saved = join(x.session, "tool-results", "b7k2q9x1.txt");
  await mkdir(join(x.session, "tool-results"), { recursive: true }); await writeFile(saved, full);
  for (const shape of [(text: string) => text, (text: string) => [{ type: "text", text }]]) {
    await persisted(x, saved, shape);
    const page = await x.ready({ session: "#1", rebuild: true });
    // Only the excerpt's own omitted middle (an intentional gap) is reported.
    expect(page).toMatchObject({ status: "ready", gaps: [{ kind: "output_excerpt", count: 1 }], coverage: { complete: true } });
    const [hit] = await x.find("applies the coupon");
    expect(hit).toMatchObject({ role: "tool", truncated: true, tool: { name: "Bash", kind: "output", outcome: "error" }, middle: { exact: true } });
    expect(hit.text).toContain("Tests  1 failed | 2273 passed (2274)"); expect(hit.text).not.toContain("<persisted-output>");
    expect(hit.evidence).toMatchObject({ from: 0, to: Buffer.byteLength(full) });
    // The omitted middle reads back from the saved file at those bytes.
    const file = await open(saved, "r"), middle = Buffer.alloc(hit.middle!.to - hit.middle!.from);
    try { await file.read(middle, 0, middle.length, hit.middle!.from); } finally { await file.close(); }
    const [head, tail] = hit.text.split(/\n\[… \d+ characters omitted · source bytes \d+–\d+ …\]\n/);
    expect(head + middle.toString("utf8") + tail).toBe(full);
    expect(await x.find("Output too large")).toEqual([]);
  }
  // The file is one of the index's sources: a change to it shows as changed.
  await appendFile(saved, "rerun\n");
  expect((await x.query({ session: "#1" })).status).toBe("changed");
});

test("a persisted tool result that is missing, elsewhere or past the cap keeps its preview and reports the loss", async () => {
  const ids = { missing: "e1a17565-6df7-4f20-b755-0000000000c1", outside: "e1a17565-6df7-4f20-b755-0000000000c2", symlink: "e1a17565-6df7-4f20-b755-0000000000c3", oversized: "e1a17565-6df7-4f20-b755-0000000000c4" };
  for (const placed of ["missing", "outside", "symlink", "oversized"] as const) {
    const x = await claude(ids[placed]);
    const folder = join(x.session, "tool-results"); await mkdir(folder, { recursive: true });
    let saved = join(folder, "b7k2q9x1.txt");
    if (placed === "outside") { saved = join(x.root, "elsewhere.txt"); await writeFile(saved, full); }
    if (placed === "symlink") { const target = join(x.root, "target.txt"); await writeFile(target, full); await symlink(target, saved); }
    if (placed === "oversized") await writeFile(saved, full + filler(5 * 1024 * 1024));
    await persisted(x, saved);
    const page = await x.ready();
    expect(page.status).toBe("ready"); expect(page.coverage?.complete).toBe(false);
    expect(page.gaps).toEqual([expect.objectContaining({ kind: "persisted_output_not_indexed", count: 1, bytes: expect.any(Number) })]);
    // The preview is still there, and it says where the rest is.
    const [preview] = await x.find("Output too large");
    expect(preview.text).toContain("Full output saved to:"); expect(await x.find("applies the coupon")).toEqual([]);
  }
});

test("subagent metadata files are not a gap and do not count toward the cap; past the cap the newest transcripts are read", async () => {
  const x = await claude("e1a17565-6df7-4f20-b755-0000000000d8"), folder = join(x.session, "subagents");
  await writeFile(x.path, x.record("user", { message: { role: "user", content: "Survey the repo with explorers." } }));
  await mkdir(folder, { recursive: true });
  const subagent = async (n: number) => {
    const name = `agent-a${String(n).padStart(16, "0")}`, path = join(folder, `${name}.jsonl`);
    await writeFile(path, x.record("user", { isSidechain: true, agentId: `a${n}`, message: { role: "user", content: `Explore area ${n}` } }) + x.record("assistant", { isSidechain: true, agentId: `a${n}`, message: { role: "assistant", content: [{ type: "text", text: `REPORT-${n}: area ${n} is clean.` }] } }));
    await writeFile(join(folder, `${name}.meta.json`), JSON.stringify({ agentType: "Explore", parentAgentId: null, spawnDepth: 1, requestShape: "foreground" }));
    // Older numbers are older transcripts.
    const time = new Date(Date.parse(at) + n * 60_000); await utimes(path, time, time);
  };
  for (let n = 0; n < 20; n++) await subagent(n);
  let page = await x.ready({ session: "#1", rebuild: true });
  const reports = async (range: number[]) => (await Promise.all(range.map(async (n) => (await x.find(`REPORT-${n}:`)).length))).reduce((a, b) => a + b, 0);
  expect(page).toMatchObject({ gaps: [], coverage: { complete: true } });
  expect(await reports([...Array(20).keys()])).toBe(20);
  // 40 transcripts: the 32 newest are read and the 8 oldest are reported, in one gap.
  for (let n = 20; n < 40; n++) await subagent(n);
  page = await x.ready({ session: "#1", rebuild: true });
  expect(page.gaps).toEqual([expect.objectContaining({ kind: "subagent_count_budget", count: 8 })]);
  expect(await reports([...Array(8).keys()])).toBe(0);
  expect(await reports([...Array(32).keys()].map((n) => n + 8))).toBe(32);
  // The newest is indexed last, so it is the last to leave a full index.
  const [newest] = await x.find("REPORT-39:"), [older] = await x.find("REPORT-8:");
  expect(newest.ordinal).toBeGreaterThan(older.ordinal);
  // What is not a transcript or its metadata is still named.
  await writeFile(join(folder, "notes.txt"), "x"); await mkdir(join(folder, "workflows", "wf_1"), { recursive: true });
  page = await x.ready({ session: "#1", rebuild: true });
  expect(page.gaps.map((gap) => gap.kind).sort()).toEqual(["subagent_count_budget", "subagent_unsupported_entry", "subagent_workflows_not_indexed"]);
  expect(JSON.parse(await readFile(join(x.root, "derived", page.evidenceRef!.split("/").slice(0, -1).join("/"), "current.json"), "utf8")).sources).toHaveLength(33);
});
