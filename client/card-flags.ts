import { slotStates, type AutomationJob } from "../shared/automation";
import { cardFlag, statusFlags, type CardState, type CardTree } from "../shared/card-tree";
import type { Task } from "../shared/model";

/** What a card's flags need from an Attention item (client/attention.ts `AttentionItem`). */
export type FlagAttention = {
  task: Pick<Task, "id">;
  dismissed: boolean;
  questions: number;
  permissions: number;
  asks: number;
  automation?: boolean;
  errors: number;
  unread: number;
};
export type FlagAgent = { workspaceId?: string | null; status: string; archivedAt?: string | null };

/**
 * Per-card flag bits for the roll-up and the Card tree (CARD-TREE-SPEC §2.4): the board-derived ones
 * from `statusFlags`, plus NEEDS (an undismissed question, approval or automation that needs a person),
 * ERROR, UNREAD, and ACTIVE (a running or starting session in its workspace, or a job holding a slot).
 * A card dismissed from Attention adds none of NEEDS, ERROR or UNREAD until something new happens.
 */
export function cardFlags(input: {
  tree: Pick<CardTree, "ids" | "blockers">;
  tasksById: ReadonlyMap<string, CardState & Pick<Task, "workspaceId">>;
  jobsById: ReadonlyMap<string, Pick<AutomationJob, "taskId" | "state">>;
  attention: readonly FlagAttention[];
  agents: readonly FlagAgent[];
}): Map<string, number> {
  const flags = statusFlags(input.tree, input.tasksById, input.jobsById);
  const add = (id: string, bit: number) => {
    const f = flags.get(id);
    if (f !== undefined) flags.set(id, f | bit);
  };
  for (const item of input.attention) {
    if (item.dismissed) continue;
    if (item.questions || item.permissions || item.asks || item.automation) add(item.task.id, cardFlag.needs);
    if (item.errors) add(item.task.id, cardFlag.error);
    if (item.unread) add(item.task.id, cardFlag.unread);
  }
  const moving = new Set<string>();
  for (const a of input.agents) if (a.workspaceId && !a.archivedAt && (a.status === "running" || a.status === "initializing")) moving.add(a.workspaceId);
  for (const id of input.tree.ids) {
    const task = input.tasksById.get(id);
    const job = input.jobsById.get(id);
    if ((task?.workspaceId && moving.has(task.workspaceId)) || (job && slotStates.includes(job.state))) add(id, cardFlag.active);
  }
  return flags;
}
