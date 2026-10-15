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

export type QueuedMessage = { id: string; text: string };
type Listener = () => void;

/** Per-session queue shared by every board surface in this app session. */
export function createSendQueue() {
  const queues = new Map<string, QueuedMessage[]>();
  const listeners = new Set<Listener>();
  let sequence = 0;
  const emit = () => listeners.forEach((l) => l());
  const empty: QueuedMessage[] = [];
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get(sessionId: string) {
      return queues.get(sessionId) || empty;
    },
    sessions() {
      return [...queues.keys()];
    },
    push(sessionId: string, text: string) {
      queues.set(sessionId, [...this.get(sessionId), { id: `q${++sequence}`, text }]);
      emit();
    },
    remove(sessionId: string, id: string) {
      const next = this.get(sessionId).filter((m) => m.id !== id);
      if (next.length) queues.set(sessionId, next);
      else queues.delete(sessionId);
      emit();
    },
    /** Take the oldest message for sending; call restore() if the send fails. */
    take(sessionId: string) {
      const [first, ...rest] = this.get(sessionId);
      if (!first) return null;
      if (rest.length) queues.set(sessionId, rest);
      else queues.delete(sessionId);
      emit();
      return first;
    },
    restore(sessionId: string, message: QueuedMessage) {
      queues.set(sessionId, [message, ...this.get(sessionId)]);
      emit();
    },
  };
}
export const sendQueue = createSendQueue();
