import { lstat, opendir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { historyLimits } from "../shared/automation";

/** What a session snapshot tells about its provider-native history (AgentSnapshotPayload.persistence). */
export type HistoryAgent = {
  id?: string;
  provider?: string | null;
  cwd?: string | null;
  persistence?: { provider?: string; sessionId?: string; nativeHandle?: string; metadata?: { provider?: string; threadId?: string } | null } | null;
};

const paths = new Map<string, string>();
const day = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NativeHistoryFile = { provider: "codex" | "claude"; sessionId: string; path: string };
export type NativeHistoryLocation = { file?: NativeHistoryFile; reason?: "unsupported_provider" | "invalid_session" | "source_missing" | "locator_budget" | "aborted" };

function nativeIdentity(agent: HistoryAgent): { provider: "codex" | "claude" | undefined; sessionId: string | undefined } {
  const persisted = agent.persistence;
  const names = [persisted?.metadata?.provider, persisted?.provider, agent.provider];
  const provider = names.includes("codex") ? "codex" : names.includes("claude") ? "claude" : undefined;
  return { provider, sessionId: persisted?.metadata?.threadId ?? persisted?.nativeHandle ?? persisted?.sessionId };
}

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
async function codexHistoryPath(agent: HistoryAgent, home: string, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null;
  // A provider that extends Codex (e.g. "codex-azure") renames provider and persistence.provider; metadata keeps "codex".
  const persisted = agent.persistence;
  const codex = [persisted?.metadata?.provider, persisted?.provider, agent.provider].includes("codex");
  const thread = persisted?.metadata?.threadId ?? persisted?.nativeHandle ?? persisted?.sessionId;
  if (!codex || !thread || !sessionIdPattern.test(thread)) return null;
  const key = `${home}\0${thread}`;
  const known = paths.get(key);
  if (known) {
    const size = (await stat(known).catch(() => null))?.size;
    if (size !== undefined) return known;
    paths.delete(key);
  }
  const suffix = `-${thread}.jsonl`;
  for (const dir of [...dayFolders(thread).map((parts) => join(home, "sessions", ...parts)), join(home, "archived_sessions")]) {
    if (signal?.aborted) return null;
    const name = (await readdir(dir).catch(() => [] as string[])).find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
    if (!name) continue;
    const size = (await stat(join(dir, name)).catch(() => null))?.size;
    if (size === undefined) continue;
    paths.set(key, join(dir, name));
    return join(dir, name);
  }
  return null;
}

export async function historyBytes(agent: HistoryAgent, home = process.env.CODEX_HOME || join(homedir(), ".codex")): Promise<number | null> {
  // Keep the existing safety guard Codex-only: Claude has a different loading cost and is observation-only in P1.
  const path = await codexHistoryPath(agent, home);
  return path ? (await stat(path).catch(() => null))?.size ?? null : null;
}

/** Claude Agent SDK / Paseo 0.12 project-dir encoding; moved projects retain their original transcript folder. */
function claudeProjectName(cwd: string) {
  const value = process.platform === "darwin" ? cwd.normalize("NFC") : cwd;
  const name = value.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

async function containedFile(path: string, home: string): Promise<string | null> {
  if (!(await lstat(path).catch(() => null))?.isFile()) return null;
  const [root, file] = await Promise.all([realpath(home), realpath(path)]);
  const rel = relative(root, file);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep) ? file : null;
}

/** Only native UUID filenames below the provider home; never treats persistence.nativeHandle as a filesystem path. */
export async function locateProviderHistory(agent: HistoryAgent, options: { codexHome?: string; claudeHome?: string; signal?: AbortSignal } = {}): Promise<NativeHistoryLocation> {
  if (options.signal?.aborted) return { reason: "aborted" };
  const { provider, sessionId } = nativeIdentity(agent);
  if (!provider) return { reason: "unsupported_provider" };
  if (!sessionId || !sessionIdPattern.test(sessionId)) return { reason: "invalid_session" };
  try {
    const home = provider === "codex" ? options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex") : options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    if (provider === "codex") {
      const found = await codexHistoryPath(agent, home, options.signal);
      if (options.signal?.aborted) return { reason: "aborted" };
      const path = found && await containedFile(found, home);
      return path ? { file: { provider, sessionId, path } } : { reason: "source_missing" };
    }
    const projects = join(home, "projects"), filename = `${sessionId}.jsonl`;
    if (agent.cwd) {
      const cwd = await realpath(agent.cwd).catch(() => agent.cwd!);
      const path = await containedFile(join(projects, claudeProjectName(cwd), filename), home);
      if (path) return { file: { provider, sessionId, path } };
    }
    const directory = await opendir(projects).catch(() => null);
    if (!directory) return { reason: "source_missing" };
    let count = 0;
    for await (const entry of directory) {
      if (options.signal?.aborted) return { reason: "aborted" };
      if (++count > 5000) return { reason: "locator_budget" };
      if (!entry.isDirectory()) continue;
      const path = await containedFile(join(projects, entry.name, filename), home);
      if (path) return { file: { provider, sessionId, path } };
    }
    return { reason: "source_missing" };
  } catch { return { reason: "source_missing" }; }
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
