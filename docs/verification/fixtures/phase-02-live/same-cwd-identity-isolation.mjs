import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const root = '/tmp/ultra-kanban-phase2-20261013/live-acceptance-01';
const scopeReport = JSON.parse(await readFile(new URL('./evidence/scope-revision-worktree.json', import.meta.url), 'utf8'));
const marker = `${root}/same-cwd-identity-created.json`;
const evidencePath = new URL('./evidence/same-cwd-identity-isolation.json', import.meta.url).pathname;
try { await access(marker); throw new Error('Refusing duplicate same-cwd identity fixture.'); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `phase2-same-cwd-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const result = { title: 'Phase 2 same-cwd identity isolation Luna fixture', provider: 'codex/gpt-6-luna', modeAtCreation: 'full-access', taskId: scopeReport.createdResources.externalTaskId, taskWorkspaceId: null, duplicateWorkspaceId: null, taskWorkspaceDirectory: null, duplicateWorkspaceDirectory: null, agentId: null, sessionMismatchRejected: false, rejectionMessage: null, error: null };
try {
  await client.connect();
  const board = await client.invokePluginRpc('paseo-ultra-kanban', 'board.read', {});
  const task = board.tasks.find(t => t.id === result.taskId);
  if (!task) throw new Error('External-worktree fixture card is missing.');
  result.taskWorkspaceId = task.workspaceId;
  const ownerId = scopeReport.checks.externalWorktreeOwner.workspaceNativeProjectId;
  const duplicate = await api.workspaces.create({
    title: result.title,
    idempotencyKey: `phase2-same-cwd-${randomUUID()}`,
    source: { kind: 'directory', path: scopeReport.checks.externalWorktreeOwner.workspaceDirectory, projectId: ownerId },
  });
  result.duplicateWorkspaceId = duplicate.id;
  const linked = await api.workspaces.ref(task.workspaceId).refresh();
  const duplicateDescriptor = await duplicate.refresh();
  result.taskWorkspaceDirectory = linked?.workspaceDirectory;
  result.duplicateWorkspaceDirectory = duplicateDescriptor?.workspaceDirectory;
  if (!linked || !duplicateDescriptor || realpathSync(linked.workspaceDirectory) !== realpathSync(duplicateDescriptor.workspaceDirectory)) throw new Error('The controlled duplicate workspace does not have the same canonical cwd.');
  const agentId = randomUUID();
  result.agentId = agentId;
  const agent = await duplicate.agents.create({
    agentId,
    title: 'Phase 2 same-cwd outsider Luna fixture',
    config: { provider: 'codex/gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'medium', systemPrompt: 'This is an isolated identity fixture. Do not edit files, use UI/CUA, access other projects, or create/delegate children. Report PASEO_AGENT_ID and wait.' },
    prompt: 'Setup only: report PASEO_AGENT_ID and wait. Do not call Kanban tools or CLI.',
  });
  if (agent.id !== agentId) throw new Error('Preallocated outsider session ID changed.');
  const finish = await agent.waitForFinish(180000);
  if (finish.status !== 'idle') throw new Error(`Outsider fixture did not return idle: ${finish.status}`);
  await writeFile(marker, JSON.stringify({ taskId: task.id, taskWorkspaceId: task.workspaceId, duplicateWorkspaceId: duplicate.id, agentId, title: result.title, modeAtCreation: 'full-access' }), { mode: 0o600, flag: 'wx' });
  try {
    await client.invokePluginRpc('paseo-ultra-kanban', 'tools.prepare-existing', { id: task.id, agentId });
    result.sessionMismatchRejected = false;
    result.rejectionMessage = 'Unexpectedly accepted another workspace session.';
  } catch (error) {
    result.rejectionMessage = String(error?.message ?? error);
    result.sessionMismatchRejected = /SESSION_MISMATCH|unavailable, archived, or belongs to another workspace/i.test(result.rejectionMessage);
  }
  result.assertions = {
    sameCanonicalCwd: realpathSync(linked.workspaceDirectory) === realpathSync(duplicateDescriptor.workspaceDirectory),
    distinctWorkspaceIds: linked.id !== duplicateDescriptor.id,
    externalNativeOwner: linked.projectId === duplicateDescriptor.projectId,
    otherSessionRejectedForCard: result.sessionMismatchRejected,
  };
} catch (error) {
  result.error = String(error?.stack ?? error);
} finally {
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
  await writeFile(evidencePath, JSON.stringify(result, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
