// Focused live acceptance against the installed paseo-ultra-kanban plugin.
// Test-only SDK use; never imported by product code. Output intentionally omits credentials.
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const pluginId = "paseo-ultra-kanban";
const fixtureRoot = "/tmp/ultra-kanban-acceptance-20261013";
const repoOne = realpathSync(join(fixtureRoot, "repo-one"));
const repoTwo = realpathSync(join(fixtureRoot, "repo-two"));
const client = new DaemonClient({
  url: "ws://127.0.0.1:6767/ws",
  clientId: `phase1-acceptance-${randomUUID()}`,
  clientType: "cli",
  connectTimeoutMs: 3000,
  reconnect: { enabled: false },
});

const result = { checks: [], fixtures: {} };
const call = (method, input) => client.invokePluginRpc(pluginId, method, input);
function must(condition, message) {
  if (!condition) throw new Error(message);
}
function git(path, args) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}
async function readBoard() {
  return call("board.read", {});
}
async function readResources() {
  return call("resources.list", {});
}
async function snapshot(projectId) {
  const [board, resources] = await Promise.all([readBoard(), readResources()]);
  return {
    board,
    resources,
    cards: board.tasks.filter((task) => task.projectId === projectId).length,
    workspaces: resources.workspaces.length,
  };
}
function taskInput({ projectId, operationId, title, mode, sourcePath, workspaceId, branchName }) {
  return {
    projectId,
    operationId,
    title,
    description: "Disposable focused Phase 1 acceptance fixture.",
    status: "backlog",
    priority: "normal",
    sourcePath,
    repoPaths: [],
    mode,
    ...(workspaceId ? { workspaceId } : {}),
    ...(branchName ? { branchName } : {}),
    baseRef: "",
  };
}

