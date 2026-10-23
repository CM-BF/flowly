import { expect, test } from "vitest";
import { cardsInTurn, motionOf, providerLimited, recoveredOutcome, subCardSignature, type AutomationJob } from "./automation";
import type { Board, BoardEvent, Task } from "./model";

test("capacity wording from providers counts as a provider limit", () => {
  expect(providerLimited("Selected model is at capacity. Please try a different model.")).toBe(true);
  expect(providerLimited("The model is over capacity")).toBe(true);
  expect(providerLimited("Disk capacity is fine; the test failed")).toBe(false);
});

const now = Date.parse("2026-10-23T12:00:00Z");
const at = (ms: number) => new Date(now + ms).toISOString();
const event = (taskId: string, action: string, agentId: string, ms: number): BoardEvent => ({ id: `${taskId}-${action}-${ms}`, taskId, actor: "system", action, agentId, at: at(ms) });
const task = (id: string): Task => ({ id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/", repoPaths: [], title: id, description: "", status: "test", priority: "normal", position: 0, revision: 1, operationId: id, createdAt: at(-1e7), updatedAt: at(-1e7), archivedAt: null });
const failed: AutomationJob = { taskId: "b", projectId: "p", state: "failed", role: "implementer", generation: 1, nudges: 0, failures: 2, reviewRounds: 0, queuedAt: at(-1e7), updatedAt: at(-1e7) };

test("a card whose managed session is mid-turn moves, whatever its job says; a closed or stale turn does not", () => {
  const board = (events: BoardEvent[]) => ({ tasks: [task("a"), task("b")], links: [{ id: "l", projectId: "p", kind: "subtask" as const, from: "b", to: "a", createdBy: "human" as const, createdAt: at(-1e7) }], automation: [failed], events }) as unknown as Board;
  const open = board([event("b", "agent.turn_started", "s", -60_000)]);
  expect(cardsInTurn(open, now)).toEqual(new Set(["b"]));
  expect(motionOf(open, now).has("b")).toBe(true);
  expect(subCardSignature(open, "a", motionOf(open, now))).toMatch(/:turn$/);
  const closed = board([event("b", "agent.turn_started", "s", -60_000), event("b", "agent.turn_ended", "s", -1000)]);
  expect(motionOf(closed, now).has("b")).toBe(false);
  expect(subCardSignature(closed, "a", motionOf(closed, now))).not.toMatch(/:turn/);
  expect(motionOf(board([event("b", "agent.turn_started", "s", -7 * 3600_000)]), now).has("b")).toBe(false);
});

test("a missed turn end is recovered only from the daemon's own record after the last instruction", () => {
  const since = at(-60_000);
  expect(recoveredOutcome({ status: "error", lastError: "boom" }, since)).toEqual({ kind: "failed", message: "boom" });
  expect(recoveredOutcome({ status: "idle", attentionReason: "finished", attentionTimestamp: at(-1000) }, since)).toEqual({ kind: "completed" });
  expect(recoveredOutcome({ status: "idle", attentionReason: "error", attentionTimestamp: at(-1000), lastError: "429" }, since)).toEqual({ kind: "failed", message: "429" });
  expect(recoveredOutcome({ status: "idle", attentionReason: "finished", attentionTimestamp: at(-120_000) }, since)).toBeNull();
  expect(recoveredOutcome({ status: "idle", attentionReason: null, attentionTimestamp: null }, since)).toBeNull();
});
