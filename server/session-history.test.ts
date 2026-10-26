import { afterEach, expect, test, vi } from "vitest";
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionHistoryLimits, sessionHistoryPageSchema, type SessionHistoryPage, type SessionHistoryQuery } from "../shared/session-history";
import { SessionHistory } from "./session-history";
import { forgetHistory } from "./provider-history";
const fsGate = vi.hoisted(() => ({ beforeOpen: undefined as undefined | ((path: string) => Promise<void>), beforeUnlink: undefined as undefined | ((path: string) => Promise<void>) }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => { await fsGate.beforeOpen?.(String(args[0])); return actual.open(...args); }, unlink: async (path: Parameters<typeof actual.unlink>[0]) => { await fsGate.beforeUnlink?.(String(path)); return actual.unlink(path); } };
});
const roots: string[] = [], readers: SessionHistory[] = [];
const releases: (() => void)[] = [];
const uuid = "019a15e5-0000-7abc-8def-0123456789ab", at = "2026-10-24T00:00:00.000Z";
const json = (value: unknown) => JSON.stringify(value) + "\n";
const response = (type: string, data: Record<string, unknown>) => ({ timestamp: at, type: "response_item", payload: { type, ...data } });
afterEach(async () => { fsGate.beforeOpen = undefined; fsGate.beforeUnlink = undefined; releases.splice(0).forEach((release) => release()); await Promise.all(readers.splice(0).map((reader) => reader.stop())); forgetHistory(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(provider: "codex" | "claude" = "codex", extra: ConstructorParameters<typeof SessionHistory>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "flowly-session-history-")); roots.push(root);
  const home = join(root, provider), date = new Date(parseInt(uuid.replace(/-/g, "").slice(0, 12), 16));
  const folder = provider === "codex" ? join(home, "sessions", String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")) : join(home, "projects", "fixture-project");
  await mkdir(folder, { recursive: true });
  const path = join(folder, provider === "codex" ? `rollout-date-${uuid}.jsonl` : `${uuid}.jsonl`); await writeFile(path, "");
  const agent = { id: "managed-agent", provider, persistence: { provider, nativeHandle: uuid, sessionId: uuid } }, directory = join(root, "derived");
  const options = { codexHome: join(root, "codex"), claudeHome: join(root, "claude"), ...extra };
  const reader = new SessionHistory(directory, options); readers.push(reader);
  return { root, path, agent, reader, directory, options, read: (query: SessionHistoryQuery = { session: "#1" }) => reader.read(agent, query) };
}
async function ready(x: Awaited<ReturnType<typeof fixture>>, query: SessionHistoryQuery = { session: "#1" }): Promise<SessionHistoryPage> {
  await x.read(query);
  let page: SessionHistoryPage | undefined;
  await vi.waitFor(async () => { page = await x.read({ ...query, rebuild: false }); expect(page.status).not.toBe("building"); }, { timeout: 5000, interval: 5 });
  return page!;
}

test("first read only queues a skeleton; Codex semantic excerpts paginate/search without any Paseo operation", async () => {
  const x = await fixture(), native = Array.from({ length: 25 }, (_, n) => json(response("message", { role: n % 2 ? "assistant" : "user", content: [{ type: "input_text", text: `step ${n} /tmp/results-${n}.json` }] }))).join("") + json(response("function_call", { name: "exec_command", arguments: JSON.stringify({ cmd: "npm test", workdir: "/tmp/work" }) })) + json(response("function_call_output", { output: JSON.stringify({ exit_code: 7, stdout: "PRIVATE_OUTPUT_SENTINEL" }) }));
  await writeFile(x.path, native);
  const first = await x.read(); expect(first.status).toBe("building");
  let page = await ready(x), ordinals: number[] = [];
  const snapshot = page.snapshot;
  while (true) { expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192); sessionHistoryPageSchema.parse(page); ordinals.push(...page.entries.map((entry) => entry.ordinal)); if (!page.nextCursor) break; page = await x.read({ session: "#1", cursor: page.nextCursor }); }
  expect(ordinals).toEqual(Array.from({ length: 27 }, (_, n) => n));
  const search = await x.read({ session: "#1", query: "npm test", roles: ["tool"] }); expect(search.entries[0].tool).toMatchObject({ name: "exec_command", category: "exec", kind: "call" }); expect(search.entries[0].text).toContain("npm test");
  // Tool outputs are indexed as bounded excerpts (SESSION-HANDOFF-SPEC §21.13), with the exit code as the outcome.
  const outcome = await x.read({ session: "#1", query: "exit 7", roles: ["tool"] }); expect(outcome.entries[0].tool).toMatchObject({ kind: "output", outcome: "exit 7" }); expect(outcome.entries[0].text).toContain("PRIVATE_OUTPUT_SENTINEL");
  expect(page.snapshot).toBe(snapshot); expect(page.evidenceRef).toContain("session-history/"); expect(await readFile(x.path, "utf8")).toBe(native);
});

test("images, giant lines and credentials never enter derived evidence while exact skipped volume remains visible", async () => {
  const x = await fixture(), sentinel = "7c13a9e245b8f0d67c13a9e245b8f0d6", cookie = "629a5e9f74bc14a5629a5e9f74bc14a5", password = "50312fc84095fc7250312fc84095fc72";
  const huge = json(response("message", { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64," + "A".repeat(2 * 1024 * 1024) }] }));
  await writeFile(x.path, huge + json(response("message", { role: "user", content: [{ type: "input_text", text: JSON.stringify({ headers: { Authorization: "Bearer " + sentinel, Cookie: `session=${cookie}` }, connection: `postgres://user:${password}@example.invalid/db` }) }] })) + json(response("message", { role: "assistant", content: [{ type: "output_text", text: "after image" }] })));
  const page = await ready(x); expect(page.status).toBe("ready"); expect(page.entries.map((entry) => entry.text).join(" ")).toContain("after image");
  expect(page.coverage).toMatchObject({ skippedLines: 1, skippedBytes: Buffer.byteLength(huge) }); expect(JSON.stringify(page)).not.toContain(sentinel); expect(JSON.stringify(page.growth)).toContain("response_item");
  const evidence = await readFile(join(x.directory, page.evidenceRef!), "utf8"); for (const credential of [sentinel, cookie, password]) { expect(evidence).not.toContain(credential); expect(JSON.stringify(page)).not.toContain(credential); } expect(evidence).not.toContain("data:image"); expect(evidence.length).toBeLessThan(10000);
});

test("truncated source and skeleton budgets expose indexed scope instead of asserting a search miss is complete", async () => {
  const x = await fixture("codex", { maxSkeletonBytes: 600, maxSourceBytes: 1600 });
  await writeFile(x.path, Array.from({ length: 100 }, (_, n) => json(response("message", { role: "user", content: [{ type: "input_text", text: `message-${n} ` + "x".repeat(100) }] }))).join(""));
  const page = await ready(x, { session: "#1", query: "message-99" });
  expect(page.entries).toEqual([]); expect(page.coverage?.complete).toBe(false); expect(page.coverage!.readBytes).toBeLessThanOrEqual(1600); expect(page.coverage!.omittedEntries).toBeGreaterThan(0); expect(page.omitted).toBeGreaterThan(0); expect(page.gaps.map((gap) => gap.kind)).toContain("source_budget"); expect(page.message).toContain("within the indexed range");
});

test("source growth and same-inode rewrites invalidate cursors without automatically rebuilding on polling", async () => {
  const x = await fixture();
  const text = Array.from({ length: 12 }, (_, n) => json(response("message", { role: "user", content: [{ type: "input_text", text: `old-${n}` }] }))).join(""); await writeFile(x.path, text);
  const page = await ready(x); expect(page.nextCursor).toBeTruthy();
  const inode = (await stat(x.path)).ino; await writeFile(x.path, text.replaceAll("old-", "new-")); expect((await stat(x.path)).ino).toBe(inode);
  const changed = await x.read({ session: "#1", cursor: page.nextCursor }); expect(changed).toMatchObject({ status: "changed", viewChanged: true, entries: [] });
  const metadataPath = join(x.directory, page.evidenceRef!.split("/").slice(0, -1).join("/"), "current.json"), before = (await stat(metadataPath)).mtimeMs;
  expect((await x.read()).status).toBe("changed"); expect((await stat(metadataPath)).mtimeMs).toBe(before);
  expect((await x.read({ session: "#1", rebuild: true })).status).toBe("building"); const rebuilt = await ready(x); expect(rebuilt.entries[0].text).toBe("new-0");
  await appendFile(x.path, json(response("message", { role: "assistant", content: [{ type: "output_text", text: "new tail" }] })));
  expect((await x.read()).status).toBe("changed"); expect((await x.read({ session: "#1", cursor: page.nextCursor })).status).toBe("changed");
});

test("cursor ownership, query binding and checksum corruption fail explicitly", async () => {
  const x = await fixture(); await writeFile(x.path, Array.from({ length: 15 }, () => json(response("message", { role: "user", content: [{ type: "input_text", text: "match" }] }))).join("")); const page = await ready(x);
  await expect(x.read({ session: "#1", cursor: "junk" })).rejects.toMatchObject({ code: "HISTORY_CURSOR_INVALID" });
  await expect(x.read({ session: "#1", query: "changed", cursor: page.nextCursor })).rejects.toMatchObject({ code: "HISTORY_CURSOR_INVALID" });
  await expect(x.reader.read({ ...x.agent, id: "other-agent" }, { session: "#1", cursor: page.nextCursor })).rejects.toMatchObject({ code: "HISTORY_CURSOR_INVALID" });
  await writeFile(join(x.directory, page.evidenceRef!), "corrupt"); expect((await x.read()).gaps[0].kind).toBe("skeleton_invalid");
});

test("Claude keeps main text and readable compaction, reads small subagent text, and refuses oversized or symlink children", async () => {
  const x = await fixture("claude");
  await writeFile(x.path, json({ type: "user", sessionId: uuid, timestamp: at, message: { content: "original instruction" } }) + json({ type: "user", sessionId: uuid, isCompactSummary: true, message: { content: "readable compaction" } }) + json({ type: "assistant", sessionId: uuid, message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/report.md" } }] } }));
  const folder = join(x.path.slice(0, -6), "subagents"); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "agent-a.jsonl"), json({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent summary" }] } }));
  await writeFile(join(folder, "agent-big.jsonl"), "x".repeat(201 * 1024));
  const outside = join(x.root, "not-owned.jsonl"); await writeFile(outside, json({ type: "assistant", message: { content: "PRIVATE_OUTSIDE_SENTINEL" } })); await symlink(outside, join(folder, "agent-link.jsonl"));
  const page = await ready(x); const texts = page.entries.map((entry) => entry.text).join("\n"); expect(texts).toContain("original instruction"); expect(texts).toContain("readable compaction"); expect(texts).toContain("subagent summary"); expect(texts).not.toContain("PRIVATE_OUTSIDE_SENTINEL"); expect(page.entries.find((entry) => entry.tool)?.paths).toContain("src/report.md"); expect(page.gaps.map((gap) => gap.kind)).toEqual(expect.arrayContaining(["subagent_size_budget", "subagent_unsupported_entry"]));
});

test("missing, unsupported, partial and mismatched native identities are explicit and a reader can resume from the saved skeleton", async () => {
  const x = await fixture(); expect((await x.reader.read({ id: "unsupported", provider: "opencode" }, { session: "#1" })).status).toBe("unsupported"); await rm(x.path); expect((await x.read()).gaps[0].kind).toBe("source_missing");
  await writeFile(x.path, json({ type: "session_meta", payload: { id: "another-session" } }) + json(response("message", { role: "user", content: [{ type: "input_text", text: "DO_NOT_INDEX_WRONG_IDENTITY" }] })) + "{partial");
  const first = await ready(x); expect(first.entries).toEqual([]); expect(first.gaps.map((gap) => gap.kind)).toEqual(expect.arrayContaining(["session_identity_mismatch", "partial_line"]));
  await x.reader.stop(); const restarted = new SessionHistory(x.directory, x.options); readers.push(restarted); expect((await restarted.read(x.agent, { session: "#1" })).snapshot).toBe(first.snapshot);
});

test("non-ASCII excerpts always progress inside the hard eight-KiB page budget", async () => {
  const x = await fixture(); await writeFile(x.path, Array.from({ length: 30 }, (_, n) => json(response("message", { role: "assistant", content: [{ type: "output_text", text: `${n} ` + "中文字".repeat(1000) }] }))).join(""));
  let page = await ready(x, { session: "#1", limit: 20 }), count = 0;
  while (true) { expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(sessionHistoryLimits.pageBytes); expect(page.entries.length).toBeGreaterThan(0); count += page.entries.length; if (!page.nextCursor) break; page = await x.read({ session: "#1", limit: 20, cursor: page.nextCursor }); }
  expect(count).toBe(30); expect(page.entries[0].truncated).toBe(true);
});

test("stop cancels queued and active chunk work and preserves native bytes", async () => {
  const x = await fixture(), file = await open(x.path, "w"); await file.write(Buffer.from('{"type":"response_item","payload":{"output":"')); await file.truncate(8 * 1024 * 1024); await file.close();
  const before = await stat(x.path); expect((await x.read()).status).toBe("building"); await new Promise<void>((resolve) => setImmediate(resolve));
  const start = performance.now(); await x.reader.stop(); expect(performance.now() - start).toBeLessThan(1500); expect((await x.read()).status).toBe("unavailable"); expect((await lstat(x.path)).size).toBe(before.size); expect((await lstat(x.path)).mtimeMs).toBe(before.mtimeMs);
});

function pauseOpen(predicate: (path: string) => boolean) {
  let reached!: () => void, release!: () => void;
  const arrived = new Promise<void>((resolve) => { reached = resolve; }), wait = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  fsGate.beforeOpen = async (path) => { if (predicate(path)) { reached(); await wait; } };
  return { arrived, release };
}

test("a pending native open cannot make stop unbounded or publish late evidence", async () => {
  const x = await fixture(); await writeFile(x.path, json(response("message", { role: "user", content: [{ type: "input_text", text: "preserved" }] })));
  const gate = pauseOpen((path) => path.endsWith("/" + x.path.split("/").pop()));
  await x.read(); await gate.arrived;
  const start = performance.now(); await x.reader.stop(); expect(performance.now() - start).toBeLessThan(1400);
  gate.release(); fsGate.beforeOpen = undefined;
  await vi.waitFor(async () => { expect(await lstat(x.directory).catch(() => null)).toBeNull(); });
  expect((await x.read()).gaps[0].kind).toBe("stopped");
});

test("stopping before manifest publication leaves a restart free to rebuild, with late old work unable to replace it", async () => {
  const x = await fixture(); await writeFile(x.path, json(response("message", { role: "user", content: [{ type: "input_text", text: "stable previous evidence" }] })));
  const previous = await ready(x);
  await writeFile(x.path, json(response("message", { role: "user", content: [{ type: "input_text", text: "old evidence" }] })));
  const gate = pauseOpen((path) => path.includes("current.json.") && path.endsWith(".tmp"));
  await x.read({ session: "#1", rebuild: true }); await gate.arrived; await x.reader.stop();
  expect(await readFile(join(x.directory, previous.evidenceRef!), "utf8")).toContain("stable previous evidence");
  fsGate.beforeOpen = undefined;
  await writeFile(x.path, json(response("message", { role: "user", content: [{ type: "input_text", text: "new evidence" }] })));
  const replacement = new SessionHistory(x.directory, x.options); readers.push(replacement);
  await replacement.read(x.agent, { session: "#1", rebuild: true });
  let current!: SessionHistoryPage;
  await vi.waitFor(async () => { current = await replacement.read(x.agent, { session: "#1" }); expect(current.status).toBe("ready"); });
  gate.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await replacement.read(x.agent, { session: "#1" })).snapshot).toBe(current.snapshot); expect(current.entries[0].text).toBe("new evidence");
});

test("new Claude sidecars invalidate the old inventory without rescanning it implicitly", async () => {
  const x = await fixture("claude"); await writeFile(x.path, json({ type: "assistant", sessionId: uuid, message: { content: "main" } }));
  const old = await ready(x); expect(old.status).toBe("ready");
  const folder = join(x.path.slice(0, -6), "subagents"); await mkdir(folder, { recursive: true }); await writeFile(join(folder, "late.jsonl"), json({ type: "assistant", message: { content: "late child result" } }));
  expect((await x.read()).status).toBe("changed"); expect((await x.read()).snapshot).toBe(old.snapshot);
  const next = await ready(x, { session: "#1", rebuild: true }); expect(next.entries.map((entry) => entry.text)).toContain("late child result");
});

test("four rebuilds retain only the durable current and one previous derived snapshot", async () => {
  const x = await fixture(), versions: SessionHistoryPage[] = [];
  for (let n = 0; n < 4; n++) {
    await writeFile(x.path, Array.from({ length: 12 }, (_, i) => json(response("message", { role: "user", content: [{ type: "input_text", text: `version-${n} message-${i}` }] }))).join(""));
    versions.push(await ready(x, { session: "#1", rebuild: n > 0 }));
    const folder = join(x.directory, versions[n].evidenceRef!.split("/").slice(0, -1).join("/"));
    const bodies = (await readdir(folder)).filter((name) => name.endsWith(".jsonl"));
    expect(bodies).toHaveLength(Math.min(n + 1, 2));
    expect(bodies).toContain(versions[n].snapshot + ".jsonl"); if (n > 0) expect(bodies).toContain(versions[n - 1].snapshot + ".jsonl");
  }
  const stale = await x.read({ session: "#1", cursor: versions[0].nextCursor }); expect(stale).toMatchObject({ status: "changed", viewChanged: true });
  await expect(readFile(join(x.directory, versions[0].evidenceRef!))).rejects.toMatchObject({ code: "ENOENT" });
});

test("a failed derived-cache cleanup is explicit, prevents accumulating rebuilds and retries safely", async () => {
  const x = await fixture(); let first!: SessionHistoryPage, latest!: SessionHistoryPage;
  for (let n = 0; n < 3; n++) {
    await writeFile(x.path, json(response("message", { role: "user", content: [{ type: "input_text", text: `keep-${n}` }] })));
    if (n === 2) fsGate.beforeUnlink = async (path) => { if (path.endsWith(first.snapshot + ".jsonl")) throw new Error("simulated cleanup failure"); };
    latest = await ready(x, { session: "#1", rebuild: n > 0 }); if (!n) first = latest;
  }
  const folder = join(x.directory, latest.evidenceRef!.split("/").slice(0, -1).join("/"));
  expect(latest.gaps.map((gap) => gap.kind)).toContain("cleanup_pending"); expect((await readdir(folder)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(3);
  expect((await x.read({ session: "#1", rebuild: true })).gaps[0].kind).toBe("cleanup_pending"); expect((await readdir(folder)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(3);
  fsGate.beforeUnlink = undefined; const resumed = await x.read(); expect(resumed.status).toBe("ready"); expect(resumed.gaps.map((gap) => gap.kind)).not.toContain("cleanup_pending"); expect((await readdir(folder)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2); expect(await readFile(x.path, "utf8")).toContain("keep-2");
});

test("repeated failed pointer publications never accumulate uncommitted snapshots or remove the old current", async () => {
  const x = await fixture(); await writeFile(x.path, json(response("message", { role: "user", content: [{ type: "input_text", text: "durable original" }] })));
  const original = await ready(x), folder = join(x.directory, original.evidenceRef!.split("/").slice(0, -1).join("/"));
  fsGate.beforeOpen = async (path) => { if (path.includes("current.json.") && path.endsWith(".tmp")) throw new Error("pointer publication failed"); };
  for (let n = 1; n <= 3; n++) {
    await writeFile(x.path, json(response("message", { role: "user", content: [{ type: "input_text", text: `uncommitted-${n}` }] })));
    expect((await x.read({ session: "#1", rebuild: true })).status).toBe("building");
    await vi.waitFor(async () => { expect((await x.read()).status).not.toBe("building"); });
    expect((await readdir(folder)).filter((name) => name.endsWith(".jsonl"))).toEqual([original.snapshot + ".jsonl"]);
    expect(await readFile(join(x.directory, original.evidenceRef!), "utf8")).toContain("durable original");
  }
  fsGate.beforeOpen = undefined;
  const current = await ready(x, { session: "#1", rebuild: true }); expect(current.entries[0].text).toBe("uncommitted-3"); expect((await readdir(folder)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
});

test("nested encoded tool arguments redact short credential values before serialization or truncation", async () => {
  const x = await fixture(), secret = "short-pass-852", command = `echo '${JSON.stringify({ password: secret })}'`;
  await writeFile(x.path, json(response("function_call", { name: "exec_command", arguments: JSON.stringify({ cmd: command, workdir: "src" }) })) + json(response("custom_tool_call", { name: "exec", input: { nested: [{ credentials: { password: secret } }], cmd: command } })));
  const page = await ready(x), evidence = await readFile(join(x.directory, page.evidenceRef!), "utf8");
  expect(JSON.stringify(page)).not.toContain(secret); expect(evidence).not.toContain(secret); expect(page.entries[0].text).toContain("[redacted]"); expect(page.entries[0].text).toContain("echo");
});

test("overly deep tool argument structures are omitted explicitly, and escaped values are decoded and redacted instead", async () => {
  const x = await fixture(), secret = "opaque-pass-512";
  let nested: unknown = { password: secret }; for (let n = 0; n < 20; n++) nested = { next: nested };
  const opaque = `echo \\"password\\":\\"${secret}\\"`;
  await writeFile(x.path, json(response("function_call", { name: "exec_command", arguments: JSON.stringify(nested) })) + json(response("function_call", { name: "exec_command", arguments: JSON.stringify({ cmd: opaque }) })));
  const page = await ready(x), evidence = await readFile(join(x.directory, page.evidenceRef!), "utf8");
  expect(evidence).not.toContain(secret); expect(JSON.stringify(page)).not.toContain(secret); expect(page.gaps.map((gap) => gap.kind)).toContain("tool_arguments_omitted"); expect(page.coverage?.complete).toBe(false);
  expect(page.entries[0].text).toContain("[arguments omitted: bounded parser]");
  expect(page.entries[1]).toMatchObject({ decoded: true }); expect(page.entries[1].text).toContain('echo "password":[redacted]');
});