try {
  await client.connect();
  const initialBoard = await readBoard();
  const mainProject = initialBoard.projects.find(
    (project) => project.title === "Ultra Kanban Acceptance 2026-10-13",
  );
  must(mainProject, "Main acceptance board project was not found.");

  // Verify the UI-edited scope/context by reading through schema-validated live RPC.
  const scopeTask = initialBoard.tasks.find(
    (task) => task.title === "Ultra Kanban Acceptance: unrestricted scope markers",
  );
  must(scopeTask, "Unrestricted marker card was not found.");
  const currentContext = await call("tasks.context", { id: scopeTask.id });
  must(
    currentContext.directories.length === 1 &&
      currentContext.directories[0].repo === repoTwo &&
      scopeTask.sourcePath === repoOne &&
      scopeTask.repoPaths.length === 1,
    "Updated repo-two scope or independent repo-one workspace source did not persist.",
  );
  result.checks.push({
    name: "edited-scope-context-and-workspace-source-separate",
    status: "passed",
    taskId: scopeTask.id,
    workspaceId: scopeTask.workspaceId,
    sourcePath: scopeTask.sourcePath,
    repoPaths: scopeTask.repoPaths,
    contextDirectories: currentContext.directories,
  });

  // Three calls with the same creation operation ID must commit one card/workspace.
  const beforeRetry = await snapshot(mainProject.id);
  const operationId = "phase1-fixed-operation-id-20261013-revised";
  const retryInput = taskInput({
    projectId: mainProject.id,
    operationId,
    title: "Ultra Kanban Acceptance: fixed operationId retry",
    mode: "directory",
    sourcePath: repoOne,
  });
  const first = await call("tasks.create", retryInput);
  const second = await call("tasks.create", retryInput);
  const third = await call("tasks.create", retryInput);
  const afterRetry = await snapshot(mainProject.id);
  must(
    first.id === second.id && second.id === third.id &&
      first.workspaceId === second.workspaceId && second.workspaceId === third.workspaceId &&
      afterRetry.cards === beforeRetry.cards + 1 &&
      afterRetry.workspaces === beforeRetry.workspaces + 1,
    "Fixed operationId retry did not produce exactly one card and workspace.",
  );
  result.checks.push({
    name: "fixed-operation-id-retry-exactly-once",
    status: "passed",
    operationId,
    cardId: first.id,
    workspaceId: first.workspaceId,
    before: { cards: beforeRetry.cards, workspaces: beforeRetry.workspaces },
    after: { cards: afterRetry.cards, workspaces: afterRetry.workspaces },
    retries: 3,
  });

  // Existing workspace identity is checked against project repo membership, not its Paseo owner.
  const outsideWorkspaceId = "wks_1b4e2fc48dd38d30";
  for (const [name, workspaceId] of [
    ["outside-repo-workspace-rejected", outsideWorkspaceId],
    ["missing-workspace-rejected", "wks_phase1_missing_acceptance_20261013"],
  ]) {
    const before = await snapshot(mainProject.id);
    let error = "";
    try {
      await call(
        "tasks.create",
        taskInput({
          projectId: mainProject.id,
          operationId: `phase1-${name}-20261013`,
          title: `Ultra Kanban Acceptance: ${name}`,
          mode: "existing",
          sourcePath: repoOne,
          workspaceId,
        }),
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const after = await snapshot(mainProject.id);
    must(error.length > 0, `${name} unexpectedly committed.`);
    must(
      before.cards === after.cards && before.workspaces === after.workspaces,
      `${name} changed card or workspace counts before validation.`,
    );
    result.checks.push({
      name,
      status: "passed",
      error,
      before: { cards: before.cards, workspaces: before.workspaces },
      after: { cards: after.cards, workspaces: after.workspaces },
    });
  }

  // A separate marked fixture board keeps the two-repo primary board untouched.
  const nonDefaultRoot = join(fixtureRoot, "repo-nondefault-base");
  const nonGitRoot = join(fixtureRoot, "non-git-source");
  mkdirSync(nonDefaultRoot, { recursive: true });
  mkdirSync(nonGitRoot, { recursive: true });
  if (!existsSync(join(nonDefaultRoot, ".git"))) {
    execFileSync("git", ["init", "--initial-branch", "acceptance/non-default-base", nonDefaultRoot]);
    writeFileSync(join(nonDefaultRoot, "README.md"), "Dedicated Phase 1 branch fixture.\n");
    execFileSync("git", [
      "-C", nonDefaultRoot, "-c", "user.name=Acceptance Fixture", "-c",
      "user.email=acceptance-fixture@example.invalid", "add", "README.md",
    ]);
    execFileSync("git", [
      "-C", nonDefaultRoot, "-c", "user.name=Acceptance Fixture", "-c",
      "user.email=acceptance-fixture@example.invalid", "commit", "-m", "Initial fixture commit",
    ]);
  }
  const canonicalNonDefaultRoot = realpathSync(nonDefaultRoot);
  const branch = git(canonicalNonDefaultRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  must(branch === "acceptance/non-default-base", `Unexpected fixture branch: ${branch}`);

  let nativeProject;
  try {
    nativeProject = JSON.parse(
      execFileSync("paseo", ["project", "create", canonicalNonDefaultRoot, "--json"], {
        encoding: "utf8",
      }),
    );
  } catch {
    const projectList = JSON.parse(
      execFileSync("paseo", ["project", "ls", "--json"], { encoding: "utf8" }),
    );
    nativeProject = projectList.find((project) => project.path === canonicalNonDefaultRoot);
  }
  must(nativeProject?.projectId, "Could not register the isolated non-default Git fixture.");

  let edgeBoard = (await readBoard()).projects.find(
    (project) => project.title === "Ultra Kanban Acceptance Branch Edges 2026-10-13",
  );
  if (!edgeBoard) {
    edgeBoard = await call("projects.create", {
      title: "Ultra Kanban Acceptance Branch Edges 2026-10-13",
      description: "Disposable isolated fixture board for branch edge checks.",
      primaryPath: canonicalNonDefaultRoot,
      repos: [canonicalNonDefaultRoot],
      paseoProjectId: nativeProject.projectId,
    });
  }
  result.fixtures.edgeBoard = { projectId: edgeBoard.id, nativeProjectId: edgeBoard.paseoProjectId, repo: canonicalNonDefaultRoot };

  // Empty Base ref on a non-default named branch must resolve that exact branch.
  const branchBefore = git(canonicalNonDefaultRoot, ["rev-parse", "HEAD"]);
  const beforeNonDefault = await snapshot(edgeBoard.id);
  const nonDefaultTask = await call(
    "tasks.create",
    taskInput({
      projectId: edgeBoard.id,
      operationId: "phase1-nondefault-base-20261013",
      title: "Ultra Kanban Acceptance: non-default named branch base",
      mode: "worktree",
      sourcePath: canonicalNonDefaultRoot,
      branchName: "acceptance/worktree-from-nondefault-20261013",
    }),
  );
  const afterNonDefault = await snapshot(edgeBoard.id);
  const workspace = afterNonDefault.resources.workspaces.find(
    (candidate) => candidate.id === nonDefaultTask.workspaceId,
  );
  must(workspace, "Non-default branch worktree was not returned by resources.list.");
  const worktreeBranch = git(workspace.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const worktreeCommit = git(workspace.path, ["rev-parse", "HEAD"]);
  must(
    worktreeBranch === "acceptance/worktree-from-nondefault-20261013" &&
      worktreeCommit === branchBefore &&
      afterNonDefault.cards === beforeNonDefault.cards + 1 &&
      afterNonDefault.workspaces === beforeNonDefault.workspaces + 1,
    "Non-default base branch selection/path/card count verification failed.",
  );
  result.checks.push({
    name: "non-default-named-branch-default-base",
    status: "passed",
    sourceBranch: branch,
    sourceRef: `refs/heads/${branch}`,
    taskId: nonDefaultTask.id,
    workspaceId: workspace.id,
    worktreePath: workspace.path,
    worktreeBranch,
    sourceCommit: branchBefore,
    worktreeCommit,
    before: { cards: beforeNonDefault.cards, workspaces: beforeNonDefault.workspaces },
    after: { cards: afterNonDefault.cards, workspaces: afterNonDefault.workspaces },
  });

  // Detached HEAD must fail before workspace/card provisioning. Restore the source branch in finally.
  const currentBranch = git(canonicalNonDefaultRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const beforeDetached = await snapshot(edgeBoard.id);
  let detachedError = "";
  try {
    execFileSync("git", ["-C", canonicalNonDefaultRoot, "switch", "--detach", "HEAD"], { stdio: "ignore" });
    try {
      await call(
        "tasks.create",
        taskInput({
          projectId: edgeBoard.id,
          operationId: "phase1-detached-head-20261013",
          title: "Ultra Kanban Acceptance: detached HEAD rejection",
          mode: "worktree",
          sourcePath: canonicalNonDefaultRoot,
          branchName: "acceptance/should-not-provision-detached-20261013",
        }),
      );
    } catch (caught) {
      detachedError = caught instanceof Error ? caught.message : String(caught);
    }
  } finally {
    execFileSync("git", ["-C", canonicalNonDefaultRoot, "switch", currentBranch], { stdio: "ignore" });
  }
  const afterDetached = await snapshot(edgeBoard.id);
  must(detachedError.includes("Cannot determine the selected repository's current named branch"), "Detached HEAD did not produce the actionable pre-provision error.");
  must(beforeDetached.cards === afterDetached.cards && beforeDetached.workspaces === afterDetached.workspaces, "Detached HEAD failure changed card/workspace counts.");
  result.checks.push({
    name: "detached-head-pre-provision-rejection",
    status: "passed",
    error: detachedError,
    before: { cards: beforeDetached.cards, workspaces: beforeDetached.workspaces },
    after: { cards: afterDetached.cards, workspaces: afterDetached.workspaces },
    restoredBranch: git(canonicalNonDefaultRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  });

  // Add a non-Git path only to the isolated edge board, exercise, then restore its repo list.
  const latestEdgeBoard = (await readBoard()).projects.find((project) => project.id === edgeBoard.id);
  const canonicalNonGitRoot = realpathSync(nonGitRoot);
  await call("projects.update", {
    id: edgeBoard.id,
    revision: latestEdgeBoard.revision,
    repos: [...latestEdgeBoard.repos, canonicalNonGitRoot],
  });
  const beforeNonGit = await snapshot(edgeBoard.id);
  let nonGitError = "";
  try {
    await call(
      "tasks.create",
      taskInput({
        projectId: edgeBoard.id,
        operationId: "phase1-non-git-20261013",
        title: "Ultra Kanban Acceptance: non-Git source rejection",
        mode: "worktree",
        sourcePath: canonicalNonGitRoot,
        branchName: "acceptance/should-not-provision-nongit-20261013",
      }),
    );
  } catch (caught) {
    nonGitError = caught instanceof Error ? caught.message : String(caught);
  }
  const afterNonGit = await snapshot(edgeBoard.id);
  const edgeBoardForRestore = afterNonGit.board.projects.find((project) => project.id === edgeBoard.id);
  await call("projects.update", {
    id: edgeBoard.id,
    revision: edgeBoardForRestore.revision,
    repos: [canonicalNonDefaultRoot],
  });
  must(nonGitError.includes("Cannot determine the selected repository's current named branch"), "Non-Git source did not produce the actionable pre-provision error.");
  must(beforeNonGit.cards === afterNonGit.cards && beforeNonGit.workspaces === afterNonGit.workspaces, "Non-Git failure changed card/workspace counts.");
  result.checks.push({
    name: "non-git-pre-provision-rejection",
    status: "passed",
    error: nonGitError,
    before: { cards: beforeNonGit.cards, workspaces: beforeNonGit.workspaces },
    after: { cards: afterNonGit.cards, workspaces: afterNonGit.workspaces },
    edgeBoardReposRestored: true,
  });

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ...result, fatalError: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close();
}
