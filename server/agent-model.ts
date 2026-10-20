import type { PaseoApi } from "@getpaseo/client";

/** How long the turn_ended hook waits for the session's snapshot before it records no model. */
export const MODEL_LOOKUP_MS = 2_000;

type AgentModelFields = { provider?: string | null; model?: string | null; runtimeInfo?: { model?: string | null } | null };

/** `provider/model` of a session snapshot; empty when the snapshot names no model. */
export function modelId(agent: AgentModelFields): string {
  const model = agent.runtimeInfo?.model || agent.model || "";
  return model && agent.provider ? `${agent.provider}/${model}` : "";
}

/**
 * The session's model right now (WORKFLOW-INSIGHTS-SPEC §12.4). The hook's own agent has
 * only a provider, and a session can change model between turns, so each turn asks. A
 * failure or a slow answer yields "" and the turn is recorded without a model.
 */
export async function sessionModel(paseo: PaseoApi, agent: { id: string; provider: string }, timeoutMs = MODEL_LOOKUP_MS): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      paseo.agents.ref(agent.id).refresh(),
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs))),
    ]);
    const found = snapshot?.agent as AgentModelFields | undefined;
    return found ? modelId({ ...found, provider: found.provider || agent.provider }) : "";
  } catch {
    return "";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
