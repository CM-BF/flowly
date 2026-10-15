import { existsSync } from 'node:fs';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';
const idsUrl = new URL('./ids.json', import.meta.url);
const fixture = JSON.parse(await readFile(idsUrl, 'utf8'));
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: 'ideas-ui-cleanup', clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client); const rpc = (method, input) => client.invokePluginRpc('paseo-ultra-kanban', method, input);
const result = { startedAt: new Date().toISOString(), fixtureIds: { project: fixture.project, task: fixture.task, worker: fixture.worker, directory: fixture.directory }, checks: {} };
try {
  await client.connect();
  let board = await rpc('board.read', {});
  const derived = board.tasks.find((task) => task.projectId === fixture.project && task.id !== fixture.task);
  result.fixtureIds.derivedTask = derived?.id ?? null;
  result.fixtureIds.derivedWorkspace = derived?.workspaceId ?? null;
  result.checks.workerOwned = Boolean(board.tasks.some((task) => task.id === fixture.task));
  if (fixture.worker) {
    await api.agents.ref(fixture.worker).archive();
    const worker = await api.agents.ref(fixture.worker).refresh();
    result.checks.workerArchived = Boolean(worker?.agent?.archivedAt || worker?.archivedAt);
  }
  board = await rpc('board.read', {});
  const project = board.projects.find((item) => item.id === fixture.project);
  if (project) {
    fixture.nativeProjectId = project.paseoProjectId;
    const removed = await rpc('projects.remove', { id: project.id, revision: project.revision, alsoPaseo: true });
    result.checks.projectRemoved = true;
    result.backupPath = removed.backup ?? null;
    if (removed.backup) { await rm(removed.backup, { force: true }); result.checks.ownedBackupRemoved = !existsSync(removed.backup); }
  }
  await rm(fixture.directory, { recursive: true, force: true });
  result.checks.tempDirectoryRemoved = !existsSync(fixture.directory);
  board = await rpc('board.read', {});
  const native = await api.projects.list();
  const resources = await rpc('resources.list', {});
  const finalAgent = await api.agents.ref(fixture.worker).refresh().catch(() => null);
  result.checks.boardProjectAbsent = !board.projects.some((item) => item.id === fixture.project);
  result.checks.boardFixtureTasksAbsent = !board.tasks.some((item) => item.id === fixture.task || item.id === derived?.id);
  result.checks.boardFixtureIdeasAbsent = !board.ideas.some((idea) => idea.taskId === fixture.task);
  result.checks.nativeProjectAbsent = !native.projects.some((item) => item.projectId === fixture.nativeProjectId);
  result.checks.fixtureWorkspacesAbsent = !resources.workspaces.some((item) => item.id === fixture.workspace || item.id === derived?.workspaceId);
  result.checks.workerStillArchived = Boolean(finalAgent?.agent?.archivedAt || finalAgent?.archivedAt);
  result.finishedAt = new Date().toISOString();
  fixture.cleanup = result.checks;
  fixture.derivedTask = result.fixtureIds.derivedTask;
  fixture.derivedWorkspace = result.fixtureIds.derivedWorkspace;
  await writeFile(idsUrl, JSON.stringify(fixture, null, 2), { mode: 0o600 });
  await writeFile(new URL('./cleanup-evidence.json', import.meta.url), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} catch (error) {
  result.error = String(error?.stack ?? error).slice(0, 1000);
  result.finishedAt = new Date().toISOString();
  await writeFile(new URL('./cleanup-evidence.json', import.meta.url), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
  process.exitCode = 1;
} finally { await api.dispose().catch(() => {}); await client.close().catch(() => {}); }
