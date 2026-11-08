import type { PaseoApi } from "@getpaseo/client";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { ToolServer } from "./tool-server";
import { logFailure } from "./error-report";

/**
 * The `before("agent.session_open")` hook: a Kanban-managed interactive
 * session gets its CLI environment and, at launch only, the `flowly` MCP
 * server (PASEO-SESSION-TOOLS-SPEC §4). Never throws: a failure here would
 * keep the session from opening, so it is logged and the request passes on.
 */
export async function openKanbanSession(
  request: PluginSessionOpenRequest,
  tools: Pick<ToolServer, "attach" | "sessionLaunch">,
  directory: string,
  paseo: PaseoApi,
): Promise<PluginSessionOpenRequest | void> {
  try {
    tools.attach(paseo);
    if (request.purpose !== "interactive") return;
    // Flowly's own helper sessions are never card sessions, even in a card's project (AUTOMATION-SPEC §5.4, §5.5):
    // the acceptance author and the tournament planner and candidates get no card identity or tools. The judge does.
    if (request.labels["flowly-acceptance"] || (request.labels["flowly-tournament"] && request.labels["flowly-tournament"] !== "judge")) return;
    const launch = await tools.sessionLaunch(request.agentId, request.workspaceId, paseo);
    if (!launch) return;
    return {
      ...request,
      // No context file: an adaptive implementer, which gets no Flowly CLI, skill or context (AUTOMATION-SPEC §5.6.1).
      ...(launch.contextFile
        ? {
            env: {
              ...request.env,
              FLOWLY_CONTEXT_FILE: launch.contextFile,
              FLOWLY_CLI: directory + "/flowly.mjs",
              FLOWLY_SKILL: directory + "/SKILL.md",
            },
          }
        : {}),
      // Launch only: Paseo never saves it in the agent config.
      ...(launch.mcp ? { mcpServers: { ...request.mcpServers, flowly: launch.mcp } } : {}),
    };
  } catch (e) {
    logFailure("Kanban session tools unavailable:", e, request.agentId);
  }
}
