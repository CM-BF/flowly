import type {
  PaseoApi,
  PaseoWorkspaceAgentCreateOptions,
} from "@getpaseo/client";

// A failed transport response can hide a successfully created session.
export async function createPreparedSession(
  paseo: PaseoApi,
  workspaceId: string,
  options: PaseoWorkspaceAgentCreateOptions & { agentId: string },
) {
  const check = async () => {
    const found = await paseo.agents.ref(options.agentId).refresh();
    if (!found?.agent) return null;
    if (found.agent.workspaceId !== workspaceId || found.agent.archivedAt)
      throw new Error(
        "Prepared session belongs to another workspace or is archived.",
      );
    return found.agent;
  };
  const existing = await check();
  if (existing) return { id: existing.id, recovered: true };
  try {
    const created = await paseo.workspaces
      .ref(workspaceId)
      .agents.create(options);
    if (created.id !== options.agentId)
      throw new Error(
        "Paseo returned a different session ID; inspect the workspace before retrying.",
      );
    return { id: created.id, recovered: false };
  } catch (error) {
    const found = await check();
    if (found) return { id: found.id, recovered: true };
    throw error;
  }
}

export async function workspaceSession(
  paseo: PaseoApi,
  agentId: string,
  workspaceId: string,
  /** true: must be live; "restore": archived is allowed (sending restores it, as in Paseo). */
  writable: boolean | "restore" = false,
) {
  const result = await paseo.agents.ref(agentId).refresh();
  const agent = result?.agent;
  if (!agent || agent.workspaceId !== workspaceId)
    throw new Error(
      "Session is unavailable or belongs to a different workspace.",
    );
  if (writable === true && agent.archivedAt)
    throw new Error("This session is archived.");
  if (writable && agent.providerUnavailable)
    throw new Error("This session's provider is unavailable.");
  return agent;
}

export async function sendCardInstruction(
  paseo: PaseoApi,
  task: { id: string; workspaceId: string },
  agentId: string,
  contextRead: (input: {
    id: string;
  }) => Promise<{ available: boolean; reason: string; context: string }>,
  instruction: string,
  mode: "steer" | "interrupt" = "steer",
) {
  const [actor, scope] = await Promise.all([
    workspaceSession(paseo, agentId, task.workspaceId, "restore"),
    contextRead({ id: task.id }),
  ]);
  if (!scope.available) throw new Error(scope.reason);
  await paseo.agents
    .ref(agentId)
    .send(
      instruction,
      actor.status === "running" || actor.status === "initializing"
        ? { activeTurnBehavior: mode }
        : {},
    );
}

/**
 * Starts a Kanban-managed session for a card (MCP tools + skill + card
 * context), the same configuration as the drawer's "Start session". A fixed
 * operation ID per card launch makes a retried request reuse the prepared
 * agent instead of creating a second one.
 */
export async function launchKanbanSession(
  deps: {
    paseo: PaseoApi;
    contextRead: (input: { id: string }) => Promise<{ available: boolean; reason: string; context: string }>;
    prepare: (input: { id: string; operationId: string }) => Promise<{
      agentId: string;
      instructions: string;
      contextFile: string;
      cliPath: string;
      skillPath: string;
      mcp: { type: "http"; url: string; headers: Record<string, string> };
    }>;
  },
  task: { id: string; title: string; workspaceId: string },
  choice: { provider: string; model: string; mode: string; title?: string; prompt?: string; operationId: string },
) {
  const scope = await deps.contextRead({ id: task.id });
  if (!scope.available) throw new Error(scope.reason);
  const preparation = await deps.prepare({ id: task.id, operationId: choice.operationId });
  return createPreparedSession(deps.paseo, task.workspaceId, {
    agentId: preparation.agentId,
    idempotencyKey: `ultra-kanban-session:${preparation.agentId}`,
    config: {
      provider: `${choice.provider}/${choice.model}`,
      systemPrompt: preparation.instructions,
      mcpServers: { "ultra-kanban": preparation.mcp },
      ...(choice.mode ? { modeId: choice.mode } : {}),
    },
    env: {
      ULTRA_KANBAN_CONTEXT_FILE: preparation.contextFile,
      ULTRA_KANBAN_CLI: preparation.cliPath,
      ULTRA_KANBAN_SKILL: preparation.skillPath,
    },
    title: choice.title?.trim() || task.title,
    labels: { "ultra-kanban-task": task.id },
    prompt: choice.prompt?.trim() || undefined,
  });
}
