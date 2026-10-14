import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const root = '/tmp/ultra-kanban-phase2-20261013';
const fixtureDir = `${root}/repo`;
const probeScript = new URL('./probe-server.mjs', import.meta.url).pathname;
const eventsPath = `${root}/mcp-events.jsonl`;
const reportPath = `${root}/smoke-result.json`;
const oneShotPath = `${root}/session-created.json`;
const port = 41983;
const agentId = randomUUID();
const secret = randomUUID() + randomUUID();
try {
  await access(oneShotPath);
  throw new Error(`Refusing duplicate smoke session; marker exists at ${oneShotPath}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await writeFile(oneShotPath, JSON.stringify({ preallocatedAgentId: agentId, reservedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
await mkdir(fixtureDir, { recursive: true });
await writeFile(eventsPath, '', { mode: 0o600 });

const probe = spawn(process.execPath, [probeScript], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    PATH: process.env.PATH,
    PHASE2_SMOKE_TOKEN: secret,
    PHASE2_SMOKE_EXPECTED_AGENT_ID: agentId,
    PHASE2_SMOKE_EVENTS: eventsPath,
    PHASE2_SMOKE_PORT: String(port),
  },
});
let probeOutput = '';
probe.stdout.on('data', chunk => { probeOutput += chunk.toString(); });
probe.stderr.on('data', () => {});
const readyDeadline = Date.now() + 10000;
while (!probeOutput.includes('phase2-smoke-ready') && Date.now() < readyDeadline) {
  if (probe.exitCode !== null) throw new Error(`MCP stub exited before listen (${probe.exitCode})`);
  await new Promise(resolve => setTimeout(resolve, 50));
}
if (!probeOutput.includes('phase2-smoke-ready')) throw new Error('MCP stub did not become ready');

const client = new DaemonClient({
  url: 'ws://127.0.0.1:6767/ws',
  clientId: `phase2-smoke-${randomUUID()}`,
  clientType: 'cli',
  appVersion: '0.11.2',
  connectTimeoutMs: 10000,
});
const api = createPaseoApi(client);
const result = { provider: 'codex/gpt-6-luna', modeId: 'full-access', daemonSdk: '@getpaseo/client 0.11.2', allocatedAgentId: agentId, workspaceId: null, createdAgentId: null, status: null, reportedAgentId: null, probeEvents: [], error: null };
try {
  await client.connect();
  const workspace = await api.workspaces.open({ cwd: fixtureDir });
  result.workspaceId = workspace.id;
  const agent = await workspace.agents.create({
    agentId,
    title: 'Phase 2 isolated MCP smoke',
    config: {
      provider: 'codex/gpt-6-luna',
      modeId: 'full-access',
      mcpServers: {
        'phase-02-smoke': {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: `Bearer ${secret}` },
        },
      },
      systemPrompt: 'This is an isolated compatibility smoke. Do not edit or create files, do not inspect other projects, and do not call unrelated tools. Read PASEO_AGENT_ID from your own process environment and pass it unchanged to the phase-02-smoke probe tool. Then report the environment value and whether the probe succeeded.',
    },
    prompt: 'Immediately read PASEO_AGENT_ID from your own environment, call the phase-02-smoke probe tool with that exact value, and report the value plus the tool result. Do not infer the value from this prompt or filesystem.',
  });
  result.createdAgentId = agent.id;
  await writeFile(oneShotPath, JSON.stringify({ preallocatedAgentId: agentId, createdAgentId: agent.id, workspaceId: workspace.id, createdAt: new Date().toISOString() }), { mode: 0o600 });
  if (agent.id !== agentId) throw new Error(`Preallocated ID changed: ${agent.id}`);
  const finished = await agent.waitForFinish(180000);
  result.status = finished.status ?? null;
  const timeline = await agent.timeline.refetch({ limit: 30 });
  const rendered = JSON.stringify(timeline);
  const match = rendered.match(/PASEO_AGENT_ID[^\w-]*([0-9a-f-]{36})/i) ?? rendered.match(/probe-ok:([0-9a-f-]{36})/i);
  result.reportedAgentId = match?.[1] ?? null;
  result.timelineContainsProbeResult = rendered.includes('probe-ok:');
  result.timelineExcerpt = rendered.slice(-5000);
} catch (error) {
  result.error = String(error?.stack ?? error).replaceAll(secret, '[REDACTED]');
} finally {
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
  if (probe.exitCode === null) {
    const exited = new Promise(resolve => probe.once('exit', resolve));
    probe.kill('SIGTERM');
    await exited;
  }
  try {
    result.probeEvents = (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {}
  await writeFile(reportPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ...result, timelineExcerpt: undefined }) + '\n');
}
