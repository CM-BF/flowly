// Focused live Phase 1 project repo edit-guard check. Test-only internal RPC.
// Uses only the marked acceptance board and a disposable dummy Git directory.
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";

const pluginId = "paseo-ultra-kanban";
const fixtureRoot = "/private/tmp/ultra-kanban-acceptance-20261013";
const dummyRepo = `${fixtureRoot}/repo-edit-guard-dummy-20261013`;
const client = new DaemonClient({
  url: "ws://127.0.0.1:6767/ws",
  clientId: `phase1-repo-guard-${randomUUID()}`,
  clientType: "cli",
  connectTimeoutMs: 3000,
  reconnect: { enabled: false },
});
const invoke = (method, input) => client.invokePluginRpc(pluginId, method, input);
const must = (condition, message) => {
  if (!condition) throw new Error(message);
};
const boardRead = () => invoke("board.read", {});
const resourceRead = () => invoke("resources.list", {});

async function getProject() {
  const board = await boardRead();
  const project = board.projects.find(
    (item) => item.title === "Ultra Kanban Acceptance 2026-10-13",
  );
  must(project, "Marked two-repository acceptance project not found.");
  return { board, project };
}

async function stateSnapshot(projectId) {
  const [board, resources] = await Promise.all([boardRead(), resourceRead()]);
  const tasks = board.tasks
    .filter((task) => task.projectId === projectId)
    .map(({ id, workspaceId, sourcePath, repoPaths, revision, archivedAt }) =>
      ({ id, workspaceId, sourcePath, repoPaths, revision, archivedAt }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const taskWorkspaceIds = new Set(tasks.map((task) => task.workspaceId));
  const workspaces = resources.workspaces
    .filter((workspace) => taskWorkspaceIds.has(workspace.id))
    .map(({ id, projectId: owner, path, status, repoPaths }) =>
      ({ id, owner, path, status, repoPaths }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const project = board.projects.find((item) => item.id === projectId);
  return {
    project: { id: project.id, revision: project.revision, repos: project.repos },
    tasks,
    workspaces,
  };
}

const result = { checks: [], fixture: { dummyRepo } };
let clientConnected = false;
let dummyCanonical;

try {
  await client.connect();
  clientConnected = true;
  mkdirSync(dummyRepo, { recursive: true });
  if (!existsSync(`${dummyRepo}/.git`)) {
    execFileSync("git", ["init", "--initial-branch", "acceptance/repo-edit-guard", dummyRepo]);
  }
  dummyCanonical = realpathSync(dummyRepo);

  const { project: initialProject } = await getProject();
  must(initialProject.repos.length === 2, "Acceptance board no longer has its original two repos.");
  const repoOne = initialProject.primaryPath;
  const repoTwo = initialProject.repos.find((repo) => repo !== repoOne);
  must(repoTwo, "Secondary fixture repo was not found.");

  // Removing repo-two must fail because cards use it as source and explicit scope.
  const beforeGuard = await stateSnapshot(initialProject.id);
  let guardError = "";
  try {
    await invoke("projects.update", {
      id: initialProject.id,
      revision: initialProject.revision,
      repos: [repoOne],
    });
  } catch (error) {
    guardError = error instanceof Error ? error.message : String(error);
  }
  const afterGuard = await stateSnapshot(initialProject.id);
  must(
    guardError.includes("A primary, workspace source or explicitly scoped directory cannot be removed."),
    `Expected source/scope edit guard, got: ${guardError || "no error"}`,
  );
  must(
    JSON.stringify(beforeGuard) === JSON.stringify(afterGuard),
    "Rejected repo removal changed project, card, or workspace state.",
  );
  result.checks.push({
    name: "reject-remove-secondary-source-and-explicit-scope-repo",
    status: "passed",
    attemptedRepos: [repoOne],
    error: guardError,
    before: beforeGuard,
    after: afterGuard,
  });

  // Add then remove only an unused dummy repo. Unrestricted tasks should follow it.
  const beforeDummy = await stateSnapshot(initialProject.id);
  const currentContextTask = (await boardRead()).tasks.find(
    (task) => task.projectId === initialProject.id && task.repoPaths.length === 0,
  );
  must(currentContextTask, "No unrestricted acceptance card exists for the dynamic repo test.");

  const latestBeforeAdd = (await getProject()).project;
  await invoke("projects.update", {
    id: latestBeforeAdd.id,
    revision: latestBeforeAdd.revision,
    repos: [...latestBeforeAdd.repos, dummyCanonical],
  });
  const afterAdd = await stateSnapshot(initialProject.id);
  const contextAfterAdd = await invoke("tasks.context", { id: currentContextTask.id });
  must(
    contextAfterAdd.directories.some((entry) => entry.repo === dummyCanonical),
    "Unrestricted task context did not include the newly added project repo.",
  );

  const latestBeforeRemove = (await getProject()).project;
  await invoke("projects.update", {
    id: latestBeforeRemove.id,
    revision: latestBeforeRemove.revision,
    repos: latestBeforeRemove.repos.filter((repo) => repo !== dummyCanonical),
  });
  const afterRemove = await stateSnapshot(initialProject.id);
  const contextAfterRemove = await invoke("tasks.context", { id: currentContextTask.id });
  must(
    !contextAfterRemove.directories.some((entry) => entry.repo === dummyCanonical),
    "Unrestricted task context retained the removed dummy repo.",
  );
  must(
    afterRemove.project.repos.join("\n") === beforeDummy.project.repos.join("\n") &&
      JSON.stringify(afterRemove.tasks) === JSON.stringify(beforeDummy.tasks) &&
      JSON.stringify(afterRemove.workspaces) === JSON.stringify(beforeDummy.workspaces),
    "Dummy repo add/remove changed card/workspace bindings or failed to restore repo list.",
  );
  result.checks.push({
    name: "unrestricted-scope-follows-project-repo-list",
    status: "passed",
    taskId: currentContextTask.id,
    dummyRepo: dummyCanonical,
    contextReposAfterAdd: contextAfterAdd.directories.map((entry) => entry.repo),
    contextReposAfterRemove: contextAfterRemove.directories.map((entry) => entry.repo),
    before: beforeDummy,
    during: afterAdd,
    after: afterRemove,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // If interrupted after adding the dummy repo, restore only that added path.
  if (clientConnected && dummyCanonical) {
    try {
      const { project } = await getProject();
      if (project.repos.includes(dummyCanonical)) {
        await invoke("projects.update", {
          id: project.id,
          revision: project.revision,
          repos: project.repos.filter((repo) => repo !== dummyCanonical),
        });
      }
    } catch (restoreError) {
      result.restoreError = restoreError instanceof Error ? restoreError.message : String(restoreError);
    }
  }
  console.log(JSON.stringify({ ...result, fatalError: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (clientConnected) await client.close();
}
