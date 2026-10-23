import { msg } from "../shared/i18n";
/**
 * Running-session send behaviour, aligned with Paseo's app setting
 * `sendBehavior` (interrupt | steer | queue, default steer). Plugins cannot read
 * that client-local setting, so the board keeps its own copy with the same
 * meaning and keys: Enter uses the default, Cmd/Ctrl+Enter the alternative.
 */
export type SendBehavior = "steer" | "interrupt" | "queue";
export const sendBehaviors: readonly SendBehavior[] = ["steer", "queue", "interrupt"];
export const sendBehaviorText: Record<SendBehavior, { label: string; detail: string }> = {
  steer: { label: msg("Steer"), detail: msg("Enter steers the active turn. ⌘/Ctrl+Enter queues.") },
  queue: { label: msg("Queue"), detail: msg("Enter queues until the turn ends. ⌘/Ctrl+Enter sends now.") },
  interrupt: { label: msg("Interrupt"), detail: msg("Enter interrupts, then sends. ⌘/Ctrl+Enter queues.") },
};

/** The board's "When running" setting, steer when unset (Paseo's default). */
export const preferredSend = (values?: { sendBehavior?: SendBehavior } | null): SendBehavior => values?.sendBehavior || "steer";

export type SendAction =
  | { kind: "send"; activeTurnBehavior?: "steer" | "interrupt" }
  | { kind: "queue" };

export function resolveSend(
  preferred: SendBehavior,
  state: { running: boolean; alternate: boolean; pendingPermission: boolean },
): SendAction {
  if (!state.running) return { kind: "send" };
  let behavior: SendBehavior = state.alternate
    ? preferred === "queue"
      ? "steer"
      : "queue"
    : preferred;
  // Paseo: a queued message cannot wait behind a permission prompt.
  if (behavior === "queue" && state.pendingPermission) behavior = "interrupt";
  return behavior === "queue" ? { kind: "queue" } : { kind: "send", activeTurnBehavior: behavior };
}
