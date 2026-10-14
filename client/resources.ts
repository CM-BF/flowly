import type { PaseoApi, PaseoAgent } from "@getpaseo/client";

export async function listAgents(
  paseo: PaseoApi,
  workspaceId?: string,
  includeArchived = !!workspaceId,
): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({
      filter: { includeArchived },
      page: { limit: 200, cursor },
    });
    agents.push(
      ...page.entries
        .map((e) => e.agent)
        .filter((a) => !workspaceId || a.workspaceId === workspaceId),
    );
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return agents;
}
