import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetHistory, historyBytes, oversized } from "./provider-history";
import { historyLimits } from "../shared/automation";

// AUTOMATION-SPEC §4.6: Flowly measures a Codex session's rollout file, found from the thread id alone.
const homes: string[] = [];
afterEach(async () => { forgetHistory(); await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true }))); });

const pad = (n: number) => String(n).padStart(2, "0");
/** A UUIDv7 thread id created at `ms`, and the local day folder Codex files it under. */
function thread(ms: number) {
  const hex = ms.toString(16).padStart(12, "0");
  const d = new Date(ms);
  return { id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`, day: [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())] };
}
async function codexHome() {
  const home = await mkdtemp(join(tmpdir(), "flowly-codex-"));
  homes.push(home);
  return home;
}
/** A sparse rollout file of `bytes` (no data is written). */
async function rollout(dir: string, id: string, bytes: number) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-23T16-54-42-${id}.jsonl`);
  await writeFile(path, "");
  await truncate(path, bytes);
  return path;
}
const codex = (id: string) => ({ provider: "codex", persistence: { provider: "codex", sessionId: id, nativeHandle: id } });

test("a Codex session's history is the size of its rollout, found in the thread's day folder or in archived_sessions", async () => {
  const home = await codexHome();
  const { id, day } = thread(Date.parse("2026-10-23T23:54:42Z"));
  const path = await rollout(join(home, "sessions", ...day), id, 250 * 2 ** 20);
  expect(await historyBytes(codex(id), home)).toBe(250 * 2 ** 20);
  // Renamed away (the 2026-10-23 recovery renamed the rollout to .bak): no longer this thread's history.
  await rename(path, `${path}.bak`);
  expect(await historyBytes(codex(id), home)).toBeNull();
  await rollout(join(home, "archived_sessions"), id, 1024);
  expect(await historyBytes(codex(id), home)).toBe(1024);
});

test("sessions Flowly cannot measure are unknown, never zero", async () => {
  const home = await codexHome();
  const { id } = thread(Date.parse("2026-10-23T23:54:42Z"));
  expect(await historyBytes({ provider: "claude", persistence: { provider: "claude", sessionId: id } }, home)).toBeNull();
  expect(await historyBytes({ provider: "codex", persistence: null }, home)).toBeNull();
  expect(await historyBytes(codex("../../etc/passwd"), home)).toBeNull();
  expect(await historyBytes(codex(id), home)).toBeNull();
});

test("an oversized session is reported from one snapshot a minute; smaller ones are not", async () => {
  let refreshes = 0;
  const paseo = { agents: { ref: (agentId: string) => ({ refresh: async () => { refreshes++; return { agent: { id: agentId } }; } }) } } as never;
  const sizes: Record<string, number> = { big: historyLimits.rotate, small: historyLimits.rotate - 1 };
  const measure = async (agent: { id?: string }) => sizes[agent.id!] ?? null;
  expect(await oversized(paseo, "big", 0, measure)).toBe(historyLimits.rotate);
  expect(await oversized(paseo, "small", 0, measure)).toBeNull();
  expect(await oversized(paseo, "big", 30_000, measure)).toBe(historyLimits.rotate);
  expect(refreshes).toBe(2);
  await oversized(paseo, "big", 61_000, measure);
  expect(refreshes).toBe(3);
});

test("a provider built on Codex (persistence keeps metadata.provider codex) is measured, and the neighbouring day folder is searched", async () => {
  const home = await codexHome();
  const ms = Date.parse("2026-10-23T23:54:42Z");
  const { id } = thread(ms);
  const before = new Date(ms - 86_400_000);
  await rollout(join(home, "sessions", String(before.getFullYear()), pad(before.getMonth() + 1), pad(before.getDate())), id, 4096);
  const derived = { provider: "codex-azure", persistence: { provider: "codex-azure", sessionId: id, nativeHandle: id, metadata: { provider: "codex", threadId: id } } };
  expect(await historyBytes(derived, home)).toBe(4096);
});
