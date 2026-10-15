import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Commit } from "../shared/insights";

/** Git changes of a project root (PROJECT-INSIGHTS-SPEC §6). */
export const MAX_REPOS = 20;
const CACHE_MS = 60_000;
const RS = "\x1e",
  US = "\x1f";

function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

const isRepo = async (path: string) => {
  try {
    await stat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
};

/** The root when it is a repository, plus first-level child repositories (symlinks included). */
export async function findRepos(root: string): Promise<string[]> {
  const repos: string[] = [];
  if (await isRepo(root)) repos.push(root);
  let children: string[] = [];
  try {
    children = (await readdir(root, { withFileTypes: true }))
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
      .map((d) => join(root, d.name))
      .sort();
  } catch {
    return repos;
  }
  for (const child of children) {
    if (repos.length >= MAX_REPOS) break;
    if (await isRepo(child)) repos.push(child);
  }
  return repos;
}

/** Parses `git log --format=%x1e%H%x1f%aI%x1f%s --numstat`. Binary files count no lines. */
export function parseLog(text: string, repo: string): Commit[] {
  const out: Commit[] = [];
  for (const chunk of text.split(RS)) {
    if (!chunk.trim()) continue;
    const [head, ...rest] = chunk.split("\n");
    const [hash, at, subject = ""] = head.split(US);
    if (!hash || !at) continue;
    const files: Commit["files"] = [];
    for (const line of rest) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
      if (!m) continue;
      files.push({ path: m[3], added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
    }
    out.push({ hash, at, subject, repo, files });
  }
  return out;
}

type Result = { commits: Commit[]; repos: number; error: string | null };

export class GitStats {
  private cache = new Map<string, { at: number; key: string; result: Result }>();
  constructor(private run = git) {}

  /** Commits on any local ref since `sinceMs`, de-duplicated by hash. */
  async commits(root: string, sinceMs: number, now = Date.now()): Promise<Result> {
    const cached = this.cache.get(root);
    const key = String(sinceMs - (sinceMs % 3_600_000));
    if (cached && cached.key === key && now - cached.at < CACHE_MS) return cached.result;
    const repos = await findRepos(root);
    const seen = new Set<string>();
    const commits: Commit[] = [];
    const errors: string[] = [];
    for (const repo of repos) {
      try {
        const text = await this.run(repo, [
          "log",
          "--all",
          "--no-merges",
          `--since=${new Date(sinceMs).toISOString()}`,
          `--format=${RS}%H${US}%aI${US}%s`,
          "--numstat",
        ]);
        for (const c of parseLog(text, repo)) {
          if (seen.has(c.hash)) continue;
          seen.add(c.hash);
          commits.push(c);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        errors.push(code === "ENOENT" ? "git is not installed." : `${repo}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
    const result = { commits, repos: repos.length, error: errors.length ? errors.join("; ").slice(0, 500) : null };
    this.cache.set(root, { at: now, key, result });
    return result;
  }
}
