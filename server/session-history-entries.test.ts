import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionHistoryEntrySchema, sessionHistoryLimits, type SessionHistoryPage } from "../shared/session-history";
import { SessionHistory } from "./session-history";
import { forgetHistory } from "./provider-history";

// Every entry the builder publishes conforms to the entry schema (SESSION-HANDOFF-SPEC §8.1, §21.15): one entry that does
// not would make read() report the whole index unavailable, and a rebuild would build the same body again.
const roots: string[] = [], readers: SessionHistory[] = [];
afterEach(async () => { await Promise.all(readers.splice(0).map((reader) => reader.stop())); forgetHistory(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function build(provider: "codex" | "claude", id: string, text: string) {
  const root = await mkdtemp(join(tmpdir(), "flowly-history-entries-")); roots.push(root);
  const cwd = "/tmp/plugin-test-history-entries";
  const folder = provider === "codex" ? join(root, "codex", "sessions", "2026", "10", "25") : join(root, "claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(folder, { recursive: true }); await writeFile(join(folder, provider === "codex" ? `rollout-entries-${id}.jsonl` : `${id}.jsonl`), text);
  const reader = new SessionHistory(join(root, "derived"), { codexHome: join(root, "codex"), claudeHome: join(root, "claude") }); readers.push(reader);
  const agent = { id: `entries-${id.slice(-4)}`, provider, cwd, persistence: { provider, nativeHandle: id, sessionId: id } } as never;
  const settle = async (query: Parameters<SessionHistory["read"]>[1]) => {
    await reader.read(agent, query);
    let page!: SessionHistoryPage;
    await vi.waitFor(async () => { page = await reader.read(agent, { session: "#1" }); expect(page.status).not.toBe("building"); }, { timeout: 10_000, interval: 10 });
    return page;
  };
  const page = await settle({ session: "#1" });
  const body = page.evidenceRef ? await readFile(join(root, "derived", page.evidenceRef), "utf8") : "";
  return { reader, agent, page, body, settle, find: (query: string) => reader.read(agent, { session: "#1", query, limit: 20 }) };
}
const codex = (type: string, payload: unknown, timestamp = "2026-10-25T10:00:00.000Z") => JSON.stringify({ timestamp, type, payload }) + "\n";
/** A Bazel output path of 280 characters, as `find .` or a compiler prints it. */
const deep = "./bazel-out/darwin_arm64-fastbuild/bin/external/com_github_grpc_grpc/src/core/ext/filters/client_channel/lb_policy/xds/_objs/xds_cluster_resolver/xds_cluster_resolver.pic.o.d/../../../../../../../../../../../../../../external/com_google_absl/absl/strings/internal/str_format/arg.h";

test("a tool output that names a relative path longer than 240 characters leaves the index readable and searchable", async () => {
  expect(deep.length).toBeGreaterThan(241);
  const id = "01a17565-6df7-7f20-b755-0000000000c3", up = `../${"b/".repeat(130)}x.h`;
  const x = await build("codex", id, codex("session_meta", { id })
    + codex("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `Fix the build; the codeword is PLUMLINE-77. See ${up}` }] })
    + codex("response_item", { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "find . -name '*.d' | head -1" }) })
    + codex("response_item", { type: "function_call_output", call_id: "c1", output: `Process exited with code 0\nOutput:\n${deep}\n` }));
  expect(x.page).toMatchObject({ status: "ready" }); expect(x.page.gaps.map((gap) => gap.kind)).not.toContain("skeleton_invalid");
  for (const line of x.body.split("\n").filter(Boolean)) expect(sessionHistoryEntrySchema.safeParse(JSON.parse(line)).success).toBe(true);
  expect((await x.find("PLUMLINE-77")).entries).toHaveLength(1);
  // The long path stays searchable by its first 240 characters, and the output keeps it whole in its text.
  const output = (await x.find("xds_cluster_resolver.pic.o.d")).entries.find((entry) => entry.tool?.kind === "output")!;
  expect(output.text).toContain(deep); expect(output.paths).toContain(deep.slice(0, 240));
  expect((await x.find(up.slice(0, 200))).entries).toHaveLength(1);
});

test("the same path in a Claude stack trace leaves the index readable", async () => {
  const id = "d1a17565-6df7-4f20-b755-0000000000c4";
  const record = (type: string, uuid: string, message: unknown) => JSON.stringify({ type, sessionId: id, uuid, timestamp: "2026-10-25T10:00:00.000Z", message }) + "\n";
  const x = await build("claude", id, record("user", "u1", { role: "user", content: "Fix the build; the codeword is PLUMLINE-78." })
    + record("assistant", "a1", { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] })
    + record("user", "u2", { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `Error: Cannot find module\n    at Object.<anonymous> (${deep})\n`, is_error: true }] }));
  expect(x.page.status).toBe("ready");
  expect((await x.find("PLUMLINE-78")).entries).toHaveLength(1);
  expect((await x.find("Cannot find module")).entries[0].tool).toMatchObject({ kind: "output", outcome: "error" });
});

test("a field the source fills past the schema is bounded before the index is published, so no entry makes it unreadable", async () => {
  // V8 parses a date with a long parenthesized comment; the source's own timestamp would pass the 80-character bound.
  const id = "01a17565-6df7-7f20-b755-0000000000c5", odd = `Oct 25 2026 10:00 (${"x".repeat(120)})`;
  expect(Number.isFinite(Date.parse(odd))).toBe(true);
  const x = await build("codex", id, codex("session_meta", { id })
    + codex("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Keep the codeword PLUMLINE-79." }] }, odd)
    + codex("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Noted." }] }));
  expect(x.page.status).toBe("ready");
  const [hit] = (await x.find("PLUMLINE-79")).entries;
  expect(hit.at).toBe(new Date(Date.parse(odd)).toISOString());
  expect(Buffer.byteLength(x.body)).toBeLessThanOrEqual(sessionHistoryLimits.skeletonBytes);
});
