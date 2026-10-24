import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { handoffGitDirectories, handoffGitSnapshot } from "./handoff-git";
import type { Git } from "./workpad";

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  await mkdir(".test-tmp", { recursive: true });
  const path = await mkdtemp(join(process.cwd(), ".test-tmp/handoff-git-"));
  fixtures.push(path);
  return path;
}
const sha = "a".repeat(40);
const git: Git = async (_cwd, args) => {
  if (args[0] === "--no-optional-locks") return " M notes.txt\0";
  if (args[0] === "diff") return " notes.txt | 1 +\n";
  if (args[0] === "rev-list") return "0\n";
  return args.includes("--abbrev-ref") ? "sw/fixture\n" : `${sha}\n`;
};

test("editing an already-dirty path changes the handoff fingerprint", async () => {
  const path = await fixture();
  await writeFile(join(path, "notes.txt"), "one");
  const before = await handoffGitSnapshot(path, git);
  await writeFile(join(path, "notes.txt"), "a second update to the same dirty path");
  const after = await handoffGitSnapshot(path, git);
  expect(before.sha).toBe(sha);
  expect(before.dirty).toBe(true);
  expect(after.files).toEqual(before.files);
  expect(after.dirtyHash).not.toBe(before.dirtyHash);
});

test("an unreadable status is explicitly unknown instead of reporting a clean checkout", async () => {
  const path = await fixture();
  const broken: Git = async (_cwd, args) => {
    if (args[0] === "--no-optional-locks") throw new Error("status unavailable");
    return `${sha}\n`;
  };
  const result = await handoffGitSnapshot(path, broken);
  expect(result.sha).toBe(sha);
  expect(result.error).toContain("cleanliness is unknown");
});

test("common roots discover child repositories and disclose skipped paths", async () => {
  const path = await fixture();
  for (const child of ["first", "second"]) await mkdir(join(path, child, ".git"), { recursive: true });
  const result = await handoffGitDirectories([path], 2);
  expect(result.directories).toHaveLength(2);
  expect(result.unchecked).toHaveLength(1);
  expect([...result.directories, ...result.unchecked]).toContain(join(path, "first"));
  expect([...result.directories, ...result.unchecked]).toContain(join(path, "second"));
});
