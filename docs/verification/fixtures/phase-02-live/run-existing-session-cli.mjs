import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const fixtureRoot = '/tmp/ultra-kanban-phase2-20261013/live-acceptance-01';
const fixture = JSON.parse(await readFile(`${fixtureRoot}/fixture-index.json`, 'utf8'));
const reportPath = `${fixtureRoot}/existing-cli-session.json`;
const markerPath = `${fixtureRoot}/existing-cli-session-created.json`;
try { await access(markerPath); throw new Error('Refusing duplicate existing-session CLI fixture.'); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `phase2-cli-lifecycle-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const report = { title: 'Phase 2 acceptance existing session CLI 2026-10-13', provider: 'codex/gpt-6-luna', modeAtCreation: 'full-access', taskId: null, workspaceId: null, agentId: null, operationId: 'phase2-live-existing-cli-card-v1', preparation: null, initialTurn: null, cliTurn: null, finalStatus: null, error: null };
function q(s) { return `'${String(s).replaceAll("'", "'\\''")}'`; }
try {
  await client.connect();
  const projectBoard = await client.invokePluginRpc('paseo-ultra-kanban', 'board.read', {});
  const project = projectBoard.projects.find(p => p.id === fixture.project.id);
  const task = await client.invokePluginRpc('paseo-ultra-kanban', 'tasks.create', {
    projectId: project.id,
    operationId: report.operationId,
    title: 'Phase 2 acceptance: existing session CLI path',
    description: 'Verify explicit CLI access for this selected session only. No file changes.',
    status: 'todo', priority: 'normal', sourcePath: fixture.repos[1], repoPaths: [fixture.repos[1]], mode: 'directory',
  });
  report.taskId = task.id;
  report.workspaceId = task.workspaceId;
  const workspace = api.workspaces.ref(task.workspaceId);
  const descriptor = await workspace.refresh();
  if (!descriptor || descriptor.workspaceDirectory !== task.sourcePath) throw new Error('CLI fixture workspace path mismatch.');
  const agentId = randomUUID();
  report.agentId = agentId;
  const agent = await workspace.agents.create({
    agentId,
    idempotencyKey: `phase2-existing-cli:${agentId}`,
    title: report.title,
    labels: { 'ultra-kanban-task': task.id },
    config: { provider: 'codex/gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'medium', systemPrompt: 'This is an isolated test fixture session. Do not edit or create files. Do not use browser, GUI, CUA, Paseo windows, unrelated tools, or child/subagents. Initially just report your PASEO_AGENT_ID and wait for the Kanban CLI instruction.' },
    prompt: 'This is a setup turn only. Report your PASEO_AGENT_ID and state that you are ready for a later instruction. Do not call any Kanban tool or CLI yet.',
  });
  if (agent.id !== agentId) throw new Error('Paseo did not preserve the preallocated fixture session ID.');
  const initial = await agent.waitForFinish(180000);
  report.initialTurn = { status: initial.status ?? null, expectedAgentId: agentId, idMatches: agent.id === agentId };
  const preparation = await client.invokePluginRpc('paseo-ultra-kanban', 'tools.prepare-existing', { id: task.id, agentId });
  report.preparation = { agentId: preparation.agentId, contextFile: preparation.contextFile, cliPath: preparation.cliPath, skillPath: preparation.skillPath, mcpUrlOmitted: true, authorizationValueOmitted: true, instructionsProvided: typeof preparation.instructions === 'string' };
  if (preparation.agentId !== agentId || !preparation.contextFile || !preparation.cliPath || !preparation.skillPath) throw new Error('prepare-existing response incomplete or bound to wrong agent.');
  const request1 = join(fixtureRoot, 'private-requests', `${agentId}-current1.json`);
  const request2 = join(fixtureRoot, 'private-requests', `${agentId}-current2.json`);
  const request3 = join(fixtureRoot, 'private-requests', `${agentId}-current3.json`);
  execFileSync('mkdir', ['-p', join(fixtureRoot, 'private-requests')]);
  const suffix = `\n\nFor this test, use only the supplied per-session CLI, not MCP. Use explicit paths from the instructions. Sequence: (1) run current with --save-request ${q(request1)}; (2) run status in_progress with --request-file ${q(request1)} and a short note; (3) run current with --save-request ${q(request2)}; (4) run note with --kind progress, --request-file ${q(request2)} and a checkpoint; (5) run current with --save-request ${q(request3)}; (6) run status in_review with --request-file ${q(request3)} and a short delivery note. Do not set done/cancelled. Do not print or quote request IDs/credentials. Report command exit success/failure, PASEO_AGENT_ID, and final card status only.`;
  report.cliTurn = await agent.run(`${preparation.instructions}${suffix}`, { timeoutMs: 240000 });
  const [boardAfter, access] = await Promise.all([
    client.invokePluginRpc('paseo-ultra-kanban', 'board.read', {}),
    client.invokePluginRpc('paseo-ultra-kanban', 'tools.access-state', { id: task.id, agentId }),
  ]);
  const finalTask = boardAfter.tasks.find(item => item.id === task.id);
  report.finalStatus = { status: finalTask?.status, revision: finalTask?.revision, repoPaths: finalTask?.repoPaths, events: boardAfter.events.filter(event => event.taskId === task.id).map(event => ({ actor: event.actor, action: event.action, agentId: event.agentId, from: event.from, to: event.to, reportKind: event.reportKind })) };
  report.accessState = { methods: access.methods, lastAction: access.lastAction, ready: access.ready };
  await writeFile(markerPath, JSON.stringify({ agentId, taskId: task.id, workspaceId: task.workspaceId, createdAt: new Date().toISOString(), modeAtCreation: 'full-access' }), { mode: 0o600, flag: 'wx' });
} catch (error) {
  report.error = String(error?.stack ?? error);
} finally {
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
  const timeline = report.agentId ? execFileSync('paseo', ['logs', report.agentId, '--json', '--tail', '60'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }) : '';
  const safeTimeline = timeline.split(/\r?\n/).map(line => {
    const calls = [...line.matchAll(/\[ultra-kanban\.([^\]]+)\]/g)].map(match => match[1]);
    if (calls.length) return calls.map(name => `[ultra-kanban.${name}] [arguments redacted]`).join('\n');
    return line.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  }).join('\n');
  await writeFile(join(new URL('./evidence/', import.meta.url).pathname, 'existing-cli-agent-timeline.txt'), safeTimeline, { mode: 0o600 });
  await writeFile(reportPath, JSON.stringify(report, null, 2).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]'), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ taskId: report.taskId, workspaceId: report.workspaceId, agentId: report.agentId, modeAtCreation: report.modeAtCreation, initialTurn: report.initialTurn, cliTurn: report.cliTurn ? { status: report.cliTurn.status, lastMessage: report.cliTurn.lastMessage } : null, finalStatus: report.finalStatus, accessState: report.accessState, error: report.error }, null, 2) + '\n');
}
