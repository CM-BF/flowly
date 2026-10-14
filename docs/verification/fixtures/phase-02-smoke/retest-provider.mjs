import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const root = '/tmp/ultra-kanban-phase2-20261013';
const oldAgentId = 'a87d7587-a62c-4ed4-b5b5-b1b03f643368';
const oldRecord = `/Users/bofan.wang/.paseo/agents/tmp-ultra-kanban-phase2-20261013-repo/${oldAgentId}.json`;
const fixtureDir = `${root}/repo`;
const workspaceId = 'wks_11b1087c2ef29080';
const port = 41983;
const probeScript = new URL('./probe-server.mjs', import.meta.url).pathname;
const sessionMarker = `${root}/session-created-retry.json`;
const controlEvents = `${root}/adapter-control-events.jsonl`;
const providerEvents = `${root}/provider-retest-events.jsonl`;
const outputPath = `${root}/provider-retest-result.json`;
const npmRoot = `${root}/npm/node_modules`;

try {
  await access(sessionMarker);
  throw new Error(`Refusing duplicate retry session; marker exists at ${sessionMarker}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const oldData = JSON.parse(await readFile(oldRecord, 'utf8'));
const oldAuthorization = oldData.config?.mcpServers?.['phase-02-smoke']?.headers?.Authorization;
if (typeof oldAuthorization !== 'string' || !oldAuthorization.startsWith('Bearer ')) throw new Error('Original smoke Authorization credential is unavailable');
const token = oldAuthorization.slice('Bearer '.length);
const credentialSha256 = createHash('sha256').update(oldAuthorization).digest('hex');
const newAgentId = randomUUID();
const testName = 'Phase 2 MCP provider probe retry 2026-10-13';
await mkdir(fixtureDir, { recursive: true });

async function startProbe(expectedAgentId, eventFile) {
  await writeFile(eventFile, '', { mode: 0o600 });
  const child = spawn(process.execPath, [probeScript], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      PATH: process.env.PATH,
      PHASE2_SMOKE_TOKEN: token,
      PHASE2_SMOKE_EXPECTED_AGENT_ID: expectedAgentId,
      PHASE2_SMOKE_EVENTS: eventFile,
      PHASE2_SMOKE_PORT: String(port),
    },
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  const deadline = Date.now() + 10000;
  while (!output.includes('phase2-smoke-ready') && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('MCP probe server exited before listen');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!output.includes('phase2-smoke-ready')) throw new Error('MCP probe server did not become ready');
  return child;
}

async function stopProbe(child) {
  if (child?.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

async function readEvents(path) {
  const content = await readFile(path, 'utf8');
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const report = {
  testName,
  provider: 'codex/gpt-6-luna',
  modeId: 'full-access',
  workspaceId,
  fixtureDir,
  originalSessionId: oldAgentId,
  originalCredentialReused: true,
  originalCredentialSha256: credentialSha256,
  originalCredentialLength: oldAuthorization.length,
  port,
  control: { listedTools: [], probeSucceeded: false, events: [] },
  retry: { preallocatedAgentId: newAgentId, createdAgentId: null, createStartedAt: null, createReturnedAt: null, initialStatus: null, finalStatus: null, firstToolCallResult: false, reportedAgentId: null, events: [], timeline: null },
  error: null,
};

let probe = null;
let client = null;
let api = null;
try {
  // Exercise the repaired official v2 server/Node adapter on the original loopback port
  // before the provider run. Control traffic is written to a separate event file.
  probe = await startProbe('control-agent', controlEvents);
  const { Client, StreamableHTTPClientTransport } = await import(`${npmRoot}/@modelcontextprotocol/client/dist/index.mjs`);
  const control = new Client({ name: 'phase-02-adapter-control', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: oldAuthorization } },
  });
  await control.connect(transport);
  const listed = await control.listTools();
  report.control.listedTools = listed.tools.map(tool => tool.name);
  const call = await control.callTool({ name: 'probe', arguments: { agentId: 'control-agent' } });
  report.control.probeSucceeded = call.isError !== true && JSON.stringify(call).includes('probe-ok:control-agent');
  await control.close();
  await stopProbe(probe);
  probe = null;
  report.control.events = await readEvents(controlEvents);
  if (!report.control.listedTools.includes('probe') || !report.control.probeSucceeded) throw new Error('Corrected MCP HTTP control check failed');

  try {
    await access(sessionMarker);
    throw new Error(`Refusing duplicate retry session; marker exists at ${sessionMarker}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeFile(sessionMarker, JSON.stringify({ preallocatedAgentId: newAgentId, testName, reservedAt: new Date().toISOString(), credentialSha256 }), { mode: 0o600, flag: 'wx' });

  probe = await startProbe(newAgentId, providerEvents);
  client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `phase2-retest-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000 });
  api = createPaseoApi(client);
  await client.connect();
  const workspace = api.workspaces.ref(workspaceId);
  const descriptor = await workspace.refresh();
  if (!descriptor || descriptor.id !== workspaceId) throw new Error('Dedicated fixture workspace unavailable');
  const directory = descriptor.workspaceDirectory ?? null;
  if (directory !== fixtureDir) throw new Error(`Fixture workspace path mismatch: ${directory}`);

  report.retry.createStartedAt = new Date().toISOString();
  const agent = await workspace.agents.create({
    agentId: newAgentId,
    title: testName,
    config: {
      provider: 'codex/gpt-6-luna',
      modeId: 'full-access',
      mcpServers: {
        'phase-02-smoke': {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: oldAuthorization },
        },
      },
      systemPrompt: 'This is an isolated MCP compatibility probe. Do not edit or create files. Do not use browser, GUI, CUA, or any Paseo window; do not create or delegate to children/subagents; do not call unrelated tools. Read PASEO_AGENT_ID from your own process environment, call only the phase-02-smoke probe with that exact value, then report the value and probe result.',
    },
    prompt: 'Immediately read PASEO_AGENT_ID from your own process environment, call the phase-02-smoke probe tool with that exact value, and report the value and result. Do not infer your ID from this prompt or filesystem. Do not do any other work.',
  });
  report.retry.createdAgentId = agent.id;
  report.retry.createReturnedAt = new Date().toISOString();
  report.retry.initialStatus = agent.status;
  await writeFile(sessionMarker, JSON.stringify({ preallocatedAgentId: newAgentId, createdAgentId: agent.id, workspaceId, testName, createdAt: report.retry.createReturnedAt, modeId: 'full-access', credentialSha256 }), { mode: 0o600 });
  if (agent.id !== newAgentId) throw new Error(`Preallocated ID changed: ${agent.id}`);

  const finish = await agent.waitForFinish(180000);
  report.retry.finalStatus = finish.status ?? null;
  const timeline = await agent.timeline.refetch({ limit: 40 });
  report.retry.timeline = timeline;
  const timelineText = JSON.stringify(timeline);
  report.retry.firstToolCallResult = timelineText.includes('probe-ok:');
  const reported = timelineText.match(/PASEO_AGENT_ID[^\w-]*([0-9a-f-]{36})/i) ?? timelineText.match(/probe-ok:([0-9a-f-]{36})/i);
  report.retry.reportedAgentId = reported?.[1] ?? null;
} catch (error) {
  report.error = String(error?.stack ?? error).replaceAll(oldAuthorization, '[REDACTED]');
} finally {
  if (api) await api.dispose().catch(() => {});
  if (client) await client.close().catch(() => {});
  await stopProbe(probe).catch(() => {});
  try { report.retry.events = await readEvents(providerEvents); } catch {}
  await writeFile(outputPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({
    testName: report.testName,
    provider: report.provider,
    modeId: report.modeId,
    originalCredentialReused: report.originalCredentialReused,
    originalCredentialSha256: report.originalCredentialSha256,
    port: report.port,
    control: report.control,
    retry: { ...report.retry, timeline: undefined },
    error: report.error,
  }) + '\n');
}
