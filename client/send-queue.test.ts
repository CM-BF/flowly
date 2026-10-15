import { expect, test } from "vitest";
import { resolveSend } from "./send-queue";

test("idle sessions always send directly", () => {
  for (const p of ["steer", "queue", "interrupt"] as const)
    expect(resolveSend(p, { running: false, alternate: true, pendingPermission: false })).toEqual({ kind: "send" });
});

test("running: Enter uses the preference, Cmd/Ctrl+Enter the Paseo alternative", () => {
  const run = (p: "steer" | "queue" | "interrupt", alternate: boolean, pendingPermission = false) =>
    resolveSend(p, { running: true, alternate, pendingPermission });
  expect(run("steer", false)).toEqual({ kind: "send", activeTurnBehavior: "steer" });
  expect(run("steer", true)).toEqual({ kind: "queue" });
  expect(run("interrupt", false)).toEqual({ kind: "send", activeTurnBehavior: "interrupt" });
  expect(run("interrupt", true)).toEqual({ kind: "queue" });
  expect(run("queue", false)).toEqual({ kind: "queue" });
  expect(run("queue", true)).toEqual({ kind: "send", activeTurnBehavior: "steer" });
  // A pending permission cannot hold a queue: interrupt instead (Paseo behaviour).
  expect(run("queue", false, true)).toEqual({ kind: "send", activeTurnBehavior: "interrupt" });
});
