import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const root = '/tmp/ultra-kanban-phase2-20261013/live-acceptance-01';
const repoOne = join(root, 'repo-one');
const repoTwo = join(root, 'repo-two');
const resultFile = join(root, 'fixture-index.json');
try { await access(root); throw new Error(`Refusing to overwrite existing fixture root: ${root}`); }
catch (error) { if (error?.code !== 'ENOENT') throw error; }
await mkdir(repoOne, { recursive: true });
await mkdir(repoTwo, { recursive: true });
for (const [path, name] of [[repoOne, 'repo-one'], [repoTwo, 'repo-two']]) {
  execFileSync('git', ['-C', path, 'init', '--initial-branch=main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Ultra Kanban Phase 2 Fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'config', 'user.email', 'ultra-kanban-fixture@example.invalid'], { stdio: 'ignore' });
  await writeFile(join(path, 'README.md'), `Isolated Phase 2 acceptance fixture ${name}.\n`, { mode: 0o600 });
  execFileSync('git', ['-C', path, 'add', 'README.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'commit', '-m', 'fixture baseline'], { stdio: 'ignore' });
}

const client = new DaemonClient({
  url: 'ws://127.0.0.1:6767/ws',
  clientId: `phase2-live-bootstrap-${randomUUID()}`,
  clientType: 'cli',
  appVersion: '0.11.2',
  connectTimeoutMs: 10000,
  reconnect: { enabled: false },
});
const pluginId = 'paseo-ultra-kanban';
const call = (method, input) => client.invokePluginRpc(pluginId, method, input);
try {
  await client.connect();
  const health = await call('tools.health', {});
  if (!health.ready) throw new Error(`Tool service not ready: ${JSON.stringify(health)}`);
  const project = await call('projects.create', {
    title: 'Phase 2 live acceptance 2026-10-13',
    description: 'Isolated disposable test fixture; preserve after verification.',
    primaryPath: repoOne,
    repos: [repoOne, repoTwo],
  });
  const task = await call('tasks.create', {
    projectId: project.id,
    operationId: 'phase2-live-new-mcp-card-v1',
    title: 'Phase 2 acceptance: MCP lifecycle',
    description: 'Read the task, move to In progress, report progress, then submit to In review. No file changes.',
    status: 'todo',
    priority: 'normal',
    sourcePath: repoOne,
    repoPaths: [],
    mode: 'directory',
  });
  const context = await call('tasks.context', { id: task.id });
  const result = {
    createdAt: new Date().toISOString(),
    root,
    repos: [repoOne, repoTwo],
    nativeProjectId: project.paseoProjectId,
    project: { id: project.id, title: project.title, revision: project.revision, primaryPath: project.primaryPath, repos: project.repos },
    task: { id: task.id, workspaceId: task.workspaceId, sourcePath: task.sourcePath, repoPaths: task.repoPaths, status: task.status, revision: task.revision },
    context: { available: context.available, owner: context.owner, workspaceRepoPaths: context.workspaceRepoPaths, directories: context.directories },
    health: { listening: health.listening, sdkReady: health.sdkReady, ready: health.ready },
  };
  await writeFile(resultFile, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  await client.close();
}
