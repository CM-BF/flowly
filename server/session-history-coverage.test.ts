import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionHistoryExcerpts, sessionHistoryLimits, sessionHistoryPageSchema, type SessionHistoryEntry, type SessionHistoryPage, type SessionHistoryQuery } from "../shared/session-history";
import { SessionHistory } from "./session-history";
import { forgetHistory } from "./provider-history";
import { replicaCodeword, replicaRollout, replicaSecrets, filler, type ReplicaRole } from "./session-history-fixture";

const roots: string[] = [], readers: SessionHistory[] = [];
afterEach(async () => { await Promise.all(readers.splice(0).map((reader) => reader.stop())); forgetHistory(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const ids: Record<ReplicaRole, string> = { predecessor: "01a17565-6df7-7f20-b755-0000000000a1", successor: "01a1756e-0561-7d21-845f-0000000000a2", reviewer: "01a17572-9c5e-7f83-9ba0-0000000000a3" };
const json = (value: unknown) => JSON.stringify(value) + "\n";

async function home(extra: ConstructorParameters<typeof SessionHistory>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "flowly-history-coverage-")); roots.push(root);
  const reader = new SessionHistory(join(root, "derived"), { codexHome: join(root, "codex"), ...extra }); readers.push(reader);
  const write = async (sessionId: string, text: string) => {
    const date = new Date(parseInt(sessionId.replace(/-/g, "").slice(0, 12), 16));
    const folder = join(root, "codex", "sessions", String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
    await mkdir(folder, { recursive: true });
    const path = join(folder, `rollout-replica-${sessionId}.jsonl`); await writeFile(path, text); return path;
  };
  const agent = (sessionId: string) => ({ id: `agent-${sessionId.slice(-2)}`, provider: "codex", persistence: { provider: "codex", nativeHandle: sessionId, sessionId } });
  return { root, reader, write, agent, directory: join(root, "derived") };
}
async function ready(reader: SessionHistory, agent: { id: string }, query: SessionHistoryQuery = { session: "#1" }): Promise<SessionHistoryPage> {
  await reader.read(agent as never, query);
  let page: SessionHistoryPage | undefined;
  await vi.waitFor(async () => { page = await reader.read(agent as never, query); expect(page.status).not.toBe("building"); }, { timeout: 10_000, interval: 10 });
  return page!;
}
/** Every entry of the index, through the agent-facing pages. */
async function all(reader: SessionHistory, agent: { id: string }, query: SessionHistoryQuery) {
  let page = await reader.read(agent as never, query); const entries: SessionHistoryEntry[] = [];
  for (;;) { sessionHistoryPageSchema.parse(page); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(sessionHistoryLimits.pageBytes); entries.push(...page.entries); if (!page.nextCursor) return { entries, page }; page = await reader.read(agent as never, { ...query, cursor: page.nextCursor }); }
}
/** The decoded text of a source record's tool output, read straight from the file at the entry's evidence range. */
async function sourceOutput(path: string, entry: SessionHistoryEntry) {
  const file = await open(path, "r"), buffer = Buffer.alloc(entry.evidence.to - entry.evidence.from);
  try { await file.read(buffer, 0, buffer.length, entry.evidence.from); } finally { await file.close(); }
  const output = JSON.parse(buffer.toString("utf8")).payload.output as { text: string }[];
  return output.map((part) => part.text).join("\n");
}
async function bytes(path: string, from: number, to: number) {
  const file = await open(path, "r"), buffer = Buffer.alloc(to - from);
  try { await file.read(buffer, 0, buffer.length, from); } finally { await file.close(); }
  return buffer.toString("utf8");
}

test("the live P2 replicas: the codeword is found in the progress-report argument and in tool outputs, with error and test lines, bounded and redacted", async () => {
  const x = await home(), paths = {} as Record<ReplicaRole, string>, pages = {} as Record<ReplicaRole, SessionHistoryPage>;
  for (const role of ["predecessor", "successor", "reviewer"] as const) {
    const text = replicaRollout(role, ids[role]); expect(Buffer.byteLength(text)).toBeGreaterThan(1_400_000);
    paths[role] = await x.write(ids[role], text);
    pages[role] = await ready(x.reader, x.agent(ids[role]));
    expect(pages[role].status).toBe("ready");
  }
  const hits = {} as Record<ReplicaRole, SessionHistoryEntry[]>;
  for (const role of ["predecessor", "successor", "reviewer"] as const) hits[role] = (await all(x.reader, x.agent(ids[role]), { session: "#1", query: replicaCodeword, limit: 20 })).entries;
  // The predecessor named it only past the 300-character preview of a code-mode exec script and in tool outputs.
  const call = hits.predecessor.find((entry) => entry.tool?.kind === "call" && entry.text.includes("flowly_report_progress"));
  expect(call?.text).toContain(`I mentioned ${replicaCodeword} once`);
  expect(call?.evidence.type).toBe("response_item/custom_tool_call");
  for (const role of ["predecessor", "reviewer"] as const) expect(hits[role].some((entry) => entry.tool?.kind === "output" && entry.text.includes(replicaCodeword))).toBe(true);
  // Test results and errors printed by tools.
  const pass = (await x.reader.read(x.agent(ids.predecessor), { session: "#1", query: "PASS stage-a.json parses", roles: ["tool"] })).entries;
  expect(pass[0]).toMatchObject({ tool: { kind: "output", name: "exec" } });
  const failure = (await x.reader.read(x.agent(ids.predecessor), { session: "#1", query: "Input validation error", roles: ["tool"] })).entries;
  expect(failure[0]).toMatchObject({ tool: { kind: "output", outcome: "error" } });
  expect((await x.reader.read(x.agent(ids.successor), { session: "#1", query: "PASS verify.mjs" })).entries[0]?.tool?.kind).toBe("output");
  // Escaped narration and escaped scripts are decoded or kept, not omitted.
  expect((await x.reader.read(x.agent(ids.predecessor), { session: "#1", query: "按原始字节保留", roles: ["assistant"] })).entries[0]?.text).toContain("`\\r\\n`");
  expect((await x.reader.read(x.agent(ids.predecessor), { session: "#1", query: "writeFile(\"stage-a.json\"" })).entries).toHaveLength(1);
  for (const role of ["predecessor", "successor", "reviewer"] as const) {
    const page = pages[role], evidence = await readFile(join(x.directory, page.evidenceRef!), "utf8");
    expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(sessionHistoryLimits.skeletonBytes);
    expect(evidence).not.toContain("[escaped content omitted]");
    for (const secret of Object.values(replicaSecrets)) expect(evidence).not.toContain(secret);
    // What is still left out is reported, with the excerpted outputs' omitted bytes.
    const kinds = new Map(page.gaps.map((gap) => [gap.kind, gap]));
    expect(kinds.has("tool_output_omitted")).toBe(false);
    expect(kinds.get("output_excerpt")?.bytes).toBeGreaterThan(50_000); expect(page.coverage?.complete).toBe(true);
    expect([...kinds.keys()]).toEqual(expect.arrayContaining(["encrypted_reasoning_omitted", "developer_instructions_omitted"]));
    expect(page.coverage).toMatchObject({ excerpts: { output: 3000, arguments: 4000, message: 2000 } });
  }
  const predecessor = await readFile(join(x.directory, pages.predecessor.evidenceRef!), "utf8");
  expect(predecessor).toContain("Authorization: Bearer [redacted]"); expect(predecessor).toContain("API_KEY=[redacted]");
});

test("an excerpted output keeps its exact head and tail and locates the omitted middle by raw byte range in the source", async () => {
  const x = await home(), path = await x.write(ids.predecessor, replicaRollout("predecessor", ids.predecessor));
  await ready(x.reader, x.agent(ids.predecessor));
  const entry = (await x.reader.read(x.agent(ids.predecessor), { session: "#1", query: "mentioned " + replicaCodeword + " for the history lookup" })).entries.find((item) => item.tool?.kind === "output")!;
  expect(entry.middle).toMatchObject({ exact: true }); expect(entry.truncated).toBe(true);
  const original = await sourceOutput(path, entry), middle = JSON.parse(`"${await bytes(path, entry.middle!.from, entry.middle!.to)}"`) as string;
  const [head, tail] = entry.text.split(/\n\[… \d+ characters omitted · source bytes \d+–\d+ …\]\n/);
  expect(middle).toHaveLength(entry.middle!.characters);
  expect(head + middle + tail).toBe(original);
  expect(entry.characters).toBe(original.length);
  expect(tail).toContain(replicaCodeword);
});

test("a planted secret behind escaped quotes is decoded and redacted in arguments and outputs instead of omitting them", async () => {
  const x = await home(), password = "planted-pass-3141", token = "planted-token-2718";
  await x.write(ids.predecessor, json({ timestamp: "2026-10-25T23:29:05.000Z", type: "session_meta", payload: { id: ids.predecessor } })
    + json({ type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: `const body = "{\\"password\\":\\"${password}\\"}";\ntext(await tools.exec_command({cmd: "echo " + body}));\n` } })
    + json({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text: JSON.stringify({ output: JSON.stringify({ apiToken: token, ok: true }) }) }] } }));
  const page = await ready(x.reader, x.agent(ids.predecessor)), evidence = await readFile(join(x.directory, page.evidenceRef!), "utf8");
  for (const secret of [password, token]) { expect(evidence).not.toContain(secret); expect(JSON.stringify(page)).not.toContain(secret); }
  const [call, output] = page.entries;
  expect(call).toMatchObject({ decoded: true, tool: { kind: "call" } }); expect(call.text).toMatch(/"password":"?\[redacted\]/); expect(call.text).toContain("exec_command");
  expect(output).toMatchObject({ decoded: true, tool: { kind: "output" } }); expect(output.text).toMatch(/"apiToken":"?\[redacted\]/); expect(output.text).toContain('"ok":true');
  expect(page.gaps.map((gap) => gap.kind)).not.toContain("escaped_text_omitted");
});

