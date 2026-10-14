// Isolated live acceptance for the 2026-10-13 single-root amendment.
// Uses test-only Paseo SDK and schema-validated plugin RPC; never edits board.json.
// All created native projects/workspaces and fixture directories are retained.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access, realpath } from 'node:fs/promises';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { dirname, join, resolve } from 'node:path';

const fixtureRoot = '/tmp/ultra-kanban-single-root-20261013/run-04';
const dataFile = '/Users/bofan.wang/.paseo/plugin-data/paseo-ultra-kanban/board.json';
const evidenceFile = new URL('./single-root-run-04-evidence.json', import.meta.url);
const pluginId = 'paseo-ultra-kanban';
const session = {
  id: '2113042d-0934-454d-bf58-af71751f926c',
  provider: 'codex',
  model: 'gpt-6-luna',
  mode: 'full-access',
};
const runId = randomUUID().slice(0, 12);
const operationId = (name) => `single-root-${runId}-${name}`;
const daemon = new DaemonClient({
  url: 'ws://127.0.0.1:6767/ws',
  clientId: `single-root-acceptance-${randomUUID()}`,
  clientType: 'cli',
  appVersion: '0.11.2',
  connectTimeoutMs: 10000,
  reconnect: { enabled: false },
});
const checks = [];
const result = {
  createdAt: new Date().toISOString(),
  fixtureRoot,
  session,
  method: 'test-only Paseo DaemonClient SDK + plugin RPC',
  checks,
  resourcesRetained: true,
  daemonRestarted: false,
  ui: 'UNRUN: macOS CUA did not provide a window ID and geometry for safe targeting.',
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hashJson = (value) => sha256(JSON.stringify(value));
const call = (method, input) => daemon.invokePluginRpc(pluginId, method, input);
const record = (name, status, details = {}) => checks.push({ name, status, ...details });
const git = (path, args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
const nativeProjectFor = async (path) => {
  const response = await daemon.addProject(path);
  if (response.error || !response.project) throw new Error(response.error || 'SDK addProject returned no project.');
  if (resolve(response.project.projectRootPath) !== resolve(path)) throw new Error('SDK registered a different native project root.');
  return response.project;
};
const counts = (board, resources) => ({
  projects: board.projects.length,
  tasks: board.tasks.length,
  workspaces: resources.workspaces.length,
});
async function snapshot() {
  const [board, resources] = await Promise.all([call('board.read', {}), call('resources.list', {})]);
  return { board, resources };
}
async function createGitRepo(path, label) {
  await mkdir(path, { recursive: true });
  execFileSync('git', ['-C', path, 'init', '--initial-branch=main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Ultra Kanban Fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'config', 'user.email', 'ultra-kanban-fixture@example.invalid'], { stdio: 'ignore' });
  await writeFile(join(path, 'README.md'), `Disposable single-root fixture ${label}.\n`, { flag: 'wx', mode: 0o600 });
  execFileSync('git', ['-C', path, 'add', 'README.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'commit', '-m', 'fixture baseline'], { stdio: 'ignore' });
}
async function workspaceById(resources, id) {
  return resources.workspaces.find((workspace) => workspace.id === id);
}
function cardInput(projectId, operationId, title, mode, workspaceId) {
  return {
    projectId,
    operationId,
    title,
    description: 'Isolated single-root verification fixture.',
    status: 'todo',
    priority: 'normal',
    mode,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

try {
  try {
    await access(fixtureRoot);
    throw new Error(`Refusing to reuse existing fixture root: ${fixtureRoot}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(fixtureRoot, { recursive: false, mode: 0o700 });
  const canonicalFixtureRoot = await realpath(fixtureRoot);
  let commonRoot = join(canonicalFixtureRoot, 'common-parent');
  const childOne = join(commonRoot, 'repo-one');
  const childTwo = join(commonRoot, 'repo-two');
  const outsideRepo = join(canonicalFixtureRoot, 'outside-repo');
  await mkdir(commonRoot, { recursive: true, mode: 0o700 });
  await createGitRepo(childOne, 'child-one');
  await createGitRepo(childTwo, 'child-two');
  commonRoot = await realpath(commonRoot);
  await createGitRepo(outsideRepo, 'outside-root');

  await daemon.connect();
  const sdk = createPaseoApi(daemon);
  const before = await snapshot();
  result.before = counts(before.board, before.resources);
  result.beforeBoardSha256 = sha256(await readFile(dataFile));

  // Keep a compact read-only fingerprint for an existing legacy multi-repo record.
  const legacyProject = before.board.projects.find((project) => project.repos.length > 1);
  const legacyTask = legacyProject && before.board.tasks.find((task) => task.projectId === legacyProject.id);
  let legacyBaseline = null;
  if (legacyProject && legacyTask) {
    const [legacyContext, legacyWorkspace] = await Promise.all([
      call('tasks.context', { id: legacyTask.id }),
      workspaceById(before.resources, legacyTask.workspaceId),
    ]);
    legacyBaseline = {
      project: { id: legacyProject.id, nativeId: legacyProject.paseoProjectId, hash: hashJson(legacyProject) },
      task: { id: legacyTask.id, workspaceId: legacyTask.workspaceId, hash: hashJson(legacyTask) },
      contextHash: hashJson(legacyContext),
      workspaceOwner: legacyWorkspace?.projectId ?? null,
      scopeCount: legacyTask.repoPaths.length || legacyProject.repos.length,
    };
  }
  result.legacyBaseline = legacyBaseline;
  record('legacy-multirepo-fixture-available', legacyBaseline ? 'PASS' : 'UNRUN', {
    projectId: legacyBaseline?.project.id ?? null,
    taskId: legacyBaseline?.task.id ?? null,
    scopeCount: legacyBaseline?.scopeCount ?? null,
  });

  const nativeParent = await nativeProjectFor(commonRoot);
  result.fixtureNativeProjectId = nativeParent.projectId;
  result.fixtureRootSha256 = sha256(commonRoot);
  const projectCreateBase = {
    title: `Single-root live acceptance common parent ${runId}`,
    description: 'Isolated single-root fixture; resources are retained after verification.',
    primaryPath: commonRoot,
    paseoProjectId: nativeParent.projectId,
  };

  // Deprecated project repo lists must be schema-rejected without any mutation.
  const beforeProjectReject = await snapshot();
  let projectRejectError = '';
  try {
    await call('projects.create', { ...projectCreateBase, repos: [commonRoot, childOne, childTwo] });
  } catch (error) { projectRejectError = String(error?.message || error); }
  const afterProjectReject = await snapshot();
  const projectRejectNoMutation = JSON.stringify(counts(beforeProjectReject.board, beforeProjectReject.resources)) === JSON.stringify(counts(afterProjectReject.board, afterProjectReject.resources));
  record('deprecated-project-repos-rejected', projectRejectError && projectRejectNoMutation ? 'PASS' : 'FAIL', {
    rejected: Boolean(projectRejectError), error: projectRejectError,
    noMutation: projectRejectNoMutation,
  });

  const boardProject = await call('projects.create', projectCreateBase);
  result.boardProjectId = boardProject.id;
  const projectIsSingleRoot = boardProject.primaryPath === commonRoot &&
    boardProject.repos.length === 1 && boardProject.repos[0] === commonRoot &&
    boardProject.paseoProjectId === nativeParent.projectId;
  record('native-common-parent-project-single-root', projectIsSingleRoot ? 'PASS' : 'FAIL', {
    boardProjectId: boardProject.id,
    nativeProjectId: boardProject.paseoProjectId,
    primaryPathIsFixtureRoot: boardProject.primaryPath === commonRoot,
    repoCount: boardProject.repos.length,
    onlyRepoIsFixtureRoot: boardProject.repos.length === 1 && boardProject.repos[0] === commonRoot,
  });

  const directoryTask = await call('tasks.create', cardInput(boardProject.id, operationId('directory-card'), 'Single-root directory card', 'directory'));
  result.directoryTaskId = directoryTask.id;
  result.directoryTaskProjectId = directoryTask.projectId;
  result.directoryWorkspaceId = directoryTask.workspaceId;
  const afterDirectory = await snapshot();
  const directoryWorkspace = await workspaceById(afterDirectory.resources, directoryTask.workspaceId);
  const directoryContext = await call('tasks.context', { id: directoryTask.id });
  const childPathsAbsent = !directoryContext.context.includes(childOne) && !directoryContext.context.includes(childTwo) &&
    directoryContext.directories.every((entry) => entry.repo === commonRoot) &&
    directoryContext.workspaceRepoPaths.every((path) => path === commonRoot);
  const directoryIsSingleRoot = directoryTask.projectId === boardProject.id &&
    directoryTask.sourcePath === commonRoot &&
    directoryTask.repoPaths.length === 1 && directoryTask.repoPaths[0] === commonRoot &&
    directoryWorkspace?.projectId === nativeParent.projectId &&
    directoryWorkspace?.path === commonRoot && childPathsAbsent;
  record('new-directory-card-root-source-scope-owner-and-agent-context', directoryIsSingleRoot ? 'PASS' : 'FAIL', {
    taskId: directoryTask.id,
    workspaceId: directoryTask.workspaceId,
    projectBindingMatches: directoryTask.projectId === boardProject.id,
    sourcePathIsFixtureRoot: directoryTask.sourcePath === commonRoot,
    repoPathsCount: directoryTask.repoPaths.length,
    repoPathsOnlyFixtureRoot: directoryTask.repoPaths.length === 1 && directoryTask.repoPaths[0] === commonRoot,
    workspaceOwnerIsNativeRootProject: directoryWorkspace?.projectId === nativeParent.projectId,
    workspacePathIsFixtureRoot: directoryWorkspace?.path === commonRoot,
    contextDirectoriesAreFixtureRootOnly: childPathsAbsent,
    contextSha256: hashJson(directoryContext),
  });

  // Deprecated card source/scope fields are rejected by strict input schema.
  const beforeTaskReject = await snapshot();
  let taskRejectError = '';
  try {
    await call('tasks.create', {
      ...cardInput(boardProject.id, operationId('deprecated-card-fields'), 'Deprecated field rejection', 'directory'),
      sourcePath: childOne,
      repoPaths: [childOne, childTwo],
    });
  } catch (error) { taskRejectError = String(error?.message || error); }
  const afterTaskReject = await snapshot();
  const taskRejectNoMutation = JSON.stringify(counts(beforeTaskReject.board, beforeTaskReject.resources)) === JSON.stringify(counts(afterTaskReject.board, afterTaskReject.resources));
  record('deprecated-card-source-and-scope-rejected', taskRejectError && taskRejectNoMutation ? 'PASS' : 'FAIL', {
    rejected: Boolean(taskRejectError), error: taskRejectError,
    noMutation: taskRejectNoMutation,
  });

  // A workspace whose path is inside the common parent but whose native owner is another project
  // remains eligible; linking must not transfer its native ownership.
  const nestedOwnerRoot = join(commonRoot, 'nested-native-owner');
  const linkedWorkspacePath = join(nestedOwnerRoot, 'existing-workspace');
  await mkdir(linkedWorkspacePath, { recursive: true, mode: 0o700 });
  const nestedOwner = await nativeProjectFor(nestedOwnerRoot);
  const linkedNativeWorkspace = await sdk.workspaces.create({
    title: 'Single-root existing workspace owner-preservation fixture',
    source: { kind: 'directory', path: linkedWorkspacePath, projectId: nestedOwner.projectId },
  });
  const existingTask = await call('tasks.create', cardInput(boardProject.id, operationId('existing-workspace'), 'Link existing parent workspace', 'existing', linkedNativeWorkspace.id));
  result.existingTaskId = existingTask.id;
  result.existingTaskProjectId = existingTask.projectId;
  const afterLink = await snapshot();
  const linked = await workspaceById(afterLink.resources, linkedNativeWorkspace.id);
  const linkedContext = await call('tasks.context', { id: existingTask.id });
  const linkPass = existingTask.projectId === boardProject.id && existingTask.sourcePath === commonRoot && existingTask.repoPaths.length === 1 &&
    existingTask.repoPaths[0] === commonRoot && linked?.path === linkedWorkspacePath &&
    linked.projectId === nestedOwner.projectId && linked.projectId !== nativeParent.projectId &&
    linkedContext.directories.length === 1 && linkedContext.directories[0].repo === commonRoot;
  record('link-parent-directory-workspace-preserve-native-owner', linkPass ? 'PASS' : 'FAIL', {
    taskId: existingTask.id,
    workspaceId: existingTask.workspaceId,
    projectBindingMatches: existingTask.projectId === boardProject.id,
    sourcePathIsFixtureRoot: existingTask.sourcePath === commonRoot,
    repoPathsOnlyFixtureRoot: existingTask.repoPaths.length === 1 && existingTask.repoPaths[0] === commonRoot,
    originalNativeOwnerPreserved: linked?.projectId === nestedOwner.projectId && linked.projectId !== nativeParent.projectId,
    contextOnlyListsFixtureRoot: linkedContext.directories.length === 1 && linkedContext.directories[0].repo === commonRoot,
    contextSha256: hashJson(linkedContext),
  });

  // An actual workspace owned by a separate native project and outside the root is ineligible.
  const outsideNative = await nativeProjectFor(outsideRepo);
  const externalWorkspace = await sdk.workspaces.create({
    title: 'Single-root outside-scope rejection fixture',
    source: { kind: 'directory', path: outsideRepo, projectId: outsideNative.projectId },
  });
  const beforeExternalReject = await snapshot();
  let externalError = '';
  try {
    await call('tasks.create', cardInput(boardProject.id, operationId('outside-workspace-rejected'), 'Reject outside workspace', 'existing', externalWorkspace.id));
  } catch (error) { externalError = String(error?.message || error); }
  const afterExternalReject = await snapshot();
  const externalNoMutation = JSON.stringify(counts(beforeExternalReject.board, beforeExternalReject.resources)) === JSON.stringify(counts(afterExternalReject.board, afterExternalReject.resources));
  record('outside-root-workspace-cannot-be-card-source-or-scope', externalError && externalNoMutation ? 'PASS' : 'FAIL', {
    rejected: Boolean(externalError), error: externalError,
    noMutation: externalNoMutation,
  });

  // Child repos beneath a non-Git common parent do not make the parent a worktree source.
  const beforeNonGitWorktree = await snapshot();
  let nonGitWorktreeError = '';
  try {
    await call('tasks.create', {
      ...cardInput(boardProject.id, operationId('nongit-worktree-rejected'), 'Reject worktree from non-Git root', 'worktree'),
      branchName: 'single-root-fixture/non-git-root',
    });
  } catch (error) { nonGitWorktreeError = String(error?.message || error); }
  const afterNonGitWorktree = await snapshot();
  const nonGitNoMutation = JSON.stringify(counts(beforeNonGitWorktree.board, beforeNonGitWorktree.resources)) === JSON.stringify(counts(afterNonGitWorktree.board, afterNonGitWorktree.resources));
  record('non-git-common-root-worktree-rejected-before-provisioning', nonGitWorktreeError && nonGitNoMutation ? 'PASS' : 'FAIL', {
    rejected: Boolean(nonGitWorktreeError), error: nonGitWorktreeError,
    noMutation: nonGitNoMutation,
    childRepositoriesAreGit: true,
    nativeRootIsGit: false,
  });

  // Conversely, a native root that is itself Git can provision a worktree.
  let gitRoot = join(canonicalFixtureRoot, 'git-common-parent');
  await mkdir(gitRoot, { recursive: true, mode: 0o700 });
  await createGitRepo(join(gitRoot, 'repo-one'), 'git-parent-child-one');
  await createGitRepo(join(gitRoot, 'repo-two'), 'git-parent-child-two');
  await writeFile(join(gitRoot, 'ROOT.md'), 'The native project root is the Git repository.\n', { flag: 'wx', mode: 0o600 });
  execFileSync('git', ['-C', gitRoot, 'init', '--initial-branch=main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', gitRoot, 'config', 'user.name', 'Ultra Kanban Fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', gitRoot, 'config', 'user.email', 'ultra-kanban-fixture@example.invalid'], { stdio: 'ignore' });
  execFileSync('git', ['-C', gitRoot, 'add', 'ROOT.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', gitRoot, 'commit', '-m', 'native root baseline'], { stdio: 'ignore' });
  gitRoot = await realpath(gitRoot);
  const nativeGitRoot = await nativeProjectFor(gitRoot);
  const gitBoardProject = await call('projects.create', {
    title: `Single-root live acceptance Git root ${runId}`,
    description: 'Isolated Git-root worktree fixture; resources are retained.',
    primaryPath: gitRoot,
    paseoProjectId: nativeGitRoot.projectId,
  });
  result.gitBoardProjectId = gitBoardProject.id;
  const gitTask = await call('tasks.create', {
    ...cardInput(gitBoardProject.id, operationId('git-root-worktree'), 'Worktree from Git native root', 'worktree'),
    branchName: 'single-root-fixture/root-worktree',
  });
  result.gitTaskId = gitTask.id;
  result.gitTaskProjectId = gitTask.projectId;
  const afterGitWorktree = await snapshot();
  const gitWorkspace = await workspaceById(afterGitWorktree.resources, gitTask.workspaceId);
  const gitContext = await call('tasks.context', { id: gitTask.id });
  const gitRootPass = gitTask.projectId === gitBoardProject.id && gitTask.sourcePath === gitRoot && gitTask.repoPaths.length === 1 &&
    gitTask.repoPaths[0] === gitRoot && gitWorkspace?.projectId === nativeGitRoot.projectId &&
    gitWorkspace?.path !== gitRoot && gitWorkspace?.repoPaths.includes(gitRoot) &&
    gitContext.directories.length === 1 && gitContext.directories[0].repo === gitRoot;
  record('git-native-root-worktree-uses-only-root', gitRootPass ? 'PASS' : 'FAIL', {
    taskId: gitTask.id,
    workspaceId: gitTask.workspaceId,
    projectBindingMatches: gitTask.projectId === gitBoardProject.id,
    sourcePathIsFixtureRoot: gitTask.sourcePath === gitRoot,
    repoPathsOnlyFixtureRoot: gitTask.repoPaths.length === 1 && gitTask.repoPaths[0] === gitRoot,
    workspaceOwnerIsNativeRootProject: gitWorkspace?.projectId === nativeGitRoot.projectId,
    workspaceIsSeparateWorktree: Boolean(gitWorkspace?.path && gitWorkspace.path !== gitRoot),
    contextOnlyListsFixtureRoot: gitContext.directories.length === 1 && gitContext.directories[0].repo === gitRoot,
    contextSha256: hashJson(gitContext),
  });

  // Existing project and card edit RPCs cannot alter the root or legacy scope.
  const beforeEditReject = await snapshot();
  let projectEditError = '';
  try {
    await call('projects.update', { id: boardProject.id, revision: boardProject.revision, repos: [commonRoot, childOne] });
  } catch (error) { projectEditError = String(error?.message || error); }
  const afterEditReject = await snapshot();
  const editRejectPass = Boolean(projectEditError) &&
    afterEditReject.board.projects.find((p) => p.id === boardProject.id)?.primaryPath === commonRoot &&
    afterEditReject.board.projects.find((p) => p.id === boardProject.id)?.repos.length === 1 &&
    afterEditReject.board.projects.find((p) => p.id === boardProject.id)?.repos[0] === commonRoot &&
    afterEditReject.board.tasks.find((t) => t.id === existingTask.id)?.workspaceId === existingTask.workspaceId;
  record('project-edit-cannot-add-secondary-repo-or-change-root', editRejectPass ? 'PASS' : 'FAIL', {
    rejected: Boolean(projectEditError), error: projectEditError,
    rootAndWorkspaceUnchanged: editRejectPass,
  });

  // Capture all values needed for the after-reload equality check without recording user paths.
  const beforeReload = await snapshot();
  const boardHashBeforeReload = sha256(await readFile(dataFile));
  result.boardSha256BeforeReload = boardHashBeforeReload;
  result.boardRevisionBeforeReload = beforeReload.board.revision;
  const fixtureProjectIds = [boardProject.id, gitBoardProject.id];
  const fixtureTaskIds = [directoryTask.id, existingTask.id, gitTask.id];
  const beforeReloadBoardViewHash = hashJson(beforeReload.board);
  let legacyReloadBaseline = null;
  if (legacyBaseline) {
    const project = beforeReload.board.projects.find((p) => p.id === legacyBaseline.project.id);
    const task = beforeReload.board.tasks.find((t) => t.id === legacyBaseline.task.id);
    const context = await call('tasks.context', { id: legacyBaseline.task.id });
    const workspace = await workspaceById(beforeReload.resources, legacyBaseline.task.workspaceId);
    legacyReloadBaseline = {
      projectHash: project ? hashJson(project) : null,
      taskHash: task ? hashJson(task) : null,
      contextHash: hashJson(context),
      workspaceOwner: workspace?.projectId ?? null,
    };
  }
  result.legacyReloadBaseline = legacyReloadBaseline;

  const reloadOutput = execFileSync('paseo', ['plugin', 'reload', pluginId], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  result.reloadCommand = 'paseo plugin reload paseo-ultra-kanban';
  result.reloadOutputSha256 = sha256(reloadOutput);
  let afterReload;
  let reloadReadError = '';
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      afterReload = await snapshot();
      break;
    } catch (error) {
      reloadReadError = String(error?.message || error);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    }
  }
  if (!afterReload) throw new Error(`Plugin did not serve RPC after reload: ${reloadReadError}`);
  const boardHashAfterReload = sha256(await readFile(dataFile));
  result.boardSha256AfterReload = boardHashAfterReload;
  result.boardRevisionAfterReload = afterReload.board.revision;
  result.afterReload = counts(afterReload.board, afterReload.resources);
  const boardBytesPass = boardHashBeforeReload === boardHashAfterReload;
  const boardViewPass = beforeReloadBoardViewHash === hashJson(afterReload.board);
  record('plugin-reload-board-bytes-and-read-view-unchanged', boardBytesPass && boardViewPass ? 'PASS' : 'FAIL', {
    bytesUnchanged: boardBytesPass,
    boardReadUnchanged: boardViewPass,
    beforeSha256: boardHashBeforeReload,
    afterSha256: boardHashAfterReload,
  });

  const afterReloadTaskById = new Map(afterReload.board.tasks.map((task) => [task.id, task]));
  const fixtureCardsPersisted = fixtureTaskIds.every((id) => afterReloadTaskById.has(id));
  const fixtureProjectsPersisted = fixtureProjectIds.every((id) => afterReload.board.projects.some((project) => project.id === id));
  record('fixture-project-card-persistence-after-reload', fixtureCardsPersisted && fixtureProjectsPersisted ? 'PASS' : 'FAIL', {
    projectsPersisted: fixtureProjectsPersisted,
    cardsPersisted: fixtureCardsPersisted,
  });

  if (legacyBaseline && legacyReloadBaseline) {
    const legacyProjectAfter = afterReload.board.projects.find((p) => p.id === legacyBaseline.project.id);
    const legacyTaskAfter = afterReload.board.tasks.find((t) => t.id === legacyBaseline.task.id);
    const legacyContextAfter = await call('tasks.context', { id: legacyBaseline.task.id });
    const legacyWorkspaceAfter = await workspaceById(afterReload.resources, legacyBaseline.task.workspaceId);
    const legacyPass = Boolean(legacyProjectAfter && legacyTaskAfter && legacyWorkspaceAfter) &&
      hashJson(legacyProjectAfter) === legacyReloadBaseline.projectHash &&
      hashJson(legacyTaskAfter) === legacyReloadBaseline.taskHash &&
      hashJson(legacyContextAfter) === legacyReloadBaseline.contextHash &&
      legacyWorkspaceAfter.projectId === legacyReloadBaseline.workspaceOwner;
    record('legacy-multirepo-card-context-and-native-owner-preserved-after-reload', legacyPass ? 'PASS' : 'FAIL', {
      projectId: legacyBaseline.project.id,
      taskId: legacyBaseline.task.id,
      projectUnchanged: hashJson(legacyProjectAfter) === legacyReloadBaseline.projectHash,
      cardUnchanged: hashJson(legacyTaskAfter) === legacyReloadBaseline.taskHash,
      contextUnchanged: hashJson(legacyContextAfter) === legacyReloadBaseline.contextHash,
      nativeOwnerUnchanged: legacyWorkspaceAfter?.projectId === legacyReloadBaseline.workspaceOwner,
      scopeCount: legacyBaseline.scopeCount,
    });
  }

  result.completedAt = new Date().toISOString();
} catch (error) {
  result.error = String(error?.stack || error);
  result.completedAt = new Date().toISOString();
} finally {
  const unrecorded = [
    'native-common-parent-project-single-root',
    'new-directory-card-root-source-scope-owner-and-agent-context',
    'deprecated-project-repos-rejected',
    'deprecated-card-source-and-scope-rejected',
    'link-parent-directory-workspace-preserve-native-owner',
    'outside-root-workspace-cannot-be-card-source-or-scope',
    'non-git-common-root-worktree-rejected-before-provisioning',
    'git-native-root-worktree-uses-only-root',
    'project-edit-cannot-add-secondary-repo-or-change-root',
    'plugin-reload-board-bytes-and-read-view-unchanged',
    'fixture-project-card-persistence-after-reload',
    'legacy-multirepo-card-context-and-native-owner-preserved-after-reload',
  ];
  for (const name of unrecorded) if (!checks.some((check) => check.name === name)) record(name, 'UNRUN');
  try {
    await mkdir(dirname(new URL(evidenceFile).pathname), { recursive: true });
    await writeFile(evidenceFile, JSON.stringify(result, null, 2), { mode: 0o600 });
  } catch (writeError) {
    process.stderr.write(`Could not write sanitized evidence: ${String(writeError?.message || writeError)}\n`);
  }
  await daemon.close().catch(() => {});
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
