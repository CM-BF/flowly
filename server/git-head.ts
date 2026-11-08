import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHead } from "../shared/model";

const execute = promisify(execFile);

/**
 * Git reads of card continuity and sub-card handoffs (SESSION-HANDOFF-SPEC, SUB-CARDS-SPEC §8). They lived in
 * server/workpad.ts until upstream narrowed the workpad to the acceptance list (GUARDRAILS-SPEC §7.1); the short
 * timeout keeps a get_task that reads linked workspaces from waiting on a hung git.
 */
export type Git = (cwd: string, args: string[]) => Promise<string>;
export const defaultGit: Git = async (cwd, args) =>
  (await execute("git", ["-C", cwd, ...args], { timeout: 5000, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout;

const shaPattern = /^[0-9a-f]{4,40}$/;

/** HEAD, branch and dirty state of a workspace; null when it is not a git repository or git fails. */
export async function readHead(dir: string, git: Git, now = new Date().toISOString()): Promise<GitHead | null> {
  try {
    const sha = (await git(dir, ["rev-parse", "--short=12", "HEAD"])).trim();
    if (!shaPattern.test(sha)) return null;
    const [branch, status] = await Promise.all([
      git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim(), () => ""),
      git(dir, ["status", "--porcelain"]).then((s) => s, () => ""),
    ]);
    return { sha, ...(branch && branch !== "HEAD" ? { branch } : {}), dirty: !!status.trim(), at: now };
  } catch {
    return null;
  }
}
