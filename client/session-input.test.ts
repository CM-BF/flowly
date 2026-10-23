import { expect, test, vi } from "vitest";
import { composerKeys, createDraftBuffer, createDraftReporter, restoredDraft } from "./session-input";

function fakeTimers() {
  let queued: (() => void) | null = null;
  return {
    timers: { set: (fn: () => void) => ((queued = fn), 1), clear: () => (queued = null) },
    fire: () => {
      const fn = queued;
      queued = null;
      fn?.();
    },
  };
}

test("typing is reported after a pause; empty/non-empty flips are reported at once", () => {
  const sent: string[] = [];
  const t = fakeTimers();
  const r = createDraftReporter("", (text) => sent.push(text), 300, t.timers);
  r.change("h"); // empty → non-empty: immediately
  r.change("he");
  r.change("hello");
  expect(sent).toEqual(["h"]);
  t.fire();
  expect(sent).toEqual(["h", "hello"]);
  r.change(""); // non-empty → empty: immediately
  expect(sent).toEqual(["h", "hello", ""]);
});

test("our own reports are not outside changes; outside changes drop pending text", () => {
  const sent: string[] = [];
  const t = fakeTimers();
  const r = createDraftReporter("draft", (text) => sent.push(text), 300, t.timers);
  r.change("draft 2");
  r.flush();
  expect(r.external("draft 2")).toBe(false); // the parent echoing our report
  r.change("draft 23");
  expect(r.external("")).toBe(true); // cleared after send
  t.fire();
  expect(sent).toEqual(["draft 2"]); // the pending "draft 23" was dropped
});

test("the draft buffer keeps typed text until an outside change replaces it", () => {
  const b = createDraftBuffer("a");
  b.edit("abc");
  expect(b.read()).toBe("abc");
  b.set("");
  expect(b.read()).toBe("");
});

test("a failed send puts its text back before anything typed since", () => {
  expect(restoredDraft("fix the build", "")).toBe("fix the build");
  expect(restoredDraft("fix the build", "  ")).toBe("fix the build");
  expect(restoredDraft("fix the build", "and the tests")).toBe("fix the build\nand the tests");
});

// The session composer's keys, shared with the card's comment box (CARD-COMMENTS-SPEC §7.7).
test("phones and tablets: Return sends (the input submits instead of adding a line)", () => {
  for (const os of ["ios", "android"]) {
    const submit = vi.fn();
    const keys = composerKeys(os, submit);
    expect(keys).toMatchObject({ submitBehavior: "submit", returnKeyType: "send", blurOnSubmit: false });
    keys.onSubmitEditing({ nativeEvent: { text: "Ship it" } });
    expect(submit).toHaveBeenCalledWith(false);
    // Key presses are the browser's business; on a phone they never send.
    const preventDefault = vi.fn();
    keys.onKeyPress({ nativeEvent: { key: "Enter" }, preventDefault });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(preventDefault).not.toHaveBeenCalled();
  }
});

test("web: Enter sends, ⌘/Ctrl+Enter sends the other way, Shift+Enter adds a line", () => {
  const submit = vi.fn();
  const keys = composerKeys("web", submit);
  expect(keys.submitBehavior).toBe("newline");
  const press = (nativeEvent: Record<string, unknown>) => {
    const preventDefault = vi.fn();
    keys.onKeyPress({ nativeEvent, preventDefault });
    return preventDefault.mock.calls.length > 0;
  };
  expect(press({ key: "Enter" })).toBe(true);
  expect(submit).toHaveBeenLastCalledWith(false);
  expect(press({ key: "Enter", metaKey: true })).toBe(true);
  expect(submit).toHaveBeenLastCalledWith(true);
  expect(press({ key: "Enter", shiftKey: true })).toBe(false);
  expect(press({ key: "Enter", repeat: true })).toBe(true);
  expect(press({ key: "a" })).toBe(false);
  expect(submit).toHaveBeenCalledTimes(2);
  // The browser's submit event is not a second send.
  keys.onSubmitEditing({ nativeEvent: { text: "x" } });
  expect(submit).toHaveBeenCalledTimes(2);
});
