import { expect, test } from "vitest";
import type { AutomationJob } from "../shared/automation";
import { continuationPending, handoffSignal, handoffTone } from "./handoff-signal";

const at = "2026-10-25T23:50:00.000Z";
const job = (state: AutomationJob["state"], extra: Partial<AutomationJob> = {}): AutomationJob => ({ taskId: "a", projectId: "p", state, role: "implementer", generation: 1, nudges: 0, failures: 0, reviewRounds: 1, queuedAt: at, updatedAt: at, ...extra });
const stale = { taskId: "a", fresh: false, staleSince: at, open: 0, sessions: 3 };

test("a record behind later activity reads neutral to a person when nothing is unresolved and no agent continues from it", () => {
  // The live P2 card: approved, delivered to In review, 0 unresolved items.
  expect(handoffTone(stale, continuationPending(job("delivered", { verdict: "approved" }), { status: "in_review" }))).toBe("settled");
  for (const [state, status] of [["stopped", "in_review"], ["failed", "blocked"], ["working", "done"], ["reviewing", "cancelled"]] as const) expect(handoffTone(stale, continuationPending(job(state), { status }))).toBe("settled");
  expect(handoffTone(stale, continuationPending(undefined, { status: "development" }))).toBe("settled");
  expect(handoffTone({ ...stale, fresh: true }, true)).toBe("recorded");
});

test("the warning stays while items are unresolved, a successor has not acknowledged, or an agent is about to continue", () => {
  expect(handoffTone({ ...stale, open: 1 }, false)).toBe("check");
  expect(handoffTone(stale, false, true)).toBe("check");
  for (const state of ["queued", "starting", "working", "needs_human", "waiting", "retry_wait", "reviewing"] as const) expect(handoffTone(stale, continuationPending(job(state), { status: "development" }))).toBe("check");
  // A delivered card still continues when a comment is routed to its agent or a fresh session was asked for.
  expect(continuationPending(job("delivered", { pendingInputs: ["c1"] }), { status: "in_review" })).toBe(true);
  expect(continuationPending(job("delivered", { rotateRequested: { at, reason: "requested" } }), { status: "in_review" })).toBe(true);
});

test("the card signal carries the tone with the index, and nothing for a card without a record", () => {
  expect(handoffSignal(stale, job("delivered"), { status: "in_review" })).toEqual({ ...stale, tone: "settled" });
  expect(handoffSignal(stale, job("working"), { status: "development" })?.tone).toBe("check");
  expect(handoffSignal(undefined, job("working"), { status: "development" })).toBeUndefined();
});
