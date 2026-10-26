import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { sessionHistoryExcerpts, type SessionHistoryPage } from "../shared/session-history";
import { SessionHistory } from "./session-history";
import { excerpt, redactHistory } from "./session-history-text";
import { releaseHistory } from "./session-history-fixture";

// Tool outputs carry untrusted text, and an output line with no line start and no safe element boundary is redacted
// whole: every redaction rule is linear in its input, so one such line cannot stall the plugin (SESSION-HANDOFF-SPEC §8.1,
// §21.16). Each of these took 0.2–18 s at 120–240 KB before.
const roots: string[] = [], readers: SessionHistory[] = [];
afterEach(async () => { expect(await releaseHistory(readers, roots)).toEqual([]); });
const size = 240_000;
const repeat = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const shapes: Record<string, string> = {
  "a run with word boundaries (URL scheme)": repeat("x-"), "dotted pairs": repeat("ab."), "plus signs": repeat("a+"),
  "many mysql words on one line": repeat("mysql "), "a mysql word and a long word between": repeat(`mysql ${"x".repeat(20)} `),
  "JWT-like starts": repeat("eyJ-"), "URL user info with many colons": `http://${repeat("a:")}`, "one long identifier": repeat("API_KEY"),
  "credential-shaped words before a comma and quote": `${repeat("key").slice(0, 70_000)},"${repeat("value ")}`,
};

test("each redaction rule is linear on adversarial one-line text", () => {
  redactHistory(repeat("warm up ").slice(0, 10_000));
  const slow = Object.entries(shapes).map(([name, text]) => { const started = performance.now(); redactHistory(text); return { name, ms: Math.round(performance.now() - started) }; }).filter((result) => result.ms > 500);
  expect(slow).toEqual([]);
  // An excerpt of each, which also places the tail window.
  const started = performance.now();
  for (const text of Object.values(shapes)) excerpt([{ text }], sessionHistoryExcerpts.output, { from: 0, to: text.length });
  expect(performance.now() - started).toBeLessThan(3000);
});

test("one 240 KB output line does not block the event loop while the index builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowly-history-cost-")); roots.push(root);
  const id = "01a17565-6df7-7f20-b755-0000000000f1", folder = join(root, "codex", "sessions", "2026", "10", "25");
  const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: "2026-10-25T10:00:00.000Z", type, payload }) + "\n";
  let text = line("session_meta", { id }) + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the asset; the codeword is KESTREL-12." }] });
  for (const [n, shape] of [repeat("x-"), repeat("eyJ-"), repeat("mysql ")].entries())
    text += line("response_item", { type: "function_call", call_id: `c${n}`, name: "exec_command", arguments: JSON.stringify({ cmd: `curl -s https://example.invalid/asset-${n}` }) })
      + line("response_item", { type: "function_call_output", call_id: `c${n}`, output: `Process exited with code 0\nOutput:\n${shape}` });
  await mkdir(folder, { recursive: true }); await writeFile(join(folder, `rollout-cost-${id}.jsonl`), text);
  const reader = new SessionHistory(join(root, "derived"), { codexHome: join(root, "codex") }); readers.push(reader);
  const agent = { id: "cost-agent", provider: "codex", persistence: { provider: "codex", nativeHandle: id, sessionId: id } } as never;
  let last = Date.now(), worst = 0;
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 20);
  try {
    await reader.read(agent, { session: "#1" });
    let page!: SessionHistoryPage;
    await vi.waitFor(async () => { page = await reader.read(agent, { session: "#1" }); expect(page.status).not.toBe("building"); }, { timeout: 60_000, interval: 20 });
    expect(page.status).toBe("ready");
  } finally { clearInterval(timer); }
  expect(worst).toBeLessThan(1000);
  expect((await reader.read(agent, { session: "#1", query: "KESTREL-12" })).entries).toHaveLength(1);
}, 120_000);
