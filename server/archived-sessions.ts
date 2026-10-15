import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { BoardStore } from "./store";
import { isSummarizer } from "../shared/summary";

/**
 * Archived sessions of a card's workspace (PERFORMANCE-SPEC §3). The SDK has
 * no workspace filter, so finding them means paging every agent on the host,
 * archived included: cheap on the daemon, hundreds of KB per read for a phone.
 */
export class ArchivedSessionsService {
  constructor(readonly store: BoardStore) {}

  async list(taskId: string, paseo: PaseoApi): Promise<PaseoAgent[]> {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("Task not found.");
    const found: PaseoAgent[] = [];
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, cursor } });
      for (const { agent } of page.entries)
        if (agent.workspaceId === task.workspaceId && agent.archivedAt && !isSummarizer(agent)) found.push(agent);
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return found;
  }
}
