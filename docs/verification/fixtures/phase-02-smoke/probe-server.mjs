import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { McpServer, createMcpHandler } from '/tmp/ultra-kanban-phase2-20261013/npm/node_modules/@modelcontextprotocol/server/dist/index.mjs';
import { z } from '/tmp/ultra-kanban-phase2-20261013/npm/node_modules/zod/index.js';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '/tmp/ultra-kanban-phase2-20261013/npm/node_modules/@modelcontextprotocol/node/dist/index.mjs';

const token = process.env.PHASE2_SMOKE_TOKEN;
const expectedAgentId = process.env.PHASE2_SMOKE_EXPECTED_AGENT_ID;
const eventFile = process.env.PHASE2_SMOKE_EVENTS;
if (!token || !expectedAgentId || !eventFile) throw new Error('Missing private smoke configuration');

function sameSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function record(event) {
  await appendFile(eventFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

const handler = createMcpHandler(({ requestInfo }) => {
  const authorization = requestInfo.headers.get('authorization');
  const authenticated = typeof authorization === 'string' && authorization.startsWith('Bearer ') && sameSecret(authorization.slice(7), token);
  void record({ kind: 'factory_context', authenticated, protocolHeader: requestInfo.headers.get('mcp-protocol-version') ?? null });
  const server = new McpServer({ name: 'phase-02-smoke-probe', version: '0.2.0' });
  server.registerTool('probe', {
    description: 'Smoke probe only. Read PASEO_AGENT_ID from your own process environment and pass that exact value as agentId.',
    inputSchema: z.object({ agentId: z.string().min(1) }),
  }, async ({ agentId }) => {
    const ok = authenticated && sameSecret(agentId, expectedAgentId);
    await record({ kind: 'probe_result', ok, receivedAgentId: ok ? agentId : 'mismatch' });
    if (!ok) return { isError: true, content: [{ type: 'text', text: 'Smoke probe identity check failed' }] };
    return { content: [{ type: 'text', text: `probe-ok:${agentId}` }], structuredContent: { ok: true, agentId } };
  });
  return server;
}, { responseMode: 'json' });

const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
let requestSequence = 0;
const server = createServer((req, res) => {
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;
  if (req.method !== 'POST' || req.url !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || !sameSecret(authorization.slice(7), token)) {
    res.writeHead(401).end();
    void record({ kind: 'unauthorized' });
    return;
  }
  const sequence = ++requestSequence;
  const chunks = [];
  req.on('data', chunk => chunks.push(Buffer.from(chunk)));
  req.on('end', () => {
    let message = {};
    try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    void record({
      kind: 'request', sequence,
      method: typeof message.method === 'string' ? message.method : 'unparsed',
      requestId: message.id ?? null,
      protocolVersion: message.params?.protocolVersion ?? req.headers['mcp-protocol-version'] ?? null,
      ...(typeof message.params?.name === 'string' ? { toolName: message.params.name } : {}),
      ...(message.method === 'tools/call' && typeof message.params?.arguments?.agentId === 'string' ? { requestedAgentId: message.params.arguments.agentId } : {}),
    });
  });
  void nodeHandler(req, res).catch(error => {
    void record({ kind: 'node_handler_error', message: String(error?.message ?? error) });
    if (!res.headersSent) res.writeHead(500);
    if (!res.writableEnded) res.end();
  });
});
server.listen(Number(process.env.PHASE2_SMOKE_PORT), '127.0.0.1', () => {
  process.stdout.write('phase2-smoke-ready\n');
});
process.on('SIGTERM', async () => {
  await handler.close();
  server.close(() => process.exit(0));
});
