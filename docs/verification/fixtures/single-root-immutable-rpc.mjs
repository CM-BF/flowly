// Focused read-only-on-failure check for immutable native project binding/root.
// The only attempted writes are rejected schema-validated plugin RPC requests.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const evidenceFile = new URL('./single-root-run-04-immutable-evidence.json', import.meta.url);
const fixtureRun = '/tmp/ultra-kanban-single-root-20261013/run-04';
const runEvidence = JSON.parse(await readFile(new URL('./single-root-run-04-evidence.json', import.meta.url), 'utf8'));
const client = new DaemonClient({
  url: 'ws://127.0.0.1:6767/ws',
  clientId: `single-root-immutability-${randomUUID()}`,
  clientType: 'cli',
  appVersion: '0.11.2',
  connectTimeoutMs: 10000,
  reconnect: { enabled: false },
});
const result = {
  createdAt: new Date().toISOString(),
  sessionId: runEvidence.session.id,
  provider: `${runEvidence.session.provider}/${runEvidence.session.model}`,
  mode: runEvidence.session.mode,
  fixtureRun,
  checks: [],
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const call = (method, input) => client.invokePluginRpc('paseo-ultra-kanban', method, input);

try {
  await client.connect();
  const before = await call('board.read', {});
  const project = before.projects.find((entry) => entry.id === runEvidence.boardProjectId);
  if (!project) throw new Error('The isolated single-root project no longer exists.');
  const projectBindingChecks = [
    ['directory', runEvidence.directoryTaskId, runEvidence.boardProjectId],
    ['existing-workspace', runEvidence.existingTaskId, runEvidence.boardProjectId],
    ['git-worktree', runEvidence.gitTaskId, runEvidence.gitBoardProjectId],
  ].map(([kind, taskId, expectedProjectId]) => {
    const task = before.tasks.find((entry) => entry.id === taskId);
    return { kind, taskExists: Boolean(task), projectIdMatches: task?.projectId === expectedProjectId };
  });
  result.checks.push({
    field: 'returned-task-projectId',
    rejected: false,
    projectBindingChecks,
    pass: projectBindingChecks.every((check) => check.taskExists && check.projectIdMatches),
  });
  const beforeHash = hash(await readFile('/Users/bofan.wang/.paseo/plugin-data/paseo-ultra-kanban/board.json'));
  const attempts = [
    ['primaryPath', { primaryPath: join(project.primaryPath, 'repo-one') }],
    ['paseoProjectId', { paseoProjectId: 'single-root-rebind-must-be-rejected' }],
  ];
  for (const [field, extra] of attempts) {
    let error = '';
    try {
      await call('projects.update', { id: project.id, revision: project.revision, ...extra });
    } catch (caught) {
      error = String(caught?.message || caught);
    }
    result.checks.push({ field, rejected: Boolean(error), error });
  }
  const after = await call('board.read', {});
  const afterProject = after.projects.find((entry) => entry.id === project.id);
  const afterHash = hash(await readFile('/Users/bofan.wang/.paseo/plugin-data/paseo-ultra-kanban/board.json'));
  const unchanged = hash(JSON.stringify(before)) === hash(JSON.stringify(after)) &&
    project.primaryPath === afterProject?.primaryPath &&
    project.paseoProjectId === afterProject?.paseoProjectId &&
    beforeHash === afterHash;
  result.status = result.checks.every((check) => check.field === 'returned-task-projectId'
    ? check.pass
    : check.rejected) && unchanged ? 'PASS' : 'FAIL';
  result.boardProjectId = project.id;
  result.rootUnchanged = project.primaryPath === afterProject?.primaryPath;
  result.nativeBindingUnchanged = project.paseoProjectId === afterProject?.paseoProjectId;
  result.boardReadUnchanged = hash(JSON.stringify(before)) === hash(JSON.stringify(after));
  result.boardBytesUnchanged = beforeHash === afterHash;
  result.boardSha256 = afterHash;
} catch (error) {
  result.status = 'FAIL';
  result.error = String(error?.stack || error);
} finally {
  result.completedAt = new Date().toISOString();
  await writeFile(evidenceFile, JSON.stringify(result, null, 2), { mode: 0o600 });
  await client.close().catch(() => {});
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
