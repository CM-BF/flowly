import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const root = '/tmp/ultra-kanban-phase2-20261013/live-acceptance-01';
const fixture = JSON.parse(await readFile(`${root}/fixture-index.json`, 'utf8'));
const existingCli = JSON.parse(await readFile(`${root}/existing-cli-session.json`, 'utf8'));
const repoThree = join(root, 'repo-three');
const worktreePath = join(root, 'repo-two-external-worktree');
const evidencePath = new URL('./evidence/scope-revision-worktree.json', import.meta.url).pathname;
const markerPath = join(root, 'scope-revision-worktree-marker.json');
try { await access(markerPath); throw new Error('Refusing duplicate scope/worktree fixture mutation.'); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
await writeFile(markerPath, JSON.stringify({ startedAt: new Date().toISOString(), purpose: 'scope, project revision, external worktree' }), { mode: 0o600, flag: 'wx' });
await mkdir(repoThree, { recursive: true });
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `phase2-scope-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const call = (method, input) => client.invokePluginRpc('paseo-ultra-kanban', method, input);
const evidence = { fixtureRoot: root, projectId: fixture.project.id, initialProjectRevision: fixture.project.revision, checks: {}, createdResources: {}, staleWrite: null, error: null };
try {
  await client.connect();
  const before = await call('board.read', {});
  const project = before.projects.find(p => p.id === fixture.project.id);
  const added = await call('projects.update', { id: project.id, revision: project.revision, repos: [...project.repos, repoThree] });
  const defaultAfterAdd = await call('tasks.context', { id: fixture.task.id });
  evidence.checks.defaultAllReposAfterAdd = { projectRevision: added.revision, paths: defaultAfterAdd.directories.map(d => d.repo), includesRepoThree: defaultAfterAdd.directories.some(d => d.repo.endsWith('/repo-three')) };

  const multi = await call('tasks.create', {
    projectId: project.id,
    operationId: 'phase2-live-multirepo-card-v1',
    title: 'Phase 2 acceptance: multi-repo scope',
    description: 'Explicitly scoped to both fixture repos.',
    status: 'todo', priority: 'normal', sourcePath: fixture.repos[0], repoPaths: fixture.repos, mode: 'directory',
  });
  const multiContext = await call('tasks.context', { id: multi.id });
  evidence.checks.multiRepo = { taskId: multi.id, sourcePath: multi.sourcePath, repoPaths: multi.repoPaths, directories: multiContext.directories, passes: multi.repoPaths.length === 2 && multiContext.directories.length === 2 };

  execFileSync('/Users/bofan.wang/.local/bin/paseo', ['project', 'create', root, '--json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const nativeProjects = await api.projects.list();
  const externalOwner = nativeProjects.projects.find(p => p.projectRootPath === root || p.projectRootPath === `/private${root}`);
  if (!externalOwner) throw new Error('Could not find the separate native project for the external-worktree fixture.');
  execFileSync('git', ['-C', fixture.repos[1], 'worktree', 'add', '-b', 'phase2-external-worktree', worktreePath, 'main'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const externalWorkspace = await api.workspaces.create({
    title: 'Phase 2 acceptance external worktree (other native owner)',
    idempotencyKey: 'phase2-live-external-worktree-workspace-v1',
    source: { kind: 'directory', path: worktreePath, projectId: externalOwner.projectId },
  });
  const externalDescriptor = await externalWorkspace.refresh();
  const externalTask = await call('tasks.create', {
    projectId: project.id,
    operationId: 'phase2-live-external-worktree-card-v1',
    title: 'Phase 2 acceptance: external worktree and native owner',
    description: 'Link a worktree workspace owned by a different native Paseo project.',
    status: 'todo', priority: 'normal', repoPaths: [fixture.repos[1]], mode: 'existing', workspaceId: externalWorkspace.id,
  });
  const externalContext = await call('tasks.context', { id: externalTask.id });
  evidence.checks.externalWorktreeOwner = {
    taskId: externalTask.id,
    workspaceId: externalWorkspace.id,
    boardNativeProjectId: project.paseoProjectId,
    workspaceNativeProjectId: externalDescriptor?.projectId,
    workspaceDirectory: externalDescriptor?.workspaceDirectory,
    sourcePath: externalTask.sourcePath,
    scope: externalContext.directories,
    workspaceRepoPaths: externalContext.workspaceRepoPaths,
    ownerUnchanged: externalDescriptor?.projectId === externalOwner.projectId && externalDescriptor?.projectId !== project.paseoProjectId,
    worktreeMapsToRepoTwo: externalContext.workspaceRepoPaths.some(p => realpathSync(p) === realpathSync(fixture.repos[1])) && externalContext.directories.some(d => realpathSync(d.repo) === realpathSync(fixture.repos[1]) && realpathSync(d.directory) === realpathSync(worktreePath)),
  };
  evidence.createdResources.externalNativeProjectId = externalOwner.projectId;

  const cliTaskId = existingCli.taskId, cliAgentId = existingCli.agentId;
  const cliTaskContext = await call('tasks.context', { id: cliTaskId });
  evidence.checks.singleRepo = { taskId: cliTaskId, repoPaths: cliTaskContext.directories.map(d => d.repo), path: cliTaskContext.directories[0]?.directory, passes: cliTaskContext.directories.length === 1 && realpathSync(cliTaskContext.directories[0]?.repo) === realpathSync(fixture.repos[1]) };
  const staleSnapshot = join(root, 'private-requests', `${cliAgentId}-stale-project-revision.json`);
  await mkdir(join(root, 'private-requests'), { recursive: true, mode: 0o700 });
  const currentOutput = execFileSync(process.execPath, [existingCli.preparation.cliPath, '--context-file', existingCli.preparation.contextFile, 'current', '--save-request', staleSnapshot], { encoding: 'utf8', env: { ...process.env, PASEO_AGENT_ID: cliAgentId }, maxBuffer: 1024 * 1024 });
  const staleContext = JSON.parse(currentOutput);
  evidence.staleWrite = { beforeRevision: staleContext.revision, expectedCode: 'REVISION_CONFLICT', actualCode: null, exitCode: null, message: null };
  const latestProject = await call('board.read', {});
  const projectBeforeRemoval = latestProject.projects.find(p => p.id === project.id);
  const removed = await call('projects.update', { id: project.id, revision: projectBeforeRemoval.revision, repos: [fixture.repos[0], fixture.repos[1]] });
  evidence.staleWrite.projectRevisionAfterRemoval = removed.revision;
  try {
    execFileSync(process.execPath, [existingCli.preparation.cliPath, '--context-file', existingCli.preparation.contextFile, 'status', 'in_progress', '--request-file', staleSnapshot, '--note', 'This stale project revision must be rejected.'], { encoding: 'utf8', env: { ...process.env, PASEO_AGENT_ID: cliAgentId }, maxBuffer: 1024 * 1024 });
    evidence.staleWrite.exitCode = 0;
  } catch (error) {
    evidence.staleWrite.exitCode = error.status ?? 1;
    const stderr = String(error.stderr ?? '').trim();
    try { const parsed = JSON.parse(stderr); evidence.staleWrite.actualCode = parsed.code; evidence.staleWrite.message = parsed.message; }
    catch { evidence.staleWrite.message = stderr.slice(0, 300); }
  }
  await unlink(staleSnapshot).catch(() => {});
  const defaultAfterRemove = await call('tasks.context', { id: fixture.task.id });
  const boardAfter = await call('board.read', {});
  const finalCliTask = boardAfter.tasks.find(t => t.id === cliTaskId);
  evidence.checks.defaultAllReposAfterRemove = { projectRevision: removed.revision, paths: defaultAfterRemove.directories.map(d => d.repo), repoThreeAbsent: !defaultAfterRemove.directories.some(d => d.repo.endsWith('/repo-three')) };
  evidence.staleWrite.cardUnchangedAfterConflict = finalCliTask?.status === 'in_review' && finalCliTask?.revision === staleContext.revision.task;
  evidence.createdResources = { repoThree, multiTaskId: multi.id, externalWorktreePath: worktreePath, externalWorkspaceId: externalWorkspace.id, externalTaskId: externalTask.id };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
} catch (error) {
  evidence.error = String(error?.stack ?? error);
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
} finally {
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
}
