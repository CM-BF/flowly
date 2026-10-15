import { expect, test } from "vitest";
import { createDraftBuffer, createDraftReporter, restoredDraft } from "./session-input";

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
