import { automationSessionRole } from "../shared/automation";
import type { Board } from "../shared/model";
import type { ToolIdentity } from "../shared/tools";
import { ToolError } from "./tool-error";

/** One authority check for normal writes, card creation and child-card management. */
export function assertActiveCardWriter(board: Board, identity: ToolIdentity) {
  const role = automationSessionRole(board, identity.agentId, identity.taskId)?.role;
  if (role === "retired") throw new ToolError("RETIRED_SESSION", "This session was replaced. Read the card; only append a handoff note or update your own running work. Continue work in the current session, or ask the user to explicitly take this session back.");
  if (role === "finalizing") throw new ToolError("FINALIZING", "This session is finalizing its handoff. Update the handoff, then end the turn; do not change the card, deliver or create sub-cards.");
}
