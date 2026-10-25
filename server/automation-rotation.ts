import { randomUUID } from "node:crypto";
import type { SessionPolicyFacts } from "../shared/session-measurement";
import type { AgentModel } from "../shared/agent-defaults";
import type { AutomationJob, AutomationRotation } from "../shared/automation-schema";

/** Card persistence/capture are injected; this module does not create a second dispatcher. */
export type RotationContext = {
  taskId: string; rotationId: string; role: AutomationRotation["role"]; fromAgentId: string;
  reason: AutomationRotation["reason"]; carry: AutomationRotation["carry"];
  model?: AgentModel; allowFinalize: boolean; gap?: string; continuation?: { id: string; text: string; fresh: string; kind?: string };
};
export type AutomationHandoffBridge = {
  measure?(context: { taskId: string; agentId: string }): Promise<SessionPolicyFacts>;
  prepare(context: RotationContext): Promise<{ finalize?: string }>;
  seal(context: RotationContext): Promise<{ prompt: string; revision?: number }>;
  committed?(context: RotationContext & { toAgentId: string }): Promise<void>;
  abandoned?(context: RotationContext): Promise<void>;
};

export const rotationContext = (job: AutomationJob, allowFinalize = false): RotationContext => {
  const r = job.rotation!;
  return { taskId: job.taskId, rotationId: r.id, role: r.role, fromAgentId: r.fromAgentId, reason: r.reason, carry: r.carry, model: r.model, allowFinalize, gap: r.gap, continuation: r.carry.continuation };
};

/** Begin before deleting either identity: carry and the previous owner survive every crash point. */
export function beginRotation(job: AutomationJob, reason: AutomationRotation["reason"], now: string, options: { forced: boolean; bytes?: number; model?: AgentModel }) {
  if (job.rotation || !job.instruction) return;
  const role = job.instruction.role;
  const fromAgentId = role === "reviewer" ? job.reviewerId : job.implementerId;
  if (!fromAgentId) return;
  const model = options.model ?? job.sessionModels?.[role] ?? (role === "implementer" ? job.launchModel : undefined);
  job.rotation = {
    id: `rotation:${job.taskId}:${job.generation}:${role}:${randomUUID()}`,
    role, fromAgentId, reason, stage: "requested", forced: options.forced,
    carry: { ...job.instruction }, at: now,
    ...(options.bytes === undefined ? {} : { bytes: options.bytes }),
    ...(model ? { model } : {}),
  };
}

/** Retirement and deletion of the old role happen in the same board transaction. */
export function retireRotation(job: AutomationJob, now: string) {
  const r = job.rotation!;
  job.retired = [...(job.retired ?? []).filter(s => s.agentId !== r.fromAgentId), { agentId: r.fromAgentId, role: r.role, at: now, reason: r.reason }].slice(-50);
  if (r.role === "reviewer") {
    job.reviewers = [...(job.reviewers ?? []).filter(id => id !== r.fromAgentId), r.fromAgentId].slice(-20);
    delete job.reviewerId;
  } else delete job.implementerId;
  if (job.historyWarning?.agentId === r.fromAgentId) delete job.historyWarning;
  job.nudges = 0; job.failures = 0; job.cooldowns = 0;
  delete job.code; delete job.detail; delete job.retryAt;
  job.updatedAt = now;
  r.stage = "creating";
  // The existing prepared-session operation/idempotency path creates exactly this successor.
  job.pendingOp = `${r.id}:create`;
  job.pendingRole = r.role;
}

/** Only explicit failure of a safe soft replacement may restore the old owner. */
export function rollbackRotation(job: AutomationJob, now: string) {
  const r = job.rotation;
  if (!r || r.forced) return false;
  if (r.role === "reviewer") job.reviewerId = r.fromAgentId;
  else job.implementerId = r.fromAgentId;
  job.retired = job.retired?.filter(s => s.agentId !== r.fromAgentId);
  job.reviewers = job.reviewers?.filter(id => id !== r.fromAgentId);
  job.role = r.role; job.state = r.role === "reviewer" ? "reviewing" : "working";
  job.instruction = { ...r.carry };
  job.rotationAbandoned = { instructionId: r.carry.id, at: now };
  job.failures = 0; job.cooldowns = 0; job.nudges = 0;
  delete job.pendingOp; delete job.pendingRole; delete job.unconfirmed; delete job.unconfirmedStart;
  delete job.retryAt; delete job.code; delete job.detail; delete job.rotation;
  job.updatedAt = now;
  return true;
}
