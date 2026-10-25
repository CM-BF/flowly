import { afterEach, expect, test } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HandoffSession } from "../shared/handoff";
import { measureSessionPolicyFacts, readProviderUsageTail, usageReadLimits } from "./provider-usage";
import { claudeSidecarBytes, forgetHistory, type NativeHistoryFile } from "./provider-history";

const folders: string[] = [], stamp = "2026-10-24T00:00:00.000Z", now = Date.parse(stamp), uuid = "019a15e5-0000-7abc-8def-0123456789ab";
afterEach(async () => { forgetHistory(); await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const token = (C: number, at = stamp, W = 258400) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: C }, model_context_window: W } } }) + "\n";
const event = (type: string, at = stamp, extra = {}) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type, ...extra } }) + "\n";
const ledger = (patch: Partial<HandoffSession> = {}): HandoffSession => ({ id: "ledger", rev: 1, at: stamp, by: { kind: "flowly" }, agentId: "actor", n: 1, provider: "codex", role: "implementer", reason: "launch", startedAt: stamp, finalized: false, turns: [], live: [], background: [], ...patch });
async function fixture(provider: "codex" | "claude" = "codex", content = "") {
  const home = await mkdtemp(join(tmpdir(), "flowly-provider-usage-")); folders.push(home);
  const day = new Date(parseInt(uuid.replace(/-/g, "").slice(0, 12), 16));
  const folder = provider === "claude" ? join(home, "projects", "-fixture") : join(home, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
  await mkdir(folder, { recursive: true });
  const path = join(folder, provider === "claude" ? `${uuid}.jsonl` : `rollout-date-${uuid}.jsonl`); await writeFile(path, content);
  const actor = { id: "actor", provider, cwd: "/fixture", persistence: { provider, nativeHandle: uuid } };
  const file: NativeHistoryFile = { provider, sessionId: uuid, path };
  return { home, actor, file, options: { now: () => now, codexHome: home, claudeHome: home } };
}

test("snapshot wins, only the same ledger supplies fallback, and a fresh stat cannot reuse old B", async () => {
  const x = await fixture("codex", token(77));
  const prior = ledger({ measured: { turns: 4, C: 100, W: 200, C0: 30, K: 2, peakC: 170 }, through: { path: x.file.path, identity: "f:0", offset: 12, size: 99, at: stamp, gaps: 2, lagBytes: 88, resume: { observer: { usageAt: stamp, lastTurn: stamp, ttl: 240 } } } });
  const first = await measureSessionPolicyFacts({ ...x.actor, lastUsage: { contextWindowUsedTokens: 50, contextWindowMaxTokens: 120 } }, prior, x.options);
  expect(first).toMatchObject({ C: 50, W: 120, C0: 30, K: 2, peakC: 170, completedTurns: 4, usageSource: "snapshot", ttlKind: "codex", coverage: { gaps: 2, lagBytes: 88 } });
  expect(first.coverage?.tailBytes).toBeUndefined(); const oldB = first.B!;
  await appendFile(x.file.path, event("agent_message", stamp, { message: "new content" }));
  const second = await measureSessionPolicyFacts(x.actor, prior, x.options); expect(second.B).toBeGreaterThan(oldB); expect(second.C).toBe(100); expect(second.usageSource).toBe("ledger");
  const foreign = await measureSessionPolicyFacts(x.actor, { ...prior, agentId: "someone-else" }, x.options);
  expect(foreign.C).toBe(77); expect(foreign.K).not.toBe(2); expect(foreign.unknown).toContain("foreign ledger ignored");
});

test("bounded Codex tail fills missing facts without moving or erasing passive capture coverage", async () => {
  const later = "2026-10-24T00:10:00.000Z";
  const x = await fixture("codex", token(30) + token(150, later) + event("task_complete", later) + JSON.stringify({ timestamp: later, type: "compacted", payload: { latest_token_usage_record: {} } }) + "\n");
  const prior = ledger({ through: { path: x.file.path, identity: "inode:3", offset: 9, size: 999, at: stamp, gaps: 3, lagBytes: 500, resume: { pending: "keep" } } });
  const before = structuredClone(prior);
  const facts = await measureSessionPolicyFacts(x.actor, prior, x.options);
  expect(facts).toMatchObject({ C: 150, W: 258400, C0: 30, K: 1, peakC: 150, completedTurns: 1, usageSource: "tail", lastRequestAt: Date.parse(later), lastTurnEndAt: Date.parse(later), coverage: { gaps: 3, lagBytes: 500, tailComplete: true } });
  expect(prior).toEqual(before); expect(facts.activeMs).toBeUndefined();
});

test("null info, huge lines and an unfinished final line cannot invent C0 or consume an unbounded line", async () => {
  const x = await fixture("codex", token(40) + "X".repeat(300 * 1024) + "\n" + event("token_count", stamp, { info: null }) + token(90) + '{"type":"unfinished"');
  const facts = await readProviderUsageTail(x.file);
  expect(facts.C).toBe(90); expect(facts.C0).toBeUndefined(); expect(facts.readBytes).toBeLessThanOrEqual(usageReadLimits.bytes);
  expect(facts.unknown).toEqual(expect.arrayContaining(["unfinished final line", "usage tail long line skipped"]));
  expect(facts.K).toBeUndefined();
});

test("the newest usage can be found through a multi-block long line while a 16 MiB budget stays explicit", async () => {
  const x = await fixture("codex", token(10));
  const block = "x".repeat(2 ** 20);
  for (let n = 0; n < 17; n++) await appendFile(x.file.path, block);
  await appendFile(x.file.path, "\n" + token(180000));
  const facts = await readProviderUsageTail(x.file);
  expect(facts.C).toBe(180000); expect(facts.C0).toBeUndefined(); expect(facts.readBytes).toBe(16 * 2 ** 20); expect(facts.complete).toBe(false);
  expect(facts.unknown).toContain("usage tail budget exhausted");
  const aborted = new AbortController(); aborted.abort(); expect((await readProviderUsageTail(x.file, aborted.signal)).unknown).toContain("tail aborted");
});

test("Claude counts main-chain usage once per message, ignores sidechains and exposes the measured TTL tier", async () => {
  const assistant = (id: string, input: number, sidechain = false, tier = "ephemeral_1h_input_tokens") => JSON.stringify({ type: "assistant", timestamp: stamp, sessionId: uuid, isSidechain: sidechain, message: { id, content: [{ type: "text", text: "Do not retain this body or SECRET" }], usage: { input_tokens: input, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5, cache_creation: { [tier]: 20 } } } }) + "\n";
  const x = await fixture("claude", assistant("m1", 10) + assistant("m1", 10) + assistant("side", 999999, true) + assistant("m2", 50, false, "ephemeral_5m_input_tokens"));
  const facts = await measureSessionPolicyFacts({ ...x.actor, model: "claude-opus-5-5" }, undefined, x.options);
  expect(facts).toMatchObject({ C: 105, C0: 65, W: 1_000_000, ttlKind: "claude-5m", ttlSeconds: 240, peakC: 105 });
  expect(JSON.stringify(facts)).not.toContain("SECRET"); expect(facts.completedTurns).toBeUndefined();
});

test("Claude sidecar sizes are refreshed after five minutes even when folder mtime did not change; symlinks are skipped", async () => {
  const x = await fixture("claude", ""), root = x.file.path.slice(0, -6), subagents = join(root, "subagents"), workflows = join(root, "workflows");
  await mkdir(subagents, { recursive: true }); await mkdir(workflows, { recursive: true });
  const child = join(subagents, "agent-child.jsonl"); await writeFile(child, "123"); await writeFile(join(workflows, "one.json"), "45");
  await symlink(x.home, join(subagents, "outside"));
  const first = await claudeSidecarBytes(x.file, now); expect(first).toMatchObject({ bytes: 5, files: 2, complete: true });
  await appendFile(child, "6789"); expect((await claudeSidecarBytes(x.file, now + 1000)).bytes).toBe(5);
  expect((await claudeSidecarBytes(x.file, now + 300000)).bytes).toBe(9);
  const facts = await measureSessionPolicyFacts(x.actor, undefined, { ...x.options, now: () => now + 600000 });
  expect(facts.S).toBe(9); expect(facts.B).toBe(0); // Sidecars never replace main B.
});

test("unknown facts stay absent and cannot turn session age into work time or an observed cache TTL", async () => {
  const x = await fixture(); const facts = await measureSessionPolicyFacts({ id: "actor", provider: "pi" }, undefined, x.options);
  for (const name of ["C", "C0", "W", "B", "K", "activeMs", "completedTurns", "lastRequestAt", "lastTurnEndAt", "ttlSeconds"] as const) expect(facts[name]).toBeUndefined();
  expect(facts.ttlKind).toBe("unknown"); expect(facts.coverage?.gaps).toBeUndefined();
});

test("same logical actor with a different native identity cannot borrow old context, K or TTL", async () => {
  const x = await fixture("codex", token(80));
  const prior = ledger({ measured: { turns: 7, C: 999999, W: 999999, C0: 333, K: 8, peakC: 999999 }, through: { path: "old", identity: "old:0", offset: 100, size: 1000, at: stamp, gaps: 2, lagBytes: 90, resume: { sessionId: "old-native", observer: { ttl: 3300, activeMs: 99999999 } } } });
  const facts = await measureSessionPolicyFacts(x.actor, prior, x.options);
  expect(facts).toMatchObject({ C: 80, C0: 80, K: 0, W: 258400, coverage: { gaps: 2, lagBytes: 90 } });
  expect(facts.activeMs).toBeUndefined(); expect(facts.ttlSeconds).toBeUndefined(); expect(facts.unknown).toContain("native identity changed; previous measurements ignored");
});

test("a tail cannot turn the first surviving post-truncation usage into a proven initial context", async () => {
  const x = await fixture("codex", token(180000));
  const prior = ledger({ through: { path: x.file.path, identity: "file:1", offset: 0, size: 0, at: stamp, gaps: 1, lagBytes: 0, resume: { sessionId: uuid, epoch: 1, firstUsageAvailable: false } } });
  const facts = await measureSessionPolicyFacts(x.actor, prior, x.options);
  expect(facts.C).toBe(180000); expect(facts.C0).toBeUndefined(); expect(facts.coverage?.gaps).toBe(1);
  expect(facts.unknown).toContain("initial context unproven after capture discontinuity");
});

test("a 5000-entry sidecar stat cap produces a warning lower bound without adding it to main B", async () => {
  const x = await fixture("claude", ""), dir = join(x.file.path.slice(0, -6), "subagents");
  await mkdir(dir, { recursive: true });
  for (let offset = 0; offset < 5001; offset += 100)
    await Promise.all(Array.from({ length: Math.min(100, 5001 - offset) }, (_, n) => writeFile(join(dir, `agent-${offset + n}.jsonl`), "")));
  const facts = await measureSessionPolicyFacts(x.actor, undefined, x.options);
  expect(facts.B).toBe(0); expect(facts.S).toBeGreaterThanOrEqual(512 * 2 ** 20); expect(facts.unknown).toContain("sidecar stat budget exceeded; warning lower bound");
}, 20_000);

test("tail verification rejects a Codex session_meta identity mismatch even if later usage looks valid", async () => {
  const x = await fixture("codex", JSON.stringify({ type: "session_meta", payload: { id: "019a15e5-0000-7abc-8def-ffffffffffff" } }) + "\n" + token(190000));
  const facts = await readProviderUsageTail(x.file);
  expect(facts.C).toBeUndefined(); expect(facts.C0).toBeUndefined(); expect(facts.complete).toBe(false); expect(facts.unknown.length).toBeGreaterThan(0);
});

test("tail verification does not certify an unclosed JSON record as a complete initial usage", async () => {
  const x = await fixture("codex", token(170000).slice(0, -2) + "\n");
  const facts = await readProviderUsageTail(x.file);
  expect(facts.C0).toBeUndefined(); expect(facts.K).toBeUndefined(); expect(facts.complete).toBe(false); expect(facts.unknown.length).toBeGreaterThan(0);
});

test("tail verification ignores null inherited compaction records instead of confirming K", async () => {
  const x = await fixture("codex", token(190000) + JSON.stringify({ type: "compacted", payload: { latest_token_usage_record: null } }) + "\n");
  expect((await readProviderUsageTail(x.file)).K).toBe(0);
});

test("tail verification invalidates same-inode same-size rewrites whose mtime is restored", async () => {
  const x = await fixture("codex", token(111111)), fixed = new Date(stamp);
  await utimes(x.file.path, fixed, fixed); const before = await stat(x.file.path);
  expect((await readProviderUsageTail(x.file)).C).toBe(111111);
  await writeFile(x.file.path, token(222222)); await utimes(x.file.path, fixed, fixed); const after = await stat(x.file.path);
  expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size); expect(after.mtimeMs).toBe(before.mtimeMs);
  expect((await readProviderUsageTail(x.file)).C).toBe(222222);
});
