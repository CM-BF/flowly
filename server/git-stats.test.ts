import { expect, test } from "vitest";
import { GitStats, parseLog } from "./git-stats";

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
  const calls: string[][] = [];
  const stats = new GitStats(async (_cwd, args) => {
    calls.push(args);
    throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  });
  const result = await stats.commits(process.cwd(), Date.parse("2026-10-08T00:00:00Z"));
  expect(result.error).toBe("git is not installed.");
  expect(result.commits).toEqual([]);
  expect(calls[0]).toContain("--all");
  expect(calls[0]).toContain("--since=2026-10-08T00:00:00.000Z");
});
