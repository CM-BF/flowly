import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const root = '/tmp/ultra-kanban-phase2-20261013';
const agentId = 'a87d7587-a62c-4ed4-b5b5-b1b03f643368';
const fixtureDir = `${root}/repo`;
const eventsPath = `${root}/followup-mcp-events.jsonl`;
const outputPath = `${root}/followup-result.json`;
const probeScript = new URL('./probe-server.mjs', import.meta.url).pathname;
const secret = randomUUID() + randomUUID();
const port = 41983;
await mkdir(fixtureDir, { recursive: true });
await writeFile(eventsPath, '', { mode: 0o600 });
const probe = spawn(process.execPath, [probeScript], {
  stdio: ['ignore', 'pipe', 'ignore'],
  env: { PATH: process.env.PATH, PHASE2_SMOKE_TOKEN: secret, PHASE2_SMOKE_EXPECTED_AGENT_ID: agentId, PHASE2_SMOKE_EVENTS: eventsPath, PHASE2_SMOKE_PORT: String(port), PHASE2_SMOKE_ACCEPT_ANY_BEARER: '1' },
});
let stdout = '';
probe.stdout.on('data', chunk => { stdout += chunk.toString(); });
const until = Date.now() + 10000;
while (!stdout.includes('phase2-smoke-ready') && Date.now() < until) {
  if (probe.exitCode !== null) throw new Error('Probe stub exited before ready');
  await new Promise(resolve => setTimeout(resolve, 50));
}
if (!stdout.includes('phase2-smoke-ready')) throw new Error('Probe stub failed readiness');

const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `phase2-followup-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000 });
const api = createPaseoApi(client);
const output = { agentId, provider: 'codex/gpt-6-luna', modeId: 'full-access', result: null, timelineExcerpt: null, mcpEvents: [], error: null };
try {
  await client.connect();
  const agent = api.agents.ref(agentId);
  const refreshed = await agent.refresh();
  if (!refreshed?.agent || refreshed.agent.id !== agentId || refreshed.agent.workspaceId === null) throw new Error('Could not refresh the original smoke session');
  output.result = await agent.run('This is a follow-up in the same smoke session. Read your PASEO_AGENT_ID environment value, call the existing phase-02-smoke probe tool once with that exact value, and report the value and result. Do not do any other work.', { timeoutMs: 180000 });
  const timeline = await agent.timeline.refetch({ limit: 30 });
  output.timelineExcerpt = JSON.stringify(timeline).slice(-7000);
} catch (error) {
  output.error = String(error?.stack ?? error).replaceAll(secret, '[REDACTED]');
} finally {
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
  if (probe.exitCode === null) {
    const exited = new Promise(resolve => probe.once('exit', resolve));
    probe.kill('SIGTERM');
    await exited;
  }
  try { output.mcpEvents = (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch {}
  await writeFile(outputPath, JSON.stringify(output, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ...output, timelineExcerpt: undefined }) + '\n');
}
