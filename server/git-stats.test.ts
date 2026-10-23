import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitStats, parseLog } from "./git-stats";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "flowly-git-stats-"));
  roots.push(root);
  return root;
}

const log = [
  "\x1eaaa\x1f2026-10-16T09:00:00+08:00\x1fAdd insights",
  "",
  "10\t2\tshared/insights.ts",
  "-\t-\tdocs/image.png",
  "\x1ebbb\x1f2026-10-15T09:00:00+08:00\x1fFix: tabs\tand stuff",
  "",
  "1\t1\tclient/board.tsx",
  "",
].join("\n");

test("parses commits with numstat; binary files count no lines", () => {
  const commits = parseLog(log, "/repo");
  expect(commits).toEqual([
    {
      hash: "aaa",
      at: "2026-10-16T09:00:00+08:00",
      subject: "Add insights",
      repo: "/repo",
      files: [
        { path: "shared/insights.ts", added: 10, deleted: 2 },
        { path: "docs/image.png", added: 0, deleted: 0 },
      ],
    },
    { hash: "bbb", at: "2026-10-15T09:00:00+08:00", subject: "Fix: tabs\tand stuff", repo: "/repo", files: [{ path: "client/board.tsx", added: 1, deleted: 1 }] },
  ]);
});

test("reports git errors without failing, and passes arguments as an array", async () => {
  const root = await directory();
  await mkdir(join(root, ".git"));
  const calls: string[][] = [];
  const stats = new GitStats(async (_cwd, args) => {
    calls.push(args);
    throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  });
  const result = await stats.commits(root, Date.parse("2026-10-08T00:00:00Z"));
  expect(result.error).toBe("git is not installed.");
  expect(result.commits).toEqual([]);
  expect(calls[0]).toContain("--all");
  expect(calls[0]).toContain("--since=2026-10-08T00:00:00.000Z");
});

test("a directory with no repositories returns an empty result without invoking git", async () => {
  let calls = 0;
  const stats = new GitStats(async () => { calls++; throw new Error("must not run"); });
  expect(await stats.commits(await directory(), Date.parse("2026-10-08T00:00:00Z"))).toEqual({ commits: [], repos: 0, error: null });
  expect(calls).toBe(0);
});
