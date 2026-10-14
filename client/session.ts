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
  writable = false,
) {
  const result = await paseo.agents.ref(agentId).refresh();
  const agent = result?.agent;
  if (!agent || agent.workspaceId !== workspaceId)
    throw new Error(
      "Session is unavailable or belongs to a different workspace.",
    );
  if (writable && agent.archivedAt)
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
  mode: "steer" | "interrupt",
) {
  const [actor, scope] = await Promise.all([
    workspaceSession(paseo, agentId, task.workspaceId, true),
    contextRead({ id: task.id }),
  ]);
  if (!scope.available) throw new Error(scope.reason);
  await paseo.agents
    .ref(agentId)
    .send(
      instruction,
      actor.status === "running" ? { activeTurnBehavior: mode } : {},
    );
}
