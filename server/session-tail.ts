import type { PaseoApi } from "@getpaseo/client";
import type { BoardStore } from "./store";
import { slimTimeline } from "../shared/session-tail";

/**
 * A card session's recent timeline without tool payloads (PERFORMANCE-SPEC §3).
 * Like `sessions.image`, the session must belong to the card's workspace.
 */
export class SessionTailService {
  constructor(readonly store: BoardStore) {}

  async tail(input: { taskId: string; agentId: string; limit: number }, paseo: PaseoApi) {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === input.taskId);
    if (!task) throw new Error("Task not found.");
    const handle = paseo.agents.ref(input.agentId);
    const response = await handle.timeline.refetch({ direction: "tail", limit: input.limit, projection: "projected" });
    if (response.error) throw new Error(response.error);
    const agent = response.agent ?? (await handle.refresh())?.agent;
    if (!agent || agent.workspaceId !== task.workspaceId)
      throw new Error("Session is unavailable or belongs to a different workspace.");
    return { entries: slimTimeline(response.entries) };
  }
}
