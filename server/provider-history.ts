import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { historyLimits } from "../shared/automation";

/** What a session snapshot tells about its provider-native history (AgentSnapshotPayload.persistence). */
export type HistoryAgent = {
  id?: string;
  provider?: string | null;
  persistence?: { provider?: string; sessionId?: string; nativeHandle?: string; metadata?: { provider?: string; threadId?: string } | null } | null;
};

const paths = new Map<string, string>();
const day = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** Day folders Codex may have filed a thread under: the local day of its UUIDv7 timestamp and the days next to it. */
function dayFolders(thread: string) {
  const ms = parseInt(thread.replace(/-/g, "").slice(0, 12), 16);
  if (!Number.isFinite(ms) || thread[14] !== "7") return [];
  return [0, -1, 1].map((offset) => {
    const d = new Date(ms + offset * day);
    return [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())];
  });
}

/**
 * Size in bytes of a session's provider-native history, or null when Flowly cannot see it (AUTOMATION-SPEC §4.6).
 * Codex keeps one rollout file per thread (CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl, moved to
 * archived_sessions when archived), and Paseo reads the whole thread as one message when it loads the session
 * (after a daemon restart, a history refresh or a message to an unloaded session): past a few hundred MB that
 * message no longer fits in a string and the daemon's worker crashes.
 */
export async function historyBytes(agent: HistoryAgent, home = process.env.CODEX_HOME || join(homedir(), ".codex")): Promise<number | null> {
  // A provider that extends Codex (e.g. "codex-azure") renames provider and persistence.provider; metadata keeps "codex".
  const persisted = agent.persistence;
  const codex = [persisted?.metadata?.provider, persisted?.provider, agent.provider].includes("codex");
  const thread = persisted?.metadata?.threadId ?? persisted?.nativeHandle ?? persisted?.sessionId;
  if (!codex || !thread || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(thread)) return null;
  const known = paths.get(thread);
  if (known) {
    const size = (await stat(known).catch(() => null))?.size;
    if (size !== undefined) return size;
    paths.delete(thread);
  }
  const suffix = `-${thread}.jsonl`;
  for (const dir of [...dayFolders(thread).map((parts) => join(home, "sessions", ...parts)), join(home, "archived_sessions")]) {
    const name = (await readdir(dir).catch(() => [] as string[])).find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
    if (!name) continue;
    const size = (await stat(join(dir, name)).catch(() => null))?.size;
    if (size === undefined) continue;
    paths.set(thread, join(dir, name));
    return size;
  }
  return null;
}

const checked = new Map<string, { at: number; bytes: number | null }>();
/** Forgets every measurement (tests). */
export function forgetHistory() {
  checked.clear();
  paths.clear();
}

/**
 * The session's history size when it is too large to load safely (`historyLimits.rotate`), else null. Callers skip
 * reading such a session's timeline: the read itself can make Paseo load the whole thread. Cached for a minute.
 */
export async function oversized(paseo: PaseoApi, agentId: string, now = Date.now(), measure = historyBytes): Promise<number | null> {
  const hit = checked.get(agentId);
  if (hit && now - hit.at < 60_000) return hit.bytes !== null && hit.bytes >= historyLimits.rotate ? hit.bytes : null;
  const agent = (await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent as HistoryAgent | undefined;
  const bytes = agent ? await measure(agent).catch(() => null) : null;
  checked.set(agentId, { at: now, bytes });
  return bytes !== null && bytes >= historyLimits.rotate ? bytes : null;
}

export const megabytes = (bytes: number) => Math.round(bytes / 2 ** 20);
