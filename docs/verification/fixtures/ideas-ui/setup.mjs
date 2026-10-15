import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';

const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `ideas-ui-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const rpc = (method, input) => client.invokePluginRpc('paseo-ultra-kanban', method, input);
const idsPath = new URL('./ids.json', import.meta.url);
const fixture = { startedAt: new Date().toISOString(), project: null, task: null, worker: null, directory: null, ideaIds: [], proposals: [], cleanup: {} };
let nativeProjectId;

try {
  await client.connect();
  fixture.directory = await mkdtemp(join(tmpdir(), 'paseo-kanban-ideas-ui-'));
  const project = await rpc('projects.create', { title: `Ideas UI ${randomUUID().slice(0, 8)}`, description: 'Disposable UI acceptance fixture.', primaryPath: fixture.directory });
  fixture.project = project.id;
  nativeProjectId = project.paseoProjectId;
  const task = await rpc('tasks.create', { projectId: project.id, operationId: `ideas-ui-card-${randomUUID()}`, title: 'Ideas UI source card A', description: 'Disposable source card for Ideas UI acceptance.', status: 'todo', priority: 'normal', mode: 'directory' });
  fixture.task = task.id;
  fixture.workspace = task.workspaceId;
  const prepared = await rpc('tools.prepare-session', { id: task.id, operationId: `ideas-ui-session-${randomUUID()}` });
  const workspace = api.workspaces.ref(task.workspaceId);
  const worker = await workspace.agents.create({
    agentId: prepared.agentId,
    idempotencyKey: `ultra-kanban-ideas-ui:${prepared.agentId}`,
    title: 'Ideas UI Luna acceptance worker',
    labels: { 'ultra-kanban-task': task.id },
    config: { provider: 'codex/gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'medium', systemPrompt: prepared.instructions, mcpServers: { 'ultra-kanban': prepared.mcp } },
    env: { ULTRA_KANBAN_CONTEXT_FILE: prepared.contextFile, ULTRA_KANBAN_CLI: prepared.cliPath, ULTRA_KANBAN_SKILL: prepared.skillPath },
    prompt: 'Setup only. Do not edit or create any file. Report ready and wait for the acceptance instruction.'
  });
  fixture.worker = worker.id;
  fixture.workerProvider = 'codex/gpt-6-luna';
  fixture.workerModeIdAtCreation = 'full-access';
  const setup = await worker.waitForFinish(180000);
  fixture.workerSetup = setup.status;
  if (setup.status !== 'idle') throw new Error(`Worker setup status: ${setup.status}`);

  const turn = await worker.run(`UI acceptance fixture only. Do not create, edit, or delete any workspace file. Do not change the source card status. Use only kanban_get_task and kanban_propose_idea. For each proposal, fetch a fresh task snapshot and use its current expectedRevision and request. Never print request or signature values. Propose exactly these three ideas:
1. title "Fix stale filter state after refresh"; detail "Reproduce the stale filter state after a refresh. Add a regression test that verifies the selected filter is restored from the URL and the result list matches it."; rationale "The URL and visible filter can diverge after a refresh, so users may think they are looking at one result set while the page is showing another."; context "Files: client/search/filter-state.ts and client/search/filter-state.test.ts. Branch: ideas-ui-fixture. The refresh path currently hydrates the result list before URL state; verify ordering and retain the query string as the source of truth. Do not change unrelated search behavior."; type bugfix; priority high.
2. title "Document the filter recovery workflow"; detail "Write a short guide to recovering filters after navigation."; rationale "A concise recovery guide would help support answer common questions." Omit context, type, and priority.
3. title "Add a filter-state diagnostic event"; detail "Record a diagnostic event when filter state is restored from a URL."; rationale "A diagnostic event would make hard-to-reproduce customer reports easier to investigate. It should identify whether URL hydration completed before result rendering and help separate stale state from an incorrect query. Keep the event low volume, avoid logging user-entered query text, and document the fields so future investigations can compare behavior across refreshes." Omit context, type, and priority.
Return only a concise JSON array of the three titles and success booleans.`, { timeoutMs: 240000 });
  fixture.workerTurnStatus = turn.status;
  const board = await rpc('board.read', {});
  const ideas = board.ideas.filter((idea) => idea.taskId === task.id);
  fixture.ideaIds = ideas.map((idea) => idea.id);
  fixture.proposals = ideas.map((idea) => ({ title: idea.title, ideaId: idea.id, type: idea.type ?? null, priority: idea.priority ?? null, optionalFieldsOmitted: !idea.type && !idea.priority && !idea.context }));
  if (ideas.length !== 3 || turn.status !== 'idle') throw new Error(`Expected 3 proposed ideas and idle worker, got ${ideas.length} ideas, status ${turn.status}`);
  await writeFile(idsPath, JSON.stringify(fixture, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: 'ready', projectId: fixture.project, nativeProjectId, taskId: fixture.task, workspaceId: fixture.workspace, workerSessionId: fixture.worker, ideaIds: fixture.ideaIds, tempDir: fixture.directory }));
} catch (error) {
  fixture.setupError = String(error?.message ?? error);
  await writeFile(idsPath, JSON.stringify(fixture, null, 2), { mode: 0o600 }).catch(() => {});
  console.log(JSON.stringify({ status: 'failed', error: fixture.setupError, projectId: fixture.project, taskId: fixture.task, workerSessionId: fixture.worker, tempDir: fixture.directory }));
  process.exitCode = 1;
} finally {
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
}
