import { expect, test } from "vitest";
import { boardOverview, noReveal, requestReveal, revealDone } from "./overview";
import type { Task, Project } from "../shared/model";
import type { AttentionItem } from "./attention";

const task = (id: string, status: Task["status"], extra: Partial<Task> = {}) =>
  ({ id, projectId: "p", workspaceId: `w-${id}`, status, archivedAt: null, ...extra }) as Task;
const project = { id: "p" } as Project;
const item = (t: Task, extra: Partial<AttentionItem>) =>
  ({ task: t, project, permissions: 0, errors: 0, unread: 0, questions: 0, silent: 0, sessionId: null, updatedAt: "" , ...extra }) as AttentionItem;

test("overview counts live cards, working sessions and what needs you", () => {
  const tasks = [
    task("a", "development"),
    task("b", "in_review"),
    task("c", "done"),
    task("d", "blocked"),
    task("e", "todo", { archivedAt: "2026-10-15T00:00:00Z" }),
    task("x", "todo", { projectId: "other" }),
  ];
  const agents = [
    { workspaceId: "w-a", status: "running" },
    { workspaceId: "w-a", status: "initializing" },
    { workspaceId: "w-b", status: "idle" },
    { workspaceId: "w-e", status: "running" }, // archived card
    { workspaceId: "w-a", status: "running", archivedAt: "2026-10-15T00:00:00Z" },
  ];
  const attention = [item(tasks[0], { questions: 1 }), item(tasks[1], { unread: 1 }), item(tasks[3], { errors: 1, unread: 1 })];
  expect(boardOverview(project, tasks, agents, attention)).toEqual({
    total: 4,
    done: 1,
    runningTasks: 1,
    runningSessions: 2,
    needsYou: 1,
    unread: 2,
    errors: 1,
    inReview: 1,
    blocked: 1,
  });
  // Lanes that are off report null (hidden), not zero.
  const lanes = (["backlog", "todo", "design", "development", "test", "in_review", "blocked", "done", "cancelled"] as const).map((status) => ({ status, enabled: status !== "blocked" }));
  expect(boardOverview({ ...project, lanes }, tasks.filter((t) => t.status !== "blocked"), [], []).blocked).toBeNull();
});

test("a lane chip's reveal is served once: a board mounted afterwards does not scroll to it again", () => {
  // DesktopColumns scrolls whenever it sees a pending reveal, also on mount (a chip pressed while a page replaced it).
  const pending = (r: typeof noReveal) => r.n !== 0;
  expect(pending(noReveal)).toBe(false);
  const pressed = requestReveal(noReveal, "in_review");
  expect(pressed).toMatchObject({ status: "in_review" });
  expect(pending(pressed)).toBe(true);
  // The board scrolled to it; Back from Ideas/Insights/Memory or a widened window mounts a board that sees nothing pending.
  const served = revealDone(pressed, pressed.n);
  expect(pending(served)).toBe(false);
  // The next press is pending again, also for the same lane, and a press newer than the served one survives.
  const again = requestReveal(served, "in_review");
  expect(pending(again)).toBe(true);
  const newer = requestReveal(again, "blocked");
  expect(revealDone(newer, again.n)).toBe(newer);
  expect(pending(revealDone(newer, newer.n))).toBe(false);
});
