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
    read() { return value; },
    clear(expected: string) { if (value === expected) value = ""; },
  };
}
