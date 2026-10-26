import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionHistoryPage } from "../shared/session-history";
import { SessionHistory } from "./session-history";
import { redactHistory, sanitizeText } from "./session-history-text";
import { filler, releaseHistory } from "./session-history-fixture";

// The history-only credential-file rules (.pgpass, .netrc, a bare `password` line, cookies) match only what those files and
// headers look like, so what `grep -n`, `rg -n` and Claude's Grep print over JSONL and timestamped logs stays searchable
// (SESSION-HANDOFF-SPEC §8.1, §21.16).
const roots: string[] = [], readers: SessionHistory[] = [];
afterEach(async () => { expect(await releaseHistory(readers, roots)).toEqual([]); });

async function indexed(provider: "codex" | "claude", id: string, text: string) {
  const root = await mkdtemp(join(tmpdir(), "flowly-history-lines-")); roots.push(root);
  const cwd = "/tmp/plugin-test-history-lines";
  const folder = provider === "codex" ? join(root, "codex", "sessions", "2026", "10", "25") : join(root, "claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(folder, { recursive: true }); await writeFile(join(folder, provider === "codex" ? `rollout-lines-${id}.jsonl` : `${id}.jsonl`), text);
  const reader = new SessionHistory(join(root, "derived"), { codexHome: join(root, "codex"), claudeHome: join(root, "claude") }); readers.push(reader);
  const agent = { id: `lines-${id.slice(-4)}`, provider, cwd, persistence: { provider, nativeHandle: id, sessionId: id } } as never;
  await reader.read(agent, { session: "#1" });
  let page!: SessionHistoryPage;
  await vi.waitFor(async () => { page = await reader.read(agent, { session: "#1" }); expect(page.status).toBe("ready"); }, { timeout: 10_000, interval: 10 });
  return async (query: string) => (await reader.read(agent, { session: "#1", query, limit: 20 })).entries.length;
}
const at = "2026-10-25T10:00:00.000Z";
const codex = (type: string, payload: unknown) => JSON.stringify({ timestamp: at, type, payload }) + "\n";
const printed = [
  "logs/app.log:88:2026-10-25T10:00:00Z ERROR payment webhook timed out after 30s (order 5512)",
  "notes/card.jsonl:3:{\"id\":\"n3\",\"text\":\"The codeword is QUILLFERN-5821\"}",
  "rollout.jsonl:39:{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"text\":\"FAIL checkout.test.ts > applies the coupon\"}}",
].join("\n") + "\n";
const searched = async (find: (query: string) => Promise<number>) => ({ codeword: await find("QUILLFERN-5821"), error: await find("webhook timed out"), fail: await find("applies the coupon") });

test("Codex: rg -n output over JSONL and a timestamped log keeps the matched lines searchable", async () => {
  const id = "01a17565-6df7-7f20-b755-0000000000e1";
  const find = await indexed("codex", id, codex("session_meta", { id })
    + codex("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Find why the webhook fails." }] })
    + codex("response_item", { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "rg -n 'QUILLFERN|ERROR|FAIL' logs notes rollout.jsonl" }) })
    + codex("response_item", { type: "function_call_output", call_id: "c1", output: `Chunk ID: 4f2a91\nWall time: 0.0123 seconds\nProcess exited with code 0\nOriginal token count: 80\nOutput:\n${printed}` }));
  expect(await searched(find)).toEqual({ codeword: 1, error: 1, fail: 1 });
});

test("Claude: a Grep tool result with line numbers keeps the matched lines searchable", async () => {
  const id = "e1a17565-6df7-4f20-b755-0000000000e2";
  const record = (type: string, uuid: string, message: unknown) => JSON.stringify({ type, sessionId: id, uuid, timestamp: at, message }) + "\n";
  const find = await indexed("claude", id, record("user", "u1", { role: "user", content: "Find why the webhook fails." })
    + record("assistant", "a1", { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "QUILLFERN|ERROR|FAIL", output_mode: "content", "-n": true } }] })
    + record("user", "u2", { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: printed }] }));
  expect(await searched(find)).toEqual({ codeword: 1, error: 1, fail: 1 });
});

test("lines that only look like credential files stay readable; the files themselves are still redacted", () => {
  const readable = [
    ...printed.trim().split("\n"),
    "app.log:88:2026-10-25T10:00:00Z ERROR payment webhook timed out",
    "src/config.yml:3:image:nginx:1.25-alpine",
    "server/x.test.ts:12:  it('parses', () => {",
    "Use the default password policy for new users.",
    "INFO default password hasher: argon2id",
    " ✓ server/cookie.test.ts > cookie: keeps SameSite on refresh (3 ms)",
    "describe(\"cookie: parses the header\")",
  ];
  expect(readable.filter((text) => redactHistory(text) !== text)).toEqual([]);
  const v = "Zq123456v.789012";
  const secrets = {
    pgpass: `db.example.com:5432:app:admin:${v}`,
    pgpassWildcards: `*:*:*:postgres:${v}`,
    pgpassEscaped: `localhost:5432:app\\:prod:admin:pa\\:${v}`,
    pgpassAddress: `127.0.0.1:6432:app:admin:${v}  `,
    netrc: `machine api.example.com login citrine password ${v}`,
    netrcTwoOnOneLine: `machine a.example.com login x password other-pass-1 machine b.example.com login y password ${v}`,
    netrcLines: `machine api.example.com\n  login citrine\n  password ${v}`,
    netrcDefault: `default login anonymous password ${v}`,
    netrcTail: `  login citrine\n  password ${v}`,
    netrcBareLine: `password ${v}`,
    netrcNumbered: `     1\tdefault login anonymous password ${v}`,
    netrcGrep: `.netrc:3:default password ${v}`,
    pgpassNumbered: `     2\tdb.example.com:5432:app:admin:${v}`,
    pgpassGrep: `/home/me/.pgpass:2:db.example.com:5432:app:admin:${v}`,
    cookie: `Cookie: theme=dark; PHPSESSID=${v}`,
    setCookie: `Set-Cookie: id=${v}; Path=/; HttpOnly`,
    cookieToken: `cookie: ${v}${v}`,
    cookieJson: `{"cookie": "sid=${v}"}`,
  };
  expect(Object.entries(secrets).filter(([, text]) => redactHistory(text).includes(v) || (sanitizeText(text)?.text ?? v).includes(v)).map(([name]) => name)).toEqual([]);
  // A credential file printed in the tail of a long output is still redacted there.
  for (const text of Object.values(secrets)) expect(redactHistory(`${filler(9000)}\n${text}\n`)).not.toContain(v);
});
