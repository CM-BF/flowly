import { expect, test } from "vitest";
import type { Board, BoardEvent, Status } from "../shared/model";
import { applyTurnStarted, recordLifecycle } from "./progress-rules";
import { cardQuestions, openQuestion, silentTurn } from "../shared/progress";

const now = "2026-10-15T00:00:00.000Z";
function board(status: Status, extra: { autoStatus?: boolean; archived?: boolean } = {}): Board {
  return {
    version: 3,
    revision: 1,
    projects: [{
      id: "p", title: "P", description: "", paseoProjectId: "n", primaryPath: "/p", repos: ["/p"],
      revision: 1, createdAt: now, updatedAt: now, archivedAt: null,
      ...(extra.autoStatus !== undefined ? { autoStatus: extra.autoStatus } : {}),
    }],
    tasks: [{
      id: "t", projectId: "p", workspaceId: "w", sourcePath: "/p", repoPaths: ["/p"], title: "T",
      description: "", status, priority: "normal", position: 0, revision: 1, operationId: "o",
      createdAt: now, updatedAt: now, archivedAt: extra.archived ? now : null,
    }],
    events: [],
    agentReceipts: [],
  } as Board;
}
const store = {
  event(b: Board, input: Omit<BoardEvent, "id" | "at">) {
    const e = { ...input, id: String(b.events.length), at: new Date(Date.parse(now) + b.events.length * 1000).toISOString() };
    b.events.push(e as BoardEvent);
    return e as BoardEvent;
  },
};
const id = { agentId: "a", taskId: "t", workspaceId: "w" };

test("A1 moves backlog/todo/in_review/blocked to in progress with a traceable reason", () => {
  for (const status of ["backlog", "todo", "in_review", "blocked"] as const) {
    const b = board(status);
    expect(applyTurnStarted(store, b, id, "S")).toBe(true);
    expect(b.tasks[0]).toMatchObject({ status: "in_progress", revision: 2 });
    expect(b.events.at(-1)).toMatchObject({ action: "status_changed", actor: "system", rule: "A1", from: status, to: "in_progress" });
  }
});

test("A1 never touches finished, already active, archived, opted-out or unbound cards", () => {
  for (const status of ["done", "cancelled", "in_progress"] as const) {
    const b = board(status);
    expect(applyTurnStarted(store, b, id, "S")).toBe(false);
    expect(b.tasks[0].status).toBe(status);
  }
  expect(applyTurnStarted(store, board("todo", { archived: true }), id, "S")).toBe(false);
  expect(applyTurnStarted(store, board("todo", { autoStatus: false }), id, "S")).toBe(false);
  expect(applyTurnStarted(store, board("todo"), { ...id, workspaceId: "other" }, "S")).toBe(false);
  expect(applyTurnStarted(store, board("todo"), { ...id, taskId: "missing" }, "S")).toBe(false);
});

test("lifecycle records carry the outcome; failures keep a short reason", () => {
  const b = board("in_progress");
  recordLifecycle(store, b, id, "agent.turn_ended", { kind: "failed", error: { message: "x".repeat(900) } });
  expect(b.events[0]).toMatchObject({ action: "agent.turn_ended", outcome: "failed", agentId: "a" });
  expect(b.events[0].note).toHaveLength(500);
  recordLifecycle(store, b, { ...id, workspaceId: "other" }, "agent.turn_started");
  expect(b.events).toHaveLength(1);
});

const ev = (action: string, at: number, extra: Partial<BoardEvent> = {}): BoardEvent => ({
  id: `${action}-${at}`, taskId: "t", actor: action.startsWith("agent.") ? "system" : "agent",
  action, agentId: "a", at: new Date(Date.parse(now) + at * 1000).toISOString(), ...extra,
} as BoardEvent);

test("a question stays open until the session starts its next turn or reports again", () => {
  const asked = [ev("agent.turn_started", 1), ev("progress_reported", 2, { reportKind: "question", note: "Which DB?" }), ev("agent.turn_ended", 3)];
  expect(openQuestion(asked, "a")?.note).toBe("Which DB?");
  expect(cardQuestions({ id: "t" }, asked)).toHaveLength(1);
  expect(openQuestion([...asked, ev("agent.turn_started", 4)], "a")).toBeNull();
  expect(openQuestion([...asked.slice(0, 2), ev("progress_reported", 3, { reportKind: "progress" })], "a")).toBeNull();
  expect(openQuestion(asked, "other")).toBeNull();
});

test("silent turn: ended without any report while the card is in progress", () => {
  const silent = [ev("agent.turn_started", 1), ev("agent.turn_ended", 2, { outcome: "completed" })];
  expect(silentTurn({ status: "in_progress" }, silent, "a")).toBe(true);
  expect(silentTurn({ status: "in_review" }, silent, "a")).toBe(false);
  const reported = [ev("agent.turn_started", 1), ev("progress_reported", 2), ev("agent.turn_ended", 3)];
  expect(silentTurn({ status: "in_progress" }, reported, "a")).toBe(false);
  expect(silentTurn({ status: "in_progress" }, [...silent, ev("agent.turn_started", 3)], "a")).toBe(false);
  expect(silentTurn({ status: "in_progress" }, [ev("agent.turn_started", 1), ev("agent.turn_ended", 2, { outcome: "failed" })], "a")).toBe(false);
});
