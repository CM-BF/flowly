import { z } from "zod";

/** A provider + model (+ optional reasoning effort) a new session starts with (MODEL-DEFAULTS-SPEC). */
export const agentModelSchema = z.strictObject({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  /** Reasoning option id of the model; absent keeps the model's own default. */
  thinking: z.string().min(1).max(100).optional(),
  /** Empty string explicitly selects provider default; missing inherits legacy settings. */
  modeId: z.string().max(100).optional(),
  featureValues: z.record(z.string().max(100), z.union([z.boolean(), z.string().max(200)])).optional(),
});
export type AgentModel = z.infer<typeof agentModelSchema>;

/** Where a model default comes from, strongest first: the project's, then the global one. */
export type AgentModelSource = "project" | "global";

type WithAgentModel = { agentModel?: AgentModel | null } | null | undefined;

/** The model new sessions in `project` start with: the project's own default wins over the global one; none means "follow the latest session". */
export function effectiveAgentModel(project: WithAgentModel, global: AgentModel | null | undefined): { model: AgentModel; source: AgentModelSource } | null {
  if (project?.agentModel) return { model: project.agentModel, source: "project" };
  if (global) return { model: global, source: "global" };
  return null;
}

type LastSession = { provider: string; model: string; mode: string; thinking?: string } | null | undefined;

/**
 * Starting point of the session form: the chosen default replaces provider,
 * model and reasoning of the latest session; the permission mode is only kept
 * when it belongs to the same provider.
 */
export function startingAgent(last: LastSession, chosen: AgentModel | null | undefined) {
  if (!chosen) return last ?? null;
  return {
    provider: chosen.provider,
    model: chosen.model,
    mode: chosen.modeId ?? (last && last.provider === chosen.provider ? last.mode : ""),
    ...(chosen.featureValues ? { featureValues: chosen.featureValues } : {}),
    thinking: chosen.thinking ?? "",
  };
}

/** Flat host-setting values (`defaultProvider`/`defaultModel`/`defaultThinking`) as a model, or null while incomplete. */
export function agentModelFromValues(values: { defaultProvider?: string; defaultModel?: string; defaultThinking?: string } | null | undefined): AgentModel | null {
  if (!values?.defaultProvider || !values.defaultModel) return null;
  return { provider: values.defaultProvider, model: values.defaultModel, ...(values.defaultThinking ? { thinking: values.defaultThinking } : {}) };
}

/** Role overrides inherit only execution settings from a project using the same provider. */
export function executionModel(model: AgentModel, project: AgentModel | null | undefined, legacyMode?: string): AgentModel {
  const inherited = project?.provider === model.provider ? project : undefined;
  const modeId = model.modeId ?? inherited?.modeId ?? legacyMode;
  const featureValues = { ...inherited?.featureValues, ...model.featureValues };
  return { ...model, ...(modeId !== undefined ? { modeId } : {}), ...(Object.keys(featureValues).length ? { featureValues } : {}) };
}
