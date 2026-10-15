import { describe, expect, test } from "vitest";
import { composerEnterAction, createDraftBuffer } from "../../../../client/session-input";

describe("composerEnterAction", () => {
  test("plain Enter submits and repeat is suppressed", () => {
    expect(composerEnterAction({ key: "Enter" })).toBe("submit");
    expect(composerEnterAction({ key: "Enter", repeat: true })).toBe("suppress");
  });
  test("Cmd/Ctrl+Enter submits with the alternate running behaviour (Paseo parity)", () => {
    expect(composerEnterAction({ key: "Enter", ctrlKey: true })).toBe("alternate");
    expect(composerEnterAction({ key: "Enter", metaKey: true })).toBe("alternate");
    expect(composerEnterAction({ key: "Enter", metaKey: true, isComposing: true })).toBe("native");
  });
  test.each([
    { key: "Enter", shiftKey: true }, { key: "Enter", altKey: true },
    { key: "Enter", isComposing: true }, { key: "Enter", keyCode: 229 },
    { key: "a" }, { key: "Enter", shiftKey: true, repeat: true },
  ])("preserves host handling for %#", (event) => {
    expect(composerEnterAction(event)).toBe("native");
  });
});

describe("createDraftBuffer", () => {
  test("reads synchronous edits before parent rerender and clears only the submitted snapshot", () => {
    const draft = createDraftBuffer("initial");
    draft.edit("latest before render");
    expect(draft.read()).toBe("latest before render");
    draft.clear("latest before render");
    expect(draft.read()).toBe("");
  });
  test("preserves a later edit and ignores stale parent props until acknowledged", () => {
    const draft = createDraftBuffer("first");
    draft.edit("submitted");
    draft.edit("newer while pending");
    draft.clear("submitted");
    draft.sync("first");
    expect(draft.read()).toBe("newer while pending");
    draft.sync("newer while pending");
    expect(draft.read()).toBe("newer while pending");
  });
});