test("past its budget the newest tool entries keep the widest level, older ones step down by age and the oldest leave, never messages", async () => {
  const budget = 160 * 1024, x = await home({ maxSkeletonBytes: budget });
  let text = json({ timestamp: "2026-10-25T23:29:05.000Z", type: "session_meta", payload: { id: ids.reviewer } });
  for (let n = 0; n < 160; n++) {
    text += json({ type: "response_item", payload: { type: "message", role: n % 2 ? "assistant" : "user", content: [{ type: "input_text", text: `message-${n} ${filler(300, n)}` }] } });
    text += json({ type: "response_item", payload: { type: "function_call", call_id: `c${n}`, name: "exec_command", arguments: JSON.stringify({ cmd: `run step-${n} ${filler(2500, n)}`, workdir: "/tmp/w" }) } });
    text += json({ type: "response_item", payload: { type: "function_call_output", call_id: `c${n}`, output: `Process exited with code ${n % 3 ? 0 : 1}\nOutput:\noutput-${n}-head ${filler(5000, n)} output-${n}-tail` } });
  }
  await x.write(ids.reviewer, text);
  const page = await ready(x.reader, x.agent(ids.reviewer)), evidence = await readFile(join(x.directory, page.evidenceRef!), "utf8");
  expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(budget);
  const lines = evidence.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionHistoryEntry);
  for (let n = 0; n < 160; n++) expect(lines.some((entry) => !entry.tool && entry.text.startsWith(`message-${n} `))).toBe(true);
  expect(page.coverage).toMatchObject({ excerpts: { output: 0, arguments: 300, message: 2000 }, omittedEntries: 0, complete: false });
  // What stays is the newest tool entries, the newest at the widest level, narrower by age.
  const tools = lines.filter((entry) => entry.tool), kept = new Set(tools.map((entry) => entry.ordinal)), all = Array.from({ length: 160 }, (_, n) => [3 * n + 1, 3 * n + 2]).flat();
  expect(tools.length).toBeGreaterThan(40); expect(tools.length).toBeLessThan(280);
  expect(all.filter((ordinal) => kept.has(ordinal))).toEqual(all.slice(all.length - tools.length));
  const outputs = tools.filter((entry) => entry.tool?.kind === "output"), last = outputs.at(-1)!;
  expect(last.tool).toMatchObject({ kind: "output", outcome: "exit 1" });
  expect(last.text).toMatch(/^Process exited with code 1\nOutput:\noutput-159-head /); expect(last.text).toMatch(/ output-159-tail$/);
  expect(last.text.split("\n[…")[0].length).toBeGreaterThanOrEqual(sessionHistoryExcerpts.output[0].head - 200);
  expect(outputs[0].text).toMatch(/^\[\d+ characters not indexed · source bytes \d+–\d+\]$/);
  // Levels by the text kept (3,000 / 1,200 / 400 characters or a stub): never wider for an older output.
  const band = (entry: SessionHistoryEntry) => /characters not indexed/.test(entry.text) ? 0 : entry.text.length < 800 ? 1 : entry.text.length < 2000 ? 2 : 3;
  const bands = outputs.map(band); expect(bands).toEqual([...bands].sort((a, b) => a - b)); expect(new Set(bands)).toEqual(new Set([0, 1, 2, 3]));
  const calls = tools.filter((entry) => entry.tool?.kind === "call");
  expect(calls.at(-1)!.text).toContain("run step-159 "); expect(calls.at(-1)!.text.length).toBeGreaterThan(calls[0].text.length);
  const kinds = new Map(page.gaps.map((gap) => [gap.kind, gap.count]));
  expect((kinds.get("output_index_budget") ?? 0) + (kinds.get("call_index_budget") ?? 0)).toBe(320 - tools.length);
  expect(kinds.get("output_index_reduced")).toBeGreaterThan(0); expect(kinds.get("call_index_reduced")).toBeGreaterThan(0);
  expect(sessionHistoryExcerpts.output.at(-1)).toEqual({ head: 0, tail: 0 });
});

