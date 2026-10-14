// One real codex/gpt-6-luna fixture actor calls only kanban_get_task.
// No credential, signed request, raw timeline, or unrelated user data is saved.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { join } from 'node:path';

const runRoot = '/tmp/ultra-kanban-single-root-20261013/run-04';
const evidenceSource = new URL('./single-root-run-04-evidence.json', import.meta.url);
const firstTurnEvidence = new URL('./single-root-agent-tool-evidence.json', import.meta.url);
const outputFile = new URL('./single-root-agent-tool-final-evidence.json', import.meta.url);
const result = {
  createdAt: new Date().toISOString(),
  runRoot,
  provider: 'codex/gpt-6-luna',
  requestedModeId: 'full-access',
  promptScope: 'one kanban_get_task MCP call; no CLI or additional tools; no writes',
  checks: [],
  bearerOrSignedRequestRecorded: false,
  repositoryFilesChanged: false,
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const client = new DaemonClient({
  url: 'ws://127.0.0.1:6767/ws',
  clientId: `single-root-luna-tool-${randomUUID()}`,
  clientType: 'cli',
  appVersion: '0.11.2',
  connectTimeoutMs: 10000,
  reconnect: { enabled: false },
});
const api = createPaseoApi(client);
const rpc = (method, input) => client.invokePluginRpc('paseo-ultra-kanban', method, input);
const safeError = (error, authorization = '') => String(error?.message || error)
  .replace(authorization ? new RegExp(authorization.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$^/, '[REDACTED]')
  .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
  .replace(/[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{20,}/g, '[SIGNED VALUE REDACTED]');
const boardSummary = (board, taskId) => {
  const task = board.tasks.find((entry) => entry.id === taskId);
  const taskEvents = board.events.filter((entry) => entry.taskId === taskId);
  return {
    boardRevision: board.revision,
    projectCount: board.projects.length,
    taskCount: board.tasks.length,
    task: task ? {
      id: task.id,
      projectId: task.projectId,
      workspaceId: task.workspaceId,
      status: task.status,
      revision: task.revision,
      cardFieldsSha256: digest(JSON.stringify(task)),
    } : null,
    taskEventCount: taskEvents.length,
    taskEvents: taskEvents.map(({ actor, action, from, to }) => ({ actor, action, from, to })),
  };
};
async function filesystemSnapshot(root) {
  const rootEntries = (await readdir(root, { withFileTypes: true }))
    .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const repos = [];
  for (const name of ['repo-one', 'repo-two']) {
    const path = join(root, name);
    const status = execFileSync('git', ['-C', path, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
    repos.push({ name, clean: status.length === 0, changedEntryCount: status ? status.split(/\r?\n/).length : 0 });
  }
  return { rootEntries, rootLevelFiles: rootEntries.filter((entry) => entry.kind === 'file').length, repos };
}
function parseAgentReport(text) {
  if (!text) return null;
  const block = text.match(/\{[\s\S]*\}/)?.[0];
  if (!block) return null;
  try { return JSON.parse(block); } catch { return null; }
}
async function findAgent(agentId) {
  const ref = api.agents.ref(agentId);
  return ref.refresh();
}

let authorization = '';
try {
  const fixture = JSON.parse(await readFile(evidenceSource, 'utf8'));
  const taskId = fixture.directoryTaskId;
  const workspaceId = fixture.directoryWorkspaceId;
  const boardProjectId = fixture.boardProjectId;
  if (!taskId || !workspaceId || !boardProjectId) throw new Error('Run-04 card/workspace IDs are missing.');
  result.taskId = taskId;
  result.workspaceId = workspaceId;
  result.boardProjectId = boardProjectId;

  const intentPath = join(runRoot, 'agent-tool-intent.json');
  let intent;
  try {
    intent = JSON.parse(await readFile(intentPath, 'utf8'));
    if (intent.taskId !== taskId || intent.workspaceId !== workspaceId || intent.boardProjectId !== boardProjectId)
      throw new Error('Existing actor intent belongs to another card/workspace; refusing to reuse it.');
    result.reusedIntent = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    intent = {
      operationId: `single-root-agent-tool-run04-${randomUUID()}`,
      taskId,
      workspaceId,
      boardProjectId,
      reservedAt: new Date().toISOString(),
    };
    await writeFile(intentPath, JSON.stringify(intent, null, 2), { mode: 0o600, flag: 'wx' });
    result.reusedIntent = false;
  }

  await client.connect();
  const [before, resources] = await Promise.all([rpc('board.read', {}), rpc('resources.list', {})]);
  const task = before.tasks.find((entry) => entry.id === taskId);
  const project = before.projects.find((entry) => entry.id === boardProjectId);
  const workspace = resources.workspaces.find((entry) => entry.id === workspaceId);
  if (!task || !project || !workspace) throw new Error('Run-04 fixture resources are missing.');
  if (task.projectId !== boardProjectId || task.workspaceId !== workspaceId)
    throw new Error('Run-04 task is not bound to the expected board project/workspace.');
  if (workspace.projectId !== project.paseoProjectId || workspace.path !== project.primaryPath)
    throw new Error('Run-04 directory workspace owner/path does not match its native root project.');
  const context = await rpc('tasks.context', { id: taskId });
  const rootOnlyRpcContext = context.directories.length === 1 &&
    context.directories[0].repo === project.primaryPath &&
    context.directories[0].directory === project.primaryPath &&
    context.workspaceRepoPaths.length === 1 &&
    context.workspaceRepoPaths[0] === project.primaryPath;
  if (!rootOnlyRpcContext) throw new Error('Read-only task context is not restricted to the fixture root.');
  result.root = project.primaryPath;
  result.beforeBoard = boardSummary(before, taskId);
  const filesBefore = await filesystemSnapshot(project.primaryPath);
  result.filesBefore = filesBefore;
  result.rpcContext = {
    available: context.available,
    repoPaths: context.directories.map((entry) => entry.repo),
    directories: context.directories,
    workspaceRepoPaths: context.workspaceRepoPaths,
    sha256: digest(JSON.stringify(context)),
  };
  result.fixtureAssociation = {
    taskMatchesProject: task.projectId === boardProjectId,
    taskMatchesWorkspace: task.workspaceId === workspaceId,
    workspaceOwnerMatchesNativeProject: workspace.projectId === project.paseoProjectId,
    workspacePathMatchesProjectRoot: workspace.path === project.primaryPath,
  };
  const boardBytesBefore = digest(await readFile('/Users/bofan.wang/.paseo/plugin-data/paseo-ultra-kanban/board.json'));
  result.boardSha256BeforeAudit = boardBytesBefore;

  // Reuse a prior actor only if its persisted intent ID exists and Paseo confirms workspace membership.
  let preparation;
  let actor = null;
  if (intent.agentId) {
    const prior = await findAgent(intent.agentId);
    if (prior?.agent && prior.agent.workspaceId === workspaceId && !prior.agent.archivedAt) {
      actor = api.agents.ref(intent.agentId);
      result.reusedActor = true;
      result.preallocatedAgentId = intent.agentId;
      result.createdAgentId = prior.agent.id;
    } else {
      throw new Error('Recorded preallocated actor does not exist in the expected workspace; refusing to create a replacement.');
    }
  } else {
    const prep = await rpc('tools.prepare-session', { id: taskId, operationId: intent.operationId });
    preparation = prep;
    authorization = prep.mcp?.headers?.Authorization ?? '';
    if (!prep.agentId || !authorization.startsWith('Bearer ') || prep.mcp?.url !== 'http://127.0.0.1:56670/mcp')
      throw new Error('tools.prepare-session did not return the expected local MCP identity/configuration.');
    result.preallocatedAgentId = prep.agentId;
    intent.agentId = prep.agentId;
    intent.preparedAt = new Date().toISOString();
    await writeFile(intentPath, JSON.stringify(intent, null, 2), { mode: 0o600 });

    const workspaceHandle = api.workspaces.ref(workspaceId);
    const descriptor = await workspaceHandle.refresh();
    if (!descriptor || descriptor.projectId !== project.paseoProjectId || descriptor.workspaceDirectory !== project.primaryPath)
      throw new Error('Public SDK workspace refresh does not match the prepared fixture root/owner.');
    actor = await workspaceHandle.agents.create({
      agentId: prep.agentId,
      idempotencyKey: `ultra-kanban-session:${prep.agentId}`,
      title: 'Single-root MCP scope acceptance fixture actor',
      labels: { 'ultra-kanban-task': taskId },
      config: {
        provider: 'codex/gpt-6-luna',
        modeId: 'full-access',
        thinkingOptionId: 'medium',
        systemPrompt: `${prep.instructions}\n\nAcceptance restriction: This fixture is read-only. Do not edit/create/delete files, do not call CLI, do not use GUI/browser, do not delegate or create child sessions, and do not write Kanban status/progress. In the initial turn call exactly one MCP tool, kanban_get_task, once. Report only the requested JSON from its returned context. Never reveal credentials or signed request values.`,
        mcpServers: { 'ultra-kanban': prep.mcp },
      },
      env: {
        ULTRA_KANBAN_CONTEXT_FILE: prep.contextFile,
        ULTRA_KANBAN_CLI: prep.cliPath,
        ULTRA_KANBAN_SKILL: prep.skillPath,
      },
      prompt: `Use exactly one MCP call: kanban_get_task with an empty arguments object. Do not call any other MCP tool, do not repeat the call, and do not use the supplied CLI. From that returned result report identity.agentId, identity.taskId, identity.workspaceId, scope.repoPaths, and scope.directories. Also report PASEO_AGENT_ID from your process environment. Return only this JSON shape: {"PASEO_AGENT_ID":"...","tool":"kanban_get_task","success":true,"identity":{"agentId":"...","taskId":"...","workspaceId":"..."},"scope":{"repoPaths":["..."],"directories":[{"repo":"...","directory":"..."}]}}. Do not make changes to any file or card.`,
    });
    result.createdAgentId = actor.id;
    if (actor.id !== prep.agentId) throw new Error('The created agent ID differs from the preallocated tools.prepare-session ID.');
    intent.createdAgentId = actor.id;
    intent.createdAt = new Date().toISOString();
    await writeFile(intentPath, JSON.stringify(intent, null, 2), { mode: 0o600 });
    result.reusedActor = false;
    result.modeAtCreation = 'full-access';
  }

  if (!result.createdAgentId) result.createdAgentId = result.preallocatedAgentId;
  const initialAgent = await findAgent(result.createdAgentId);
  result.agentAssociation = {
    idMatchesPreallocation: initialAgent?.agent?.id === result.preallocatedAgentId,
    workspaceMatchesCard: initialAgent?.agent?.workspaceId === workspaceId,
    archived: Boolean(initialAgent?.agent?.archivedAt),
    provider: initialAgent?.agent?.provider ?? null,
    model: initialAgent?.agent?.model ?? null,
    mode: initialAgent?.agent?.modeId ?? null,
  };
  if (!result.agentAssociation.idMatchesPreallocation || !result.agentAssociation.workspaceMatchesCard)
    throw new Error('Paseo SDK agent refresh does not match the preallocated ID and fixture workspace.');

  let report;
  if (result.reusedActor) {
    // Preserve the original first-turn record. Confirm its IDs before reusing it; do not
    // create a replacement actor or repeat kanban_get_task.
    const prior = JSON.parse(await readFile(firstTurnEvidence, 'utf8'));
    if (prior.createdAgentId !== result.createdAgentId || prior.preallocatedAgentId !== result.preallocatedAgentId)
      throw new Error('First-turn evidence does not match the existing actor; refusing reuse.');
    report = prior.agentReport;
    result.turnStatus = initialAgent.agent.status;
    result.turnError = prior.turnError ?? null;
    result.modeAtCreation = prior.modeAtCreation;
    result.firstTurnEvidenceReused = true;
    result.firstTurnBoardSummary = {
      before: {
        boardRevision: prior.beforeBoard?.boardRevision ?? null,
        taskStatus: prior.beforeBoard?.task?.status ?? null,
        taskRevision: prior.beforeBoard?.task?.revision ?? null,
      },
      after: {
        boardRevision: prior.afterBoard?.boardRevision ?? null,
        taskStatus: prior.afterBoard?.task?.status ?? null,
        taskRevision: prior.afterBoard?.task?.revision ?? null,
      },
    };
  } else {
    const finished = await actor.waitForFinish(240000);
    result.turnStatus = finished.status;
    result.turnError = finished.error ? safeError(new Error(finished.error), authorization) : null;
    report = parseAgentReport(finished.lastMessage);
    result.firstTurnEvidenceReused = false;
  }
  result.agentReport = report ? {
    PASEO_AGENT_ID: report.PASEO_AGENT_ID ?? null,
    tool: report.tool ?? null,
    success: report.success === true,
    identity: {
      agentId: report.identity?.agentId ?? null,
      taskId: report.identity?.taskId ?? null,
      workspaceId: report.identity?.workspaceId ?? null,
    },
    scope: {
      repoPaths: Array.isArray(report.scope?.repoPaths) ? report.scope.repoPaths : null,
      directories: Array.isArray(report.scope?.directories) ? report.scope.directories : null,
    },
  } : null;

  const access = await rpc('tools.access-state', { id: taskId, agentId: result.createdAgentId });
  result.toolAccess = {
    methods: access.methods,
    lastAction: access.lastAction,
    lastSuccessAt: access.lastSuccessAt,
    ready: access.ready,
  };
  const timeline = await actor.timeline.refetch({ limit: 100 });
  const timelineCalls = timeline.entries.map((entry) => entry.item).filter((item) => item.type === 'tool_call');
  result.toolTrace = timelineCalls.map((item) => {
    if (item.name === 'shell') {
      const command = item.detail?.command ?? '';
      return {
        name: item.name,
        status: item.status,
        exitCode: item.detail?.exitCode ?? null,
        cwdMatchesFixtureRoot: item.detail?.cwd === project.primaryPath,
        commandMentionsAgentIdEnv: /PASEO_AGENT_ID/.test(command),
        possibleFileOrRepoMutation: /\b(rm|mv|cp|touch|mkdir|writeFile|write_text)\b|git\s+(add|commit|checkout)|>>|\s>\s/i.test(command),
      };
    }
    return { name: item.name, status: item.status };
  });
  result.kanbanGetTaskCallCount = result.toolTrace.filter((item) => item.name === 'ultra-kanban.kanban_get_task').length;
  result.shellCallCount = result.toolTrace.filter((item) => item.name === 'shell').length;
  const finalBoard = await rpc('board.read', {});
  result.afterBoard = boardSummary(finalBoard, taskId);
  const filesAfter = await filesystemSnapshot(project.primaryPath);
  result.filesAfter = filesAfter;
  result.boardSha256AfterAudit = digest(await readFile('/Users/bofan.wang/.paseo/plugin-data/paseo-ultra-kanban/board.json'));
  const scope = result.agentReport?.scope;
  const expectedAgentId = result.createdAgentId;
  const actorPass = result.turnStatus === 'idle' && report?.PASEO_AGENT_ID === expectedAgentId &&
    report?.tool === 'kanban_get_task' && report?.success === true &&
    report?.identity?.agentId === expectedAgentId && report?.identity?.taskId === taskId &&
    report?.identity?.workspaceId === workspaceId &&
    Array.isArray(scope?.repoPaths) && scope.repoPaths.length === 1 && scope.repoPaths[0] === project.primaryPath &&
    Array.isArray(scope?.directories) && scope.directories.length === 1 &&
    scope.directories[0]?.repo === project.primaryPath && scope.directories[0]?.directory === project.primaryPath &&
    result.toolAccess.lastAction === 'get' && result.toolAccess.methods?.includes('mcp') &&
    result.kanbanGetTaskCallCount === 1 &&
    result.toolTrace.some((item) => item.name === 'ultra-kanban.kanban_get_task' && item.status === 'completed');
  const cardFieldsUnchanged = result.beforeBoard.task?.cardFieldsSha256 === result.afterBoard.task?.cardFieldsSha256 &&
    result.beforeBoard.task?.status === result.afterBoard.task?.status &&
    result.beforeBoard.task?.revision === result.afterBoard.task?.revision &&
    result.beforeBoard.task?.projectId === result.afterBoard.task?.projectId &&
    result.beforeBoard.task?.workspaceId === result.afterBoard.task?.workspaceId;
  const agentWriteEvents = result.afterBoard.taskEvents.filter((event) =>
    event.actor === 'agent' && ['status_changed', 'progress_reported'].includes(event.action),
  );
  const noStatusOrProgressWrite = agentWriteEvents.length === 0;
  const filesystemUnchanged = JSON.stringify(filesBefore) === JSON.stringify(filesAfter) &&
    filesAfter.rootLevelFiles === 0 && filesAfter.repos.every((repo) => repo.clean && repo.changedEntryCount === 0);
  const lifecycleEvents = result.afterBoard.taskEvents.filter((event) =>
    event.actor === 'system' && ['agent.turn_started', 'agent.turn_ended'].includes(event.action),
  );
  const firstTurnRevisionDelta = result.firstTurnBoardSummary?.after?.boardRevision - result.firstTurnBoardSummary?.before?.boardRevision;
  const firstTurnRevisionExplainedByLifecycleEvents = firstTurnRevisionDelta === lifecycleEvents.length;
  const originalTurnTaskStateUnchanged = result.firstTurnBoardSummary?.before?.taskStatus === result.firstTurnBoardSummary?.after?.taskStatus &&
    result.firstTurnBoardSummary?.before?.taskRevision === result.firstTurnBoardSummary?.after?.taskRevision;
  result.cardFieldsUnchanged = cardFieldsUnchanged;
  result.agentStatusOrProgressEvents = agentWriteEvents;
  result.filesystemUnchanged = filesystemUnchanged;
  result.boardBytesUnchangedDuringAudit = result.boardSha256BeforeAudit === result.boardSha256AfterAudit;
  result.lifecycleEvents = lifecycleEvents;
  result.firstTurnRevisionDelta = firstTurnRevisionDelta;
  result.firstTurnRevisionExplainedByLifecycleEvents = firstTurnRevisionExplainedByLifecycleEvents;
  result.originalTurnTaskStateUnchanged = originalTurnTaskStateUnchanged;
  result.checks.push({
    name: 'real-luna-kanban-get-task-root-scope-and-identity',
    status: actorPass ? 'PASS' : 'FAIL',
    agentIdMatchesPaseoAgentId: report?.PASEO_AGENT_ID === expectedAgentId,
    agentIdMatchesPreallocation: result.agentAssociation.idMatchesPreallocation,
    agentWorkspaceMatchesCard: result.agentAssociation.workspaceMatchesCard,
    toolAccessConfirmsMcpRead: result.toolAccess.lastAction === 'get' && result.toolAccess.methods?.includes('mcp'),
    kanbanGetTaskCalls: result.kanbanGetTaskCallCount,
    additionalShellCalls: result.shellCallCount,
    shellCallsOnlyReadAgentIdWithoutMutation: result.toolTrace.filter((item) => item.name === 'shell').every((item) =>
      item.commandMentionsAgentIdEnv && !item.possibleFileOrRepoMutation && item.exitCode === 0,
    ),
    reportedScopeOnlyFixtureRoot: Boolean(
      Array.isArray(scope?.repoPaths) && scope.repoPaths.length === 1 && scope.repoPaths[0] === project.primaryPath &&
      Array.isArray(scope?.directories) && scope.directories.length === 1 &&
      scope.directories[0]?.repo === project.primaryPath && scope.directories[0]?.directory === project.primaryPath,
    ),
  });
  result.checks.push({
    name: 'kanban-read-does-not-write-card-status-or-repository',
    status: cardFieldsUnchanged && noStatusOrProgressWrite && filesystemUnchanged && originalTurnTaskStateUnchanged && firstTurnRevisionExplainedByLifecycleEvents ? 'PASS' : 'FAIL',
    cardFieldsUnchanged,
    noAgentStatusOrProgressWriteEvents: noStatusOrProgressWrite,
    firstTurnTaskStatusAndRevisionUnchanged: originalTurnTaskStateUnchanged,
    filesystemUnchanged,
    lifecycleEvents,
    firstTurnBoardRevisionDelta: firstTurnRevisionDelta,
    firstTurnRevisionExplainedByLifecycleEvents,
    auditBoardRevisionUnchanged: result.beforeBoard.boardRevision === result.afterBoard.boardRevision,
    boardBytesUnchangedDuringAudit: result.boardBytesUnchangedDuringAudit,
  });
  result.repositoryFilesChanged = !filesystemUnchanged;
  result.status = result.checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL';
} catch (error) {
  result.status = 'FAIL';
  result.error = safeError(error, authorization);
} finally {
  result.completedAt = new Date().toISOString();
  await writeFile(outputFile, JSON.stringify(result, null, 2), { mode: 0o600 });
  await api.dispose().catch(() => {});
  await client.close().catch(() => {});
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
