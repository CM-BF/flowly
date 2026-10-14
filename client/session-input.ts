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

export function composerEnterAction(event: ComposerKey): "submit" | "suppress" | "native" {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ||
      event.isComposing || event.keyCode === 229) return "native";
  return event.repeat ? "suppress" : "submit";
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
