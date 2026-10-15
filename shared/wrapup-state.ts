import type { BoardEvent } from "./model";

const wrapActions = new Set(["wrapped_up", "workspace_auto_archived"]);

/**
 * The card's latest wrap-up, while it still applies: not followed by a
 * workspace restore or a move back to an unfinished status. Null otherwise.
 */
export function currentWrapup(events: readonly BoardEvent[], taskId: string): BoardEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.taskId !== taskId) continue;
    if (wrapActions.has(e.action)) return e;
    if (e.action === "workspace_restored") return null;
    if (e.action === "status_changed" && e.to && e.to !== "done" && e.to !== "cancelled") return null;
  }
  return null;
}
