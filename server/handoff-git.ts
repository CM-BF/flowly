import { createHash } from "node:crypto";
import { opendir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultGit, type Git } from "./workpad";

/** Metadata only: no diff bodies, credentials or file contents enter a handoff. */
export interface HandoffGitSnapshot {
  repo: string;
  sha: string | null;
  branch?: string;
  dirty: boolean;
  dirtyHash?: string;
  files?: string[];
  filesTotal?: number;
  diffstat?: string;
  upstream?: string;
  at: string;
  error?: string;
}

/** Porcelain -z uses a second path for rename/copy records. Keep both in the fingerprint. */
function changedPaths(status: string) {
  const chunks = status.split("\0");
  const paths = new Map<string, string>();
  for (let index = 0; index < chunks.length; index++) {
    const row = chunks[index];
    if (!row) continue;
    paths.set(row.slice(3), row.slice(0, 2));
    if (/[RC]/.test(row.slice(0, 2)) && chunks[index + 1]) paths.set(chunks[++index], "D");
  }
  return paths;
}

/** A failed status read is unknown, never a clean checkout. */
export async function handoffGitSnapshot(repo: string, git: Git = defaultGit, at = new Date().toISOString()): Promise<HandoffGitSnapshot> {
  let sha: string | null = null;
  try {
    const head = (await git(repo, ["rev-parse", "--verify", "HEAD"])).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error("Invalid HEAD");
    sha = head;
    const [branch, status, diffstat, upstream] = await Promise.all([
      git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).then((value) => value.trim()),
      git(repo, ["--no-optional-locks", "status", "--porcelain=v1", "-z"]),
      git(repo, ["diff", "--stat", "HEAD"]).then((value) => value.slice(0, 1000), () => "unavailable"),
      git(repo, ["rev-list", "--count", "@{upstream}..HEAD"]).then((value) => value.trim(), () => "unknown"),
    ]);
    const statuses = changedPaths(status);
    const files = [...statuses.keys()];
    const hash = createHash("sha256").update(status);
    let incomplete = false;
    // Even an unchanged porcelain line must become stale when the same file is edited again.
    for (const file of files.slice(0, 50)) {
      const metadata = await stat(join(repo, file)).catch(() => null);
      hash.update(JSON.stringify([file, metadata?.size ?? null, metadata?.mtimeMs ?? null, metadata?.ctimeMs ?? null]));
      if (!metadata && !statuses.get(file)?.includes("D")) incomplete = true;
    }
    return {
      repo, sha, ...(branch !== "HEAD" ? { branch } : {}), dirty: files.length > 0,
      dirtyHash: hash.digest("hex"), files: files.slice(0, 50), filesTotal: files.length,
      diffstat, upstream, at,
      ...(files.length > 50 || incomplete ? { error: "File metadata coverage is partial; verify the remaining changed paths." } : {}),
    };
  } catch {
    return { repo, sha, dirty: false, at, error: "Git HEAD or working-tree status is unavailable; cleanliness is unknown." };
  }
}

/** A common project root can contain several repositories. Inspect only its immediate children. */
export async function handoffGitDirectories(roots: readonly string[], limit = 8) {
  const candidates = new Set<string>();
  const unchecked: string[] = [];
  for (const original of [...new Set(roots)].slice(0, 32)) {
    const root = resolve(original);
    candidates.add(root);
    let visited = 0;
    try {
      const entries = await opendir(root);
      for await (const entry of entries) {
        if (++visited > 256) {
          unchecked.push(`${root}: remaining immediate children`);
          break;
        }
        if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
        const child = join(root, entry.name);
        if (await stat(join(child, ".git")).then(() => true, () => false)) candidates.add(child);
      }
    } catch {
      unchecked.push(`${root}: child repository discovery unavailable`);
    }
  }
  if (roots.length > 32) unchecked.push(...roots.slice(32));
  const paths = [...candidates];
  unchecked.push(...paths.slice(limit));
  return { directories: paths.slice(0, limit), unchecked };
}