test("a query hit deep inside a long non-ASCII entry is shown around the match inside the page budget", async () => {
  const x = await home();
  await x.write(ids.successor, json({ type: "session_meta", payload: { id: ids.successor } }) + json({ type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: "中文说明".repeat(620) + ` ${replicaCodeword} ` + "后续内容".repeat(100) } }));
  await ready(x.reader, x.agent(ids.successor));
  const page = await x.reader.read(x.agent(ids.successor), { session: "#1", query: replicaCodeword.toLowerCase() });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(sessionHistoryLimits.pageBytes);
  expect(page.entries[0].text).toContain(replicaCodeword); expect(page.entries[0].truncated).toBe(true);
});

test("an index built by format 1 is rebuilt on the next read instead of serving its narrower coverage", async () => {
  const x = await home(); await x.write(ids.predecessor, replicaRollout("predecessor", ids.predecessor));
  const first = await ready(x.reader, x.agent(ids.predecessor));
  const manifest = join(x.directory, first.evidenceRef!.split("/").slice(0, -1).join("/"), "current.json");
  await writeFile(manifest, (await readFile(manifest, "utf8")).replace(/^\{"version":\d+/, '{"version":1'));
  expect((await x.reader.read(x.agent(ids.predecessor), { session: "#1" })).status).toBe("building");
  const rebuilt = await ready(x.reader, x.agent(ids.predecessor)); expect(rebuilt.status).toBe("ready");
  expect(JSON.parse(await readFile(manifest, "utf8")).version).toBe(2);
});
