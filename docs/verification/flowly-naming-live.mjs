// One owned verification session on the existing card; no fixture projects/workspaces.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const home = process.env.PASEO_HOME || join(homedir(), '.paseo');
const parentId = process.env.PASEO_AGENT_ID;
if (!parentId) throw new Error('Requires the calling Paseo session identity.');
const binding = JSON.parse(await readFile(join(home, 'plugin-data/flowly/sessions', parentId + '.json'), 'utf8'));
if (binding.identity.agentId !== parentId) throw new Error('Session binding mismatch.');
const { listen } = JSON.parse(await readFile(join(home, 'paseo.pid'), 'utf8'));
const localCredential = (await readFile(join(home, 'local-credential'), 'utf8')).trim();
const client = new DaemonClient({ url: `ws://${listen.replace(/^tcp:\/\//, '')}/ws`, clientId: 'flowly-naming-verification', clientType: 'cli', localCredential: () => localCredential, reconnect: { enabled: false } });
const api = createPaseoApi(client);
const evidencePath = new URL('./flowly-naming-live.json', import.meta.url);
const evidence = { provider: 'codex/gpt-6-luna', modeAtCreation: 'full-access', taskId: binding.identity.taskId, workspaceId: binding.identity.workspaceId, parentId, agentId: null, createdAt: null, finished: null, cleanup: null };
let agent;
try {
  await client.connect();
  const prepared = await client.invokePluginRpc('flowly', 'tools.prepare-session', { id: binding.identity.taskId, operationId: `flowly-naming-luna-${Date.now()}` });
  evidence.agentId = prepared.agentId;
  // Record ownership before creating a native resource. Never serialize preparation/credentials.
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  agent = await api.workspaces.ref(binding.identity.workspaceId).agents.create({
    agentId: prepared.agentId,
    parent: parentId,
    idempotencyKey: `flowly-naming-verification:${prepared.agentId}`,
    title: 'Flowly naming verification · Luna',
    labels: { 'flowly-verification': 'naming' },
    config: { provider: 'codex/gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'medium', systemPrompt: prepared.instructions, mcpServers: { flowly: prepared.mcp } },
    env: { FLOWLY_CONTEXT_FILE: prepared.contextFile, FLOWLY_CLI: prepared.cliPath, FLOWLY_SKILL: prepared.skillPath },
    prompt: `You own only docs/verification/flowly-naming-luna.md and verification, never implementation files. You are sharing the codebase: preserve every other edit. Do not spawn children, create cards/projects/workspaces, modify settings, use UI, or change card status. Testing delegation was explicitly requested by AGENTS.md; you were launched as codex/gpt-6-luna with full-access at creation. First use the installed flowly_get_task MCP tool to verify your own binding. Use flowly_report_progress once with a brief testing checkpoint (fresh revisions/request). Verify your environment exposes FLOWLY_CONTEXT_FILE, FLOWLY_CLI ending flowly.mjs, FLOWLY_SKILL without printing credential content. Read docs/FLOWLY-NAMING-SPEC.md, source and tests for the renamed MCP/skill/CLI/session config. Run npx vitest run server/tool-server.test.ts server/naming.test.ts shared/summary.test.ts client/session.test.ts. Confirm MCP initialize/list tests expose only eleven flowly_* tools, packaged/runtime skill matches and has no old product name, legacy context/reload/migration/helper recognition remain intact. Inspect current launch paths for flowly MCP key and FLOWLY_* env; report concrete defects if any. Write a concise PASS/FAIL/UNRUN report to your owned evidence file including your session ID, commands and counts. Do not run the full suite or change implementation. Runtime tool calls are required; do not equate plugin running with success. Your result is a partial verification contribution, so leave the card in Test. Never print credentials or signed request IDs.`,
  });
  evidence.createdAt = new Date().toISOString();
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify({ agentId: agent.id, mode: 'full-access', provider: 'codex/gpt-6-luna' }) + '\n');
  const result = await agent.waitForFinish(600000);
  evidence.finished = { status: result.status, at: new Date().toISOString() };
} finally {
  if (agent) {
    await agent.archive();
    const archived = await api.agents.ref(agent.id).refresh();
    evidence.cleanup = { archivedAt: archived?.agent?.archivedAt ?? null, existingWorkspacePreserved: true, createdProjects: 0, createdWorkspaces: 0, createdCards: 0 };
  }
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  await api.dispose();
  await client.close();
}
process.stdout.write(JSON.stringify(evidence) + '\n');
