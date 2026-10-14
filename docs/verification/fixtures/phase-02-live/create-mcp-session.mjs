import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const fixtureRoot = '/tmp/ultra-kanban-phase2-20261013/live-acceptance-01';
const fixture = JSON.parse(await readFile(`${fixtureRoot}/fixture-index.json`, 'utf8'));
const reportPath = `${fixtureRoot}/new-mcp-session.json`;
const markerPath = `${fixtureRoot}/new-mcp-session-created.json`;
try { await access(markerPath); throw new Error('Refusing duplicate Luna MCP fixture session.'); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `phase2-mcp-lifecycle-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const result = { title: 'Phase 2 acceptance Luna MCP lifecycle 2026-10-13', provider: 'codex/gpt-6-luna', requestedModeId: 'full-access', taskId: fixture.task.id, workspaceId: fixture.task.workspaceId, preallocatedAgentId: null, createdAgentId: null, createStartedAt: null, createReturnedAt: null, modeAtCreation: 'full-access', completionStatus: null, finalPaseoAgentId: null, error: null };
let authorization = '';
try {
  await client.connect();
  const preparation = await client.invokePluginRpc('paseo-ultra-kanban', 'tools.prepare-session', { id: fixture.task.id, operationId: 'phase2-live-mcp-session-op-v1' });
  authorization = preparation.mcp?.headers?.Authorization ?? '';
  if (!preparation.agentId || !authorization.startsWith('Bearer ') || preparation.mcp?.url !== 'http://127.0.0.1:56670/mcp') throw new Error('Unexpected or incomplete MCP session preparation.');
  result.preallocatedAgentId = preparation.agentId;
  const workspace = api.workspaces.ref(fixture.task.workspaceId);
  const descriptor = await workspace.refresh();
  if (!descriptor || descriptor.workspaceDirectory !== fixture.task.sourcePath) throw new Error('Prepared session workspace does not match the isolated task source.');
  result.createStartedAt = new Date().toISOString();
  const agent = await workspace.agents.create({
    agentId: preparation.agentId,
    idempotencyKey: `ultra-kanban-session:${preparation.agentId}`,
    title: result.title,
    labels: { 'ultra-kanban-task': fixture.task.id },
    config: {
      provider: 'codex/gpt-6-luna',
      modeId: 'full-access',
      thinkingOptionId: 'medium',
      systemPrompt: `${preparation.instructions}\n\nAcceptance constraints: no file edits, no GUI/browser/CUA/Paseo-window actions, no child/subagent creation or delegation, no other project access, no credential or signed request ID in your reply. Execute only the requested Kanban MCP read and writes.`,
      mcpServers: { 'ultra-kanban': preparation.mcp },
    },
    env: {
      ULTRA_KANBAN_CONTEXT_FILE: preparation.contextFile,
      ULTRA_KANBAN_CLI: preparation.cliPath,
      ULTRA_KANBAN_SKILL: preparation.skillPath,
    },
    prompt: `Immediately use the Kanban MCP tools in this order: (1) kanban_get_task and confirm this is your current task; (2) kanban_update_status to in_progress with a short note; (3) kanban_report_progress with kind progress; (4) kanban_update_status to in_review with a short delivery note. After each write use the returned current context/request for the next call. Do not set done/cancelled. Make no file changes. Finally report your PASEO_AGENT_ID, each operation's success/failure and current card status, but never quote credentials or signed request IDs.`,
  });
  result.createdAgentId = agent.id;
  result.createReturnedAt = new Date().toISOString();
  if (agent.id !== preparation.agentId) throw new Error(`Preallocated agent ID changed: ${agent.id}`);
  await writeFile(markerPath, JSON.stringify({ agentId: agent.id, taskId: fixture.task.id, workspaceId: fixture.task.workspaceId, title: result.title, modeAtCreation: 'full-access', createdAt: result.createReturnedAt }), { mode: 0o600, flag: 'wx' });
  const finished = await agent.waitForFinish(240000);
  result.completionStatus = finished.status ?? null;
  const timeline = await agent.timeline.refetch({ limit: 40 });
  result.finalPaseoAgentId = agent.id;
  result.timelineRefetch = { requestId: timeline.requestId, agentId: timeline.agentId };
} catch (error) {
  result.error = String(error?.stack ?? error).replaceAll(authorization, '[REDACTED]');
} finally {
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
  await writeFile(reportPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify(result) + '\n');
}
