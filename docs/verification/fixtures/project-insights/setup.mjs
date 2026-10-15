import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';

const outDir = new URL('./', import.meta.url);
await mkdir(outDir, { recursive: true });
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `project-insights-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const rpc = (method, input) => client.invokePluginRpc('paseo-ultra-kanban', method, input);
const fixture = { startedAt: new Date().toISOString(), provider: 'codex/gpt-6-luna', modeIdAtCreation: 'full-access', directory: null, project: null, cards: [], testSessionId: null, cleanup: {} };
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const save = () => writeFile(new URL('./ids.json', import.meta.url), JSON.stringify(fixture, null, 2), { mode: 0o600 });

try {
  await client.connect();
  fixture.directory = await mkdtemp(join(tmpdir(), 'paseo-project-insights-'));
  git(['init', '-q'], fixture.directory);
  git(['config', 'user.name', 'Project Insights Acceptance'], fixture.directory);
  git(['config', 'user.email', 'project-insights-fixture@example.invalid'], fixture.directory);
  await writeFile(join(fixture.directory, 'README.md'), '# Project Insights fixture\nInitial fixture content.\n');
  git(['add', 'README.md'], fixture.directory); git(['commit', '-q', '-m', 'Add fixture README'], fixture.directory);
  await writeFile(join(fixture.directory, 'src.txt'), 'alpha\nbeta\ngamma\n');
  git(['add', 'src.txt'], fixture.directory); git(['commit', '-q', '-m', 'Add sample source file'], fixture.directory);
  await writeFile(join(fixture.directory, 'src.txt'), 'alpha revised\nbeta\ngamma\ndelta\n');
  git(['add', 'src.txt'], fixture.directory); git(['commit', '-q', '-m', 'Revise sample source'], fixture.directory);
  fixture.gitHead = git(['rev-parse', 'HEAD'], fixture.directory);
  fixture.gitLog = git(['log', '-3', '--format=%h %s'], fixture.directory);

  fixture.project = await rpc('projects.create', { title: `Project Insights ${randomUUID().slice(0, 8)}`, description: 'Disposable Project Insights acceptance fixture.', primaryPath: fixture.directory });
  await save();
  const makeCard = async (title, priority = 'normal') => {
    const task = await rpc('tasks.create', { projectId: fixture.project.id, operationId: `project-insights-${randomUUID()}`, title, description: 'Disposable acceptance fixture card.', status: 'todo', priority, mode: 'directory' });
    fixture.cards.push({ id: task.id, workspaceId: task.workspaceId, title, initialStatus: task.status, priority });
    await save();
    return task;
  };
  const setStatus = async (task, status) => {
    const updated = await rpc('tasks.update', { id: task.id, revision: task.revision, status, actor: 'human' });
    return updated;
  };
  let review = await makeCard('Insights review flow card');
  review = await setStatus(review, 'development');
  review = await setStatus(review, 'in_review');
  review = await setStatus(review, 'development');
  review = await setStatus(review, 'in_review');
  let done = await makeCard('Insights completed card');
  done = await setStatus(done, 'development');
  done = await setStatus(done, 'done');
  const urgent = await makeCard('Insights urgent next card', 'urgent');
  const secondReview = await makeCard('Insights second review card');
  await setStatus(secondReview, 'in_review');

  const prepared = await rpc('tools.prepare-session', { id: review.id, operationId: `project-insights-session-${randomUUID()}` });
  const worker = await api.workspaces.ref(review.workspaceId).agents.create({
    agentId: prepared.agentId,
    idempotencyKey: `ultra-kanban-project-insights:${prepared.agentId}`,
    title: 'Project Insights Luna acceptance session',
    labels: { 'ultra-kanban-task': review.id, 'ultra-kanban-project': fixture.project.id },
    config: { provider: 'codex/gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'medium', systemPrompt: prepared.instructions, mcpServers: { 'ultra-kanban': prepared.mcp } },
    env: { ULTRA_KANBAN_CONTEXT_FILE: prepared.contextFile, ULTRA_KANBAN_CLI: prepared.cliPath, ULTRA_KANBAN_SKILL: prepared.skillPath },
    prompt: 'Setup only. Do not create, edit, or delete any file. Report ready and wait for the acceptance instruction.'
  });
  fixture.testSessionId = worker.id;
  await save();
  fixture.testSessionSetup = (await worker.waitForFinish(180000)).status;
  if (fixture.testSessionSetup !== 'idle') throw new Error(`Luna acceptance session setup ended as ${fixture.testSessionSetup}`);

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  fixture.today = today;
  fixture.tz = 'Asia/Singapore';
  fixture.insightsSnapshot = await rpc('insights.project', { projectId: fixture.project.id, tz: fixture.tz, day: today });
  fixture.digestBefore = await rpc('insights.digest', { projectId: fixture.project.id, tz: fixture.tz, day: today });
  const board = await rpc('board.read', {});
  fixture.nativeProjectId = fixture.project.paseoProjectId;
  fixture.projectRevision = fixture.project.revision;
  fixture.revisions = Object.fromEntries(board.tasks.filter((t) => fixture.cards.some((c) => c.id === t.id)).map((t) => [t.id, t.revision]));
  await save();
  console.log(JSON.stringify({ status: 'ready', project: fixture.project, nativeProjectId: fixture.nativeProjectId, directory: fixture.directory, cards: fixture.cards, testSessionId: fixture.testSessionId, today, flowPath: `${process.env.HOME}/.paseo/plugin-data/paseo-ultra-kanban/flow/${fixture.project.id}.jsonl`, digestEnabled: fixture.digestBefore.enabled }));
} catch (error) {
  fixture.setupError = String(error?.stack ?? error).slice(0, 2000);
  await save();
  console.error(JSON.stringify({ status: 'failed', error: fixture.setupError, projectId: fixture.project?.id, nativeProjectId: fixture.nativeProjectId, directory: fixture.directory, testSessionId: fixture.testSessionId }));
  process.exitCode = 1;
} finally {
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
}
