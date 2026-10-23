/** Extra nativeEvent fields supplied by React Native Web's public onKeyPress. */
export type ComposerKey = {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
};

/** Enter submits; Cmd/Ctrl+Enter submits with the alternate running behaviour (Paseo). */
export function composerEnterAction(event: ComposerKey): "submit" | "alternate" | "suppress" | "native" {
  if (event.key !== "Enter" || event.shiftKey || event.altKey ||
      event.isComposing || event.keyCode === 229) return "native";
  if (event.repeat) return "suppress";
  return event.ctrlKey || event.metaKey ? "alternate" : "submit";
}

/**
 * The session composer's keys as TextInput props, for any composer that sends
 * like it (the card's comment box too). Web handles the keys itself: Enter
 * sends, ⌘/Ctrl+Enter sends with the alternate running behaviour, Shift+Enter
 * adds a line. Native: Return sends through onSubmitEditing (modifiers are not
 * reported there).
 */
export function composerKeys(os: string, submit: (alternate: boolean) => void) {
  const web = os === "web";
  return {
    blurOnSubmit: false,
    submitBehavior: web ? ("newline" as const) : ("submit" as const),
    returnKeyType: "send" as const,
    onKeyPress(event: { nativeEvent: unknown; preventDefault(): void }) {
      if (!web) return;
      const action = composerEnterAction(event.nativeEvent as ComposerKey);
      if (action === "native") return;
      event.preventDefault();
      if (action === "submit" || action === "alternate") submit(action === "alternate");
    },
    onSubmitEditing(event: { nativeEvent: object }) {
      if (web) return;
      if (composerEnterAction({ ...event.nativeEvent, key: "Enter" }) === "submit") submit(false);
    },
  };
}

/** Keep input changes until their controlled parent props acknowledge them. */
export function createDraftBuffer(initial: string) {
  let acknowledged = initial;
  let value = initial;
  return {
    sync(prop: string) {
      if (prop !== acknowledged) {
        acknowledged = prop;
        value = prop;
      }
    },
    edit(text: string) { value = text; },
    /** An outside change (restore, clear after send) replaces the text. */
    set(text: string) { acknowledged = text; value = text; },
    read() { return value; },
    clear(expected: string) { if (value === expected) value = ""; },
  };
}

/**
 * Batches draft reports from an input that owns its text (native). Reports at
 * once when the text turns empty or non-empty (send-button state), otherwise
 * after `delay` of quiet. `external(text)` returns true when a parent value is
 * an outside change (not one of ours) and drops any pending report.
 */
export function createDraftReporter(
  initial: string,
  report: (text: string) => void,
  delay = 300,
  timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
) {
  let reported = initial;
  let pending: string | null = null;
  let timer: unknown = null;
  const cancel = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const flush = () => {
    cancel();
    if (pending === null) return;
    reported = pending;
    pending = null;
    report(reported);
  };
  return {
    change(text: string) {
      pending = text;
      if (!!text.trim() !== !!reported.trim()) return flush();
      cancel();
      timer = timers.set(flush, delay);
    },
    flush,
    external(parent: string) {
      if (parent === reported) return false;
      reported = parent;
      pending = null;
      cancel();
      return true;
    },
  };
}

/** The text of a send that failed after the composer was cleared, put back before anything typed since. */
export function restoredDraft(sent: string, typed: string) {
  return typed.trim() ? `${sent}\n${typed}` : sent;
}
