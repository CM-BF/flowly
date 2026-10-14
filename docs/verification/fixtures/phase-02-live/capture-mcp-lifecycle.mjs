import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const root = '/tmp/ultra-kanban-phase2-20261013/live-acceptance-01';
const fixture = JSON.parse(await readFile(`${root}/fixture-index.json`, 'utf8'));
const session = JSON.parse(await readFile(`${root}/new-mcp-session.json`, 'utf8'));
const evidenceDir = new URL('./evidence/', import.meta.url);
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: 'phase2-mcp-evidence-capture', clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const result = { observedAt: new Date().toISOString(), taskId: session.taskId, workspaceId: session.workspaceId, agentId: session.createdAgentId, health: null, task: null, project: null, taskEvents: [], context: null, accessState: null, assertions: {} };
try {
  await client.connect();
  const [board, health, context, access] = await Promise.all([
    client.invokePluginRpc('paseo-ultra-kanban', 'board.read', {}),
    client.invokePluginRpc('paseo-ultra-kanban', 'tools.health', {}),
    client.invokePluginRpc('paseo-ultra-kanban', 'tasks.context', { id: session.taskId }),
    client.invokePluginRpc('paseo-ultra-kanban', 'tools.access-state', { id: session.taskId, agentId: session.createdAgentId }),
  ]);
  const task = board.tasks.find(item => item.id === session.taskId);
  const project = board.projects.find(item => item.id === fixture.project.id);
  result.health = { listening: health.listening, sdkReady: health.sdkReady, ready: health.ready };
  result.task = task;
  result.project = project;
  result.taskEvents = board.events.filter(event => event.taskId === session.taskId);
  result.context = { available: context.available, owner: context.owner, workspaceRepoPaths: context.workspaceRepoPaths, directories: context.directories };
  result.accessState = { methods: access.methods, lastSuccessAt: access.lastSuccessAt, lastAction: access.lastAction, listening: access.listening, sdkReady: access.sdkReady, ready: access.ready };
  result.assertions = {
    taskIsInReview: task?.status === 'in_review',
    taskRevisionIsThree: task?.revision === 3,
    scopeDefaultsToAllRepos: task?.repoPaths?.length === 0 && context.directories?.length === 2,
    mcpMethodReported: access.methods?.includes('mcp'),
    statusWritesRecorded: result.taskEvents.filter(e => e.actor === 'agent' && e.agentId === session.createdAgentId && e.action === 'status_changed').length === 2,
    progressRecorded: result.taskEvents.some(e => e.actor === 'agent' && e.agentId === session.createdAgentId && e.action === 'progress_reported' && e.reportKind === 'progress'),
    turnEndDidNotCompleteCard: task?.status === 'in_review',
  };
  await writeFile(new URL('mcp-lifecycle-board-evidence.json', evidenceDir), JSON.stringify(result, null, 2), { mode: 0o600 });
} finally {
  await client.close();
}
const rawLog = execFileSync('paseo', ['logs', session.createdAgentId, '--json', '--tail', '60'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const safeLog = rawLog.split(/\r?\n/).map(line => {
  const calls = [...line.matchAll(/\[ultra-kanban\.([^\]]+)\]/g)].map(match => match[1]);
  if (calls.length) return calls.map(name => `[ultra-kanban.${name}] [arguments redacted]`).join('\n');
  return line.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}).join('\n');
await writeFile(new URL('mcp-lifecycle-agent-timeline.txt', evidenceDir), safeLog, { mode: 0o600 });
const safeSummary = { ...result, task: result.task && { id: result.task.id, status: result.task.status, revision: result.task.revision, repoPaths: result.task.repoPaths }, project: result.project && { id: result.project.id, revision: result.project.revision, repos: result.project.repos } };
process.stdout.write(JSON.stringify(safeSummary, null, 2) + '\n');
