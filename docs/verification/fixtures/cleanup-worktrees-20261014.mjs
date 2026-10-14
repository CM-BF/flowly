import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { homedir } from "node:os";

const worktreeRoot = join(homedir(), ".paseo/worktrees") + sep;
const fixtureRoots = [
  "/private/tmp/ultra-kanban-acceptance-20261013/",
  "/private/tmp/ultra-kanban-phase2-20261013/",
  "/private/tmp/ultra-kanban-single-root-20261013/",
];
const targets = [
  "14vk4zp6/single-root-fixture-root-worktree",
  "1fktzgz3/acceptance-worktree-from-nondefault-20261013",
  "2wp43niw/acceptance-external-managed-worktree-20261013",
  "2wp43niw/ultra-kanban-acceptance-repo-two",
  "2wp43niw/ultra-kanban-acceptance-repo-two-default-20261013",
  "39lz3miu/single-root-fixture-root-worktree",
  "3b64l081/single-root-fixture-root-worktree",
];
const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10000 }).trim();
const verified = targets.map((relative) => {
  const path = realpathSync(join(worktreeRoot, relative));
  if (!path.startsWith(worktreeRoot)) throw new Error(`Worktree escaped Paseo's root: ${path}`);
  const common = git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!fixtureRoots.some((root) => common.startsWith(root)) || !common.endsWith("/.git"))
    throw new Error(`Worktree has an unexpected Git source: ${path}`);
  const source = dirname(common);
  if (git(path, ["status", "--porcelain"])) throw new Error(`Worktree contains uncommitted files: ${path}`);
  if (!git(source, ["worktree", "list", "--porcelain"]).includes(`worktree ${path}`))
    throw new Error(`Source Git repository does not list worktree: ${path}`);
  return { path, source };
});
if (!process.argv.includes("--apply")) {
  console.log(JSON.stringify({ mode: "dry-run", verified }));
} else {
  const removed = [];
  for (const { path, source } of verified) {
    git(source, ["worktree", "remove", path]);
    removed.push(path);
  }
  console.log(JSON.stringify({ mode: "applied", removed }));
}
