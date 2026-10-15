/**
 * Running-session send behaviour, aligned with Paseo's app setting
 * `sendBehavior` (interrupt | steer | queue, default steer). Plugins cannot read
 * that client-local setting, so the board keeps its own copy with the same
 * meaning and keys: Enter uses the default, Cmd/Ctrl+Enter the alternative.
 */
export type SendBehavior = "steer" | "interrupt" | "queue";
export const sendBehaviors: readonly SendBehavior[] = ["steer", "queue", "interrupt"];
export const sendBehaviorText: Record<SendBehavior, { label: string; detail: string }> = {
  steer: { label: "Steer", detail: "Enter steers the active turn. ⌘/Ctrl+Enter queues." },
  queue: { label: "Queue", detail: "Enter queues until the turn ends. ⌘/Ctrl+Enter sends now." },
  interrupt: { label: "Interrupt", detail: "Enter interrupts, then sends. ⌘/Ctrl+Enter queues." },
};

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
