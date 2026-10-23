import { describe, expect, test, vi } from "vitest";
import type { AutomationJob } from "../shared/automation";
import type { BoardEvent, Project, Task } from "../shared/model";
import { attentionItems } from "./attention";
import { automationMenu, automationReason, workspaceKnownMissing, type AutomationActions } from "./automation-view";

const now = "2026-10-22T10:00:00.000Z";
const later = "2026-10-22T10:05:00.000Z";
const project = (enabled = true) =>
  ({
    id: "p", paseoProjectId: "p", title: "P", description: "", primaryPath: "/p", repos: ["/p"],
    revision: 1, createdAt: now, updatedAt: now, archivedAt: null,
    automation: { enabled, maxRunning: 2, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 },
  }) as unknown as Project;
const task = (status: Task["status"] = "development") =>
  ({
    id: "a", projectId: "p", workspaceId: "wa", sourcePath: "/p", repoPaths: ["/p"], title: "A", description: "",
    status, priority: "normal", position: 0, revision: 1, operationId: "a", createdAt: now, updatedAt: now, archivedAt: null,
  }) as unknown as Task;
const job = (patch: Partial<AutomationJob>): AutomationJob => ({
  taskId: "a", projectId: "p", state: "working", role: "implementer", implementerId: "s1", generation: 1,
  nudges: 0, failures: 0, reviewRounds: 0, queuedAt: now, updatedAt: now, ...patch,
});
const moved = (patch: Partial<BoardEvent>): BoardEvent =>
  ({ id: `e-${patch.at}-${patch.rule ?? "x"}`, taskId: "a", actor: "human", action: "status_changed", at: later, ...patch }) as BoardEvent;
const actions = (): AutomationActions => ({ pending: false, queue: vi.fn(async () => {}), stop: vi.fn(async () => {}) });

describe("drawer reason line (client-docs-12, client-docs-4)", () => {
  test("a first failed turn that will be retried does not read as giving up", () => {
    const retrying = automationReason(job({ state: "retry_wait", code: "failed", failures: 1 }));
    expect(retrying).not.toBe("Turns kept failing");
    expect(retrying).toMatch(/retr/i);
    expect(automationReason(job({ state: "failed", code: "failed", failures: 2 }))).toBe("Turns kept failing");
  });

  test("a session start that will be retried says so", () => {
    expect(automationReason(job({ state: "retry_wait", code: "start_failed", failures: 1 }))).toMatch(/retr/i);
    expect(automationReason(job({ state: "failed", code: "start_failed", failures: 2 }))).toBe("The agent session could not be started");
  });

  test("a cooldown that ran out of budget does not promise a retry", () => {
    expect(automationReason(job({ state: "retry_wait", code: "cooldown" }))).toBe("Provider limit reached; retrying later");
    const exhausted = automationReason(job({ state: "needs_human", code: "cooldown", cooldowns: 6 }));
    expect(exhausted).not.toMatch(/retrying later/i);
    expect(exhausted).toMatch(/Run again/);
  });

  test("permission waits keep no reason line (the status says it)", () => {
    expect(automationReason(job({ state: "needs_human", code: "permission" }))).toBeNull();
    expect(automationReason(job({ state: "working" }))).toBeNull();
  });
});

describe("board Run with agent for a card whose workspace is gone (fixcheck-b-2, client-docs-10)", () => {
  const run = (known: ReadonlySet<string> | null) =>
    automationMenu(project(), task("todo"), undefined, false, actions(), workspaceKnownMissing(known, task("todo").workspaceId));

  test("disabled once the workspace list is loaded and lacks the card's workspace", () => {
    expect(run(new Set(["other"]))).toMatchObject([{ id: "automation-run", disabled: true }]);
  });

  test("enabled while the workspace list is still loading or present", () => {
    expect(run(null)).toMatchObject([{ id: "automation-run", disabled: false }]);
    expect(run(new Set(["wa"]))).toMatchObject([{ id: "automation-run", disabled: false }]);
  });

  test("Stop stays available for a live job", () => {
    const entries = automationMenu(project(), task(), job({ state: "working" }), false, actions(), workspaceKnownMissing(new Set(), "wa"));
    expect(entries).toMatchObject([{ id: "automation-stop", disabled: false }]);
  });

  test("a newly arrived card can Run while the cached workspace list predates its creation", () => {
    const unavailable = workspaceKnownMissing(new Set(["other"]), "wa", { cardCreatedAt: later, fetchedAt: Date.parse(now) });
    expect(automationMenu(project(), task("todo"), undefined, false, actions(), unavailable)).toMatchObject([{ id: "automation-run", disabled: false }]);
  });

  test("a refreshed list can confirm the new card's workspace is missing", () => {
    expect(workspaceKnownMissing(new Set(["other"]), "wa", { cardCreatedAt: now, fetchedAt: Date.parse(later) })).toBe(true);
    expect(workspaceKnownMissing(new Set(["wa"]), "wa", { cardCreatedAt: now, fetchedAt: Date.parse(later) })).toBe(false);
  });
});

describe("Needs attention automation entries (client-docs-7)", () => {
  const board = (p: Project, t: Task, j: AutomationJob, events: BoardEvent[] = []) => ({ projects: [p], tasks: [t], events, automation: [j] });
  const flagged = (b: ReturnType<typeof board>) => attentionItems(b, [], [], false).filter((i) => i.automation).map((i) => i.task.id);

  test("a waiting job is listed while automation is on, and clears when it is turned off", () => {
    const waiting = job({ state: "needs_human", code: "question" });
    expect(flagged(board(project(true), task(), waiting))).toEqual(["a"]);
    expect(flagged(board(project(false), task(), waiting))).toEqual([]);
  });

  test("a failed job clears once a person moved the card after the failure", () => {
    const failed = job({ state: "failed", code: "failed", updatedAt: now });
    const autoBlocked = moved({ actor: "system", rule: "AUTO", from: "development", to: "blocked", at: now });
    expect(flagged(board(project(), task("blocked"), failed, [autoBlocked]))).toEqual(["a"]);
    const takenBack = moved({ actor: "human", from: "blocked", to: "development", at: later });
    expect(flagged(board(project(), task("development"), failed, [autoBlocked, takenBack]))).toEqual([]);
  });

  test("a move from before the failure does not clear it", () => {
    const failed = job({ state: "failed", code: "start_failed", updatedAt: later });
    const earlier = moved({ actor: "human", from: "todo", to: "development", at: now });
    expect(flagged(board(project(), task(), failed, [earlier]))).toEqual(["a"]);
  });
});
