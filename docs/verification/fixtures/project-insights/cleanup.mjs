import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';

const dir = new URL('./', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('./ids.json', import.meta.url), 'utf8'));
const dataDir = join(process.env.HOME, '.paseo/plugin-data/paseo-ultra-kanban');
const removedDir = join(dataDir, 'removed');
const flowPath = join(dataDir, 'flow', `${fixture.project.id}.jsonl`);
const flowEvidencePath = new URL('./flow-before-removal.jsonl', dir);
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `project-insights-cleanup-${fixture.project.id}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const rpc = (method, input) => client.invokePluginRpc('paseo-ultra-kanban', method, input);
const evidence = { startedAt: new Date().toISOString(), fixtureIds: { project: fixture.project.id, nativeProject: fixture.nativeProjectId, testSession: fixture.testSessionId, cards: fixture.cards.map((x) => x.id), workspaces: fixture.cards.map((x) => x.workspaceId), directory: fixture.directory }, checks: {}, errors: [] };
const agentsBefore = execFileSync('paseo', ['agent', 'ls', '--json', '--all', '--global'], { encoding: 'utf8' });
const agentListBefore = JSON.parse(agentsBefore);
const digestSessionIds = ['2e5ceaac-b43f-4bd2-9d85-442d5e1694ae', '9c98cba1-7c79-4006-85b8-242600e1d26d'];
const agentDir = join(process.env.HOME, '.paseo', 'agents', 'private-var-folders-0b-f1crzdg95g5fwbq49s_3pw9c0000gq-T-paseo-project-insights-FauNA8');
evidence.digestSessions = await Promise.all(digestSessionIds.map(async (id) => {
  const listed = agentListBefore.find((x) => x.id === id);
  const record = JSON.parse(await readFile(join(agentDir, `${id}.json`), 'utf8'));
  return { id, name: listed?.name, status: listed?.status, archived: listed?.status === 'closed', labels: record.labels };
}));

try {
  await client.connect();
  const beforeBoard = await rpc('board.read', {});
  const beforeProject = beforeBoard.projects.find((p) => p.id === fixture.project.id);
  evidence.checks.fixtureOwnedBeforeRemoval = Boolean(beforeProject && beforeProject.primaryPath === fixture.project.primaryPath);
  const flowText = await readFile(flowPath, 'utf8');
  await writeFile(flowEvidencePath, flowText, { mode: 0o600 });
  const flowEvents = flowText.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  evidence.flow = { sourcePath: flowPath, lineCount: flowEvents.length, eventActions: flowEvents.reduce((o, e) => ((o[e.action] = (o[e.action] || 0) + 1), o), {}), fixtureTaskIds: [...new Set(flowEvents.map((e) => e.taskId))], copiedEvidence: 'flow-before-removal.jsonl' };
  evidence.checks.flowContainsEveryFixtureCard = fixture.cards.every((c) => flowEvents.some((e) => e.taskId === c.id));
  evidence.checks.flowContainsTransitions = flowEvents.some((e) => e.action === 'status_changed' && e.from === 'todo' && e.to === 'development') && flowEvents.some((e) => e.action === 'status_changed' && e.to === 'done');

  if (fixture.testSessionId) {
    await api.agents.ref(fixture.testSessionId).archive();
    const archived = await api.agents.ref(fixture.testSessionId).refresh();
    evidence.checks.testSessionArchived = Boolean(archived?.agent?.archivedAt || archived?.archivedAt);
  }

  await mkdir(removedDir, { recursive: true });
  const beforeRemoved = new Set(await readdir(removedDir));
  const removed = await rpc('projects.remove', { id: beforeProject.id, revision: beforeProject.revision, alsoPaseo: true });
  evidence.removeResult = removed;
  const afterRemoved = await readdir(removedDir);
  const ownedFiles = afterRemoved.filter((name) => !beforeRemoved.has(name) && name.includes(fixture.project.id));
  evidence.checks.flowMovedToRemoved = !existsSync(flowPath) && ownedFiles.some((name) => name.includes('-flow-'));
  evidence.removedArtifacts = ownedFiles.map((name) => join(removedDir, name));

  await rm(fixture.directory, { recursive: true, force: true });
  evidence.checks.tempDirectoryRemoved = !existsSync(fixture.directory);
  for (const file of evidence.removedArtifacts) await rm(file, { recursive: true, force: true });
  if (removed.backup) await rm(removed.backup, { force: true });
  evidence.checks.ownedRemovedBackupsDeleted = evidence.removedArtifacts.every((file) => !existsSync(file)) && (!removed.backup || !existsSync(removed.backup));

  const boardAfter = await rpc('board.read', {});
  const resourcesAfter = await rpc('resources.list', {});
  const nativeAfter = await api.projects.list();
  const testSessionAfter = await api.agents.ref(fixture.testSessionId).refresh().catch(() => null);
  evidence.checks.boardProjectAbsent = !boardAfter.projects.some((p) => p.id === fixture.project.id);
  evidence.checks.boardCardsAbsent = !boardAfter.tasks.some((t) => fixture.cards.some((c) => c.id === t.id));
  evidence.checks.nativeProjectAbsent = !nativeAfter.projects.some((p) => p.projectId === fixture.nativeProjectId);
  evidence.checks.fixtureWorkspacesAbsent = !resourcesAfter.workspaces.some((w) => fixture.cards.some((c) => c.workspaceId === w.id));
  evidence.checks.testSessionArchivedAfterRemoval = Boolean(testSessionAfter?.agent?.archivedAt || testSessionAfter?.archivedAt);
  evidence.checks.flowBackupDeleted = !evidence.removedArtifacts.some((f) => f.includes('-flow-') && existsSync(f));
} catch (error) {
  evidence.errors.push(String(error?.stack ?? error).slice(0, 1800));
} finally {
  evidence.finishedAt = new Date().toISOString();
  await writeFile(new URL('./cleanup-evidence.json', dir), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  fixture.cleanupEvidence = 'cleanup-evidence.json';
  await writeFile(new URL('./ids.json', dir), JSON.stringify(fixture, null, 2), { mode: 0o600 });
  await api.dispose().catch(() => {}); await client.close().catch(() => {});
  console.log(JSON.stringify({ checks: evidence.checks, flow: evidence.flow, digestSession: evidence.digestSession, errors: evidence.errors }, null, 2));
}
