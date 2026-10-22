import { jobOf, type AutomationJob } from "../shared/automation";
import type { Project, Task, BoardEvent } from "../shared/model";
import { openQuestion, silentTurn } from "../shared/progress";
import { pendingRequests } from "../shared/permission-question";
import { isDismissed, sessionSignalKeys, type AttentionDismissal } from "../shared/attention-dismiss";
import {
  sessionAttention,
  type AttentionAgent,
  type SessionReadReceipt,
} from "../shared/session-attention";

type Agent = AttentionAgent & { updatedAt?: string; createdAt?: string };

export type AttentionItem = {
  task: Task;
  project: Project;
  permissions: number;
  errors: number;
  unread: number;
  /** Open agent questions awaiting your reply (AUTO-STATUS M1). */
  questions: number;
  automation?: boolean;
  /** Sessions waiting on an agent question (AskUserQuestion), answerable in the session. */
  asks: number;
  /** Unread sessions whose last turn ended without any Kanban report (M2). */
  silent: number;
  /** Set when exactly one session needs attention, so it can be opened directly. */
  sessionId: string | null;
  updatedAt: string;
  /** What the card is waiting on now, one key per concrete thing (ATTENTION-DISMISS-SPEC §2.2). */
  signals: string[];
  /** Dismissed from Attention and nothing new since: not counted, listed under Dismissed. */
  dismissed: boolean;
};

/** Cards across all active projects whose sessions need a human. Running alone does not count. */
export function attentionItems(
  board: { projects: Project[]; tasks: Task[]; events: BoardEvent[]; automation?: AutomationJob[]; attentionDismissals?: readonly AttentionDismissal[] },
  agents: readonly Agent[],
  receipts: readonly SessionReadReceipt[],
  readUnavailable: boolean,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const task of board.tasks) {
    if (task.archivedAt) continue;
    const project = board.projects.find((p) => p.id === task.projectId);
    if (!project || project.archivedAt) continue;
    const own = board.events.filter((e) => e.taskId === task.id);
    const flagged = agents
      .filter((a) => a.workspaceId === task.workspaceId && !a.archivedAt)
      .map((agent) => ({
        agent,
        state: sessionAttention(agent, task.id, receipts, board.events),
      }))
      .map(({ agent, state }) => {
        const unread = !readUnavailable && state.unread && !state.permission && !state.error;
        const question = openQuestion(own, agent.id);
        return {
          agent,
          signals: sessionSignalKeys({
            agent,
            questionEventId: question?.id || null,
            requestIds: state.permission ? pendingRequests(agent).map((r) => r.id) : [],
            permission: state.permission,
            error: state.error,
            unread,
            token: state.token,
            manualUnread: state.manualUnread,
          }),
          permission: state.permission && !state.question,
          error: state.error,
          question: state.question || !!question,
          asks: state.question,
          unread,
          silent: unread && silentTurn(task, own, agent.id),
        };
      })
      .filter((s) => s.permission || s.error || s.question || s.unread);
    const job = jobOf({ automation: board.automation ?? [] }, task.id);
    const automation = !!job && !["done", "cancelled"].includes(task.status) && (job.state === "needs_human" || job.state === "failed" || (task.status === "in_review" && job.state === "delivered" && (job.verdict === "incomplete" || job.code === "review_rounds")));
    if (!flagged.length && !automation) continue;
    const signals = [...flagged.flatMap((s) => s.signals), ...(automation ? [`automation:${job!.generation}:${job!.state}:${job!.updatedAt}`] : [])];
    items.push({
      task,
      project,
      automation,
      permissions: flagged.filter((s) => s.permission).length,
      errors: flagged.filter((s) => s.error).length,
      unread: flagged.filter((s) => s.unread && !s.question).length,
      questions: flagged.filter((s) => s.question).length,
      asks: flagged.filter((s) => s.asks).length,
      silent: flagged.filter((s) => s.silent && !s.question).length,
      sessionId: flagged.length === 1 ? flagged[0].agent.id : null,
      updatedAt: automation ? job!.updatedAt : flagged
        .map((s) => s.agent.updatedAt || "")
        .sort()
        .at(-1) || "",
      signals,
      dismissed: isDismissed(signals, board.attentionDismissals?.find((d) => d.taskId === task.id)),
    });
  }
  return items.sort(
    (a, b) =>
      Number(!!(b.permissions || b.errors || b.questions)) -
        Number(!!(a.permissions || a.errors || a.questions)) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

type AttentionBoard = Parameters<typeof attentionItems>[0];

type AttentionSources = {
  board: AttentionBoard | null | undefined;
  agents: readonly Agent[] | null | undefined;
  receipts: readonly SessionReadReceipt[];
  readUnavailable: boolean;
};

/** Every card needing a human, dismissed ones included; null while unavailable. */
export function allAttentionFromSources(sources: AttentionSources): AttentionItem[] | null {
  if (!sources.board || !sources.agents) return null;
  return attentionItems(sources.board, sources.agents, sources.receipts, sources.readUnavailable);
}

/**
 * The one counting rule shared by the board Attention button and the sidebar badge:
 * cards needing a human that were not dismissed (ATTENTION-DISMISS-SPEC §3.2).
 * Returns null while the board or agent list is unavailable (loading or failed).
 * Read receipts that are pending or failed only drop finished-but-unread sessions.
 */
export function attentionFromSources(sources: AttentionSources): AttentionItem[] | null {
  return allAttentionFromSources(sources)?.filter((i) => !i.dismissed) ?? null;
}

/** Badge text for a count; null hides the badge. */
export function attentionBadgeText(count: number | null | undefined): string | null {
  if (!count || count < 0) return null;
  return count > 99 ? "99+" : String(count);
}

/** Board screen params that open the Needs attention modal; the token makes each press distinct. */
export function attentionScreenParams(token: string) {
  return { view: "attention", open: token };
}

/** The open token when params ask for the Needs attention modal, else null. */
export function attentionOpenToken(params: Record<string, string> | undefined): string | null {
  return params?.view === "attention" && params.open ? params.open : null;
}

/** Provider/model/mode of the most recently created session in any card workspace. */
export function lastSessionSettings(
  agents: readonly {
    workspaceId?: string | null;
    archivedAt?: string | null;
    createdAt: string;
    provider: string;
    model: string | null;
    currentModeId?: string | null;
    thinkingOptionId?: string | null;
  }[],
  workspaceIds: ReadonlySet<string>,
) {
  const latest = agents
    .filter((a) => !a.archivedAt && !!a.workspaceId && workspaceIds.has(a.workspaceId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest
    ? { provider: latest.provider, model: latest.model || "", mode: latest.currentModeId || "", thinking: latest.thinkingOptionId || "" }
    : null;
}
