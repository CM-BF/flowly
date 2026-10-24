import { describe, expect, test } from "vitest";
import { buildCardTree, cardFlag, rollupBelow } from "../shared/card-tree";
import type { AutomationJob } from "../shared/automation-schema";
import { attentionItems } from "./attention";
import { boardOverview } from "./overview";
import type { Link, Project, Status, Task } from "../shared/model";
import { belowLabel, belowSignals, boardLevels, hiddenAncestors, levelChipText, levelChoiceText } from "./board-levels";
import { cardFlags } from "./card-flags";
import { setLocale } from "../shared/i18n";

// The owner's 19-card shape (CARD-TREE-SPEC §9.1), as in shared/card-tree.test.ts.
let clock = 0;
const now = "2026-10-24T00:00:00.000Z";
const task = (id: string, status: Status = "todo", extra: Partial<Task> = {}): Task => {
  const at = new Date(Date.UTC(2026, 9, 24, 0, 0, clock++)).toISOString();
  return {
    id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/p", repoPaths: [], title: id, description: "", status,
    priority: "normal", position: 0, revision: 1, operationId: `op-${id}`, createdAt: at, updatedAt: at, archivedAt: null, ...extra,
  };
};
const link = (kind: Link["kind"], from: string, to: string): Link => ({ id: `${from}-${kind}-${to}`, projectId: "p", kind, from, to, createdBy: "human", createdAt: now });
const sub = (child: string, parent: string) => link("subtask", child, parent);
const blocks = (blocker: string, card: string) => link("blocks", blocker, card);
const research = ["inventory", "behaviour", "architecture"];
const steps = ["C1", "C2", "C3", "C4", "C5"];
function ownerProject(statuses: Record<string, Status> = {}) {
  clock = 0;
  const ids = ["main", ...research, ...steps, "C4a", "C4b", "C5a", "C5b", "C5a.1", "C5a.2", "C5a.3", "C5b.1", "C5b.2", "C5b.3"];
  const tasks = ids.map((id) => task(id, statuses[id] ?? "todo"));
  const links = [
    ...[...research, ...steps].map((id) => sub(id, "main")),
    sub("C4a", "C4"), sub("C4b", "C4"), sub("C5a", "C5"), sub("C5b", "C5"),
    ...["C5a.1", "C5a.2", "C5a.3"].map((id) => sub(id, "C5a")),
    ...["C5b.1", "C5b.2", "C5b.3"].map((id) => sub(id, "C5b")),
    blocks("C1", "C2"), blocks("C2", "C3"), blocks("C3", "C4"), blocks("C4", "C5"), blocks("C4a", "C4b"),
    blocks("C5a.1", "C5a.2"), blocks("C5a.2", "C5a.3"), blocks("C5a", "C5b"), blocks("C5b.1", "C5b.2"), blocks("C5b.2", "C5b.3"),
  ];
  return { tasks, links, tree: buildCardTree(tasks, links) };
}
const levels = (o: ReturnType<typeof ownerProject>, patch: Partial<Parameters<typeof boardLevels>[0]> = {}) =>
  boardLevels({ tree: o.tree, level: null, showArchived: false, searching: false, revealed: new Set(), keep: new Set(), visible: o.tasks, lanesShown: [], ...patch });

describe("boardLevels (CARD-TREE-SPEC §2.3)", () => {
  test("Levels 1 / 2 / 3 / All show 1 / 9 / 13 / 19 cards, with the choices the tree offers", () => {
    const o = ownerProject();
    expect([1, 2, 3, null].map((level) => levels(o, { level }).shown.length)).toEqual([1, 9, 13, 19]);
    expect(levels(o).choices.map((c) => [c.level, c.hides])).toEqual([[1, 18], [2, 10], [3, 6], [null, 0]]);
    expect(levels(o, { level: 1 }).hiddenCount).toBe(18);
  });

  test("a stored level deeper than any card is All; nothing nested offers no choices", () => {
    clock = 0;
    const flat = [task("a"), task("b")];
    const result = boardLevels({ tree: buildCardTree(flat, []), level: 2, showArchived: false, searching: false, revealed: new Set(), keep: new Set(), visible: flat, lanesShown: [] });
    expect(result.choices).toEqual([]);
    expect(result.level).toBeNull();
    expect(result.shown).toEqual(flat);
  });

  test("search pauses the fold; the open card and revealed sub-trees stay", () => {
    const o = ownerProject();
    const paused = levels(o, { level: 1, searching: true });
    expect(paused.paused).toBe(true);
    expect(paused.shown.length).toBe(19);
    expect(levelChipText(paused)).toBe("Levels: 1 (paused while searching)");
    expect(levels(o, { level: 1, keep: new Set(["C5a.2"]) }).shown.map((t) => t.id)).toEqual(["main", "C5a.2"]);
    const revealed = levels(o, { level: 2, revealed: new Set(["C5"]) }).shown.map((t) => t.id);
    expect(revealed).toEqual(expect.arrayContaining(["C5a", "C5b", "C5a.1", "C5b.3"]));
    expect(revealed).not.toContain("C4a");
  });

  test("counts follow the filtered cards; a lane footer shows its hidden ones", () => {
    const o = ownerProject({ C4a: "development", C4b: "development", C5a: "in_review" });
    const filtered = o.tasks.filter((t) => t.id !== "C4b");
    const result = levels(o, { level: 2, visible: filtered });
    expect(result.hiddenCount).toBe(9);
    expect(result.byLane.get("development")).toBe(1);
    expect(result.byLane.get("in_review")).toBe(1);
    const footer = levels(o, { level: 2, visible: filtered, lanesShown: ["development"] });
    expect(footer.shown.map((t) => t.id)).toContain("C4a");
    expect(footer.hiddenCount).toBe(8);
    expect(footer.byLane.get("development")).toBe(1);
  });

  test("an archived parent is out of scope with Show archived off, so its live child counts as top level", () => {
    clock = 0;
    const tasks = [task("parent", "done", { archivedAt: now }), task("child")];
    const tree = buildCardTree(tasks, [sub("child", "parent")]);
    const off = boardLevels({ tree, level: 1, showArchived: false, searching: false, revealed: new Set(), keep: new Set(), visible: [tasks[1]], lanesShown: [] });
    expect(off.choices).toEqual([]);
    expect(off.shown.map((t) => t.id)).toEqual(["child"]);
    const on = boardLevels({ tree, level: 1, showArchived: true, searching: false, revealed: new Set(), keep: new Set(), visible: tasks, lanesShown: [] });
    expect(on.shown.map((t) => t.id)).toEqual(["parent"]);
  });

  test("the card menu offers Show its sub-cards only where something below is hidden", () => {
    const o = ownerProject();
    const { hidden } = levels(o, { level: 2 });
    const above = hiddenAncestors(o.tree, hidden);
    expect(above.has("C5")).toBe(true);
    expect(above.has("C1")).toBe(false);
    expect(above.has("C5a")).toBe(true);
    expect(above.has("main")).toBe(true);
  });

  test("chip and menu wording", () => {
    setLocale("en");
    const o = ownerProject();
    expect(levelChipText(levels(o))).toBe("Levels: All");
    expect(levelChipText(levels(o, { level: 2 }))).toBe("Levels: 2 · 10 hidden");
    expect([1, 2, 3, null].map(levelChoiceText)).toEqual(["Top-level cards only", "Down to level 2", "Down to level 3", "All levels"]);
  });
});

describe("roll-up (CARD-TREE-SPEC §2.4)", () => {
  const project = { id: "p", title: "P", archivedAt: null, automation: { enabled: true } } as unknown as Project;
  const agent = (id: string, workspaceId: string, status: "running" | "idle" | "initializing", extra: object = {}) =>
    ({ id, workspaceId, status, title: id, createdAt: now, updatedAt: now, provider: "codex", model: null, cwd: "/p", ...extra });
  const job = (taskId: string, state: AutomationJob["state"]): AutomationJob => ({
    taskId, projectId: "p", state, role: "implementer", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: now, updatedAt: now,
  });
  const attention = (id: string, patch: object = {}) => ({ task: { id }, dismissed: false, questions: 0, permissions: 0, asks: 0, errors: 0, unread: 0, ...patch });

  test("a hidden grandchild's needs-you counts once, on the nearest visible ancestor", () => {
    const o = ownerProject();
    const flags = cardFlags({ tree: o.tree, tasksById: new Map(o.tasks.map((t) => [t.id, t])), jobsById: new Map(), attention: [attention("C5b.2", { questions: 1 })], agents: [] });
    const { hidden, shown } = levels(o, { level: 2 });
    const below = rollupBelow(o.tree, hidden, new Set(shown.map((t) => t.id)), flags);
    expect(below.get("C5")).toMatchObject({ hidden: 8, needs: 1 });
    expect(below.get("main")).toBeUndefined();
    expect([...below.values()].reduce((n, b) => n + b.needs, 0)).toBe(1);
  });

  test("dismissed attention adds nothing; running comes only from live sessions and slot-holding jobs", () => {
    const o = ownerProject();
    const flags = cardFlags({
      tree: o.tree,
      tasksById: new Map(o.tasks.map((t) => [t.id, t])),
      jobsById: new Map([["C4b", job("C4b", "working")], ["C4a", job("C4a", "queued")], ["C5a.1", job("C5a.1", "needs_human")]]),
      attention: [attention("C5a.2", { errors: 1, dismissed: true }), attention("C5a.3", { unread: 1 })],
      agents: [agent("s1", "w-C5b.1", "running"), agent("s2", "w-C5b.2", "idle"), agent("s3", "w-C5b.3", "running", { archivedAt: now })],
    });
    const f = (id: string) => flags.get(id) ?? 0;
    expect(f("C5a.2") & (cardFlag.error | cardFlag.needs)).toBe(0);
    expect(f("C5a.3") & cardFlag.unread).toBeTruthy();
    expect(["C4b", "C4a", "C5a.1", "C5b.1", "C5b.2", "C5b.3"].map((id) => !!(f(id) & cardFlag.active))).toEqual([true, false, false, true, false, false]);
    const { hidden, shown } = levels(o, { level: 2 });
    const below = rollupBelow(o.tree, hidden, new Set(shown.map((t) => t.id)), flags);
    expect(below.get("C4")).toMatchObject({ hidden: 2, running: 1 });
    expect(below.get("C5")).toMatchObject({ hidden: 8, running: 1, unread: 1, errors: 0 });
  });

  test("an ancestor filtered off the board passes the roll-up to a higher one", () => {
    const o = ownerProject();
    const flags = cardFlags({ tree: o.tree, tasksById: new Map(o.tasks.map((t) => [t.id, t])), jobsById: new Map(), attention: [attention("C5a.1", { permissions: 1 })], agents: [] });
    const { hidden, shown } = levels(o, { level: 2, visible: o.tasks.filter((t) => t.id !== "C5") });
    const below = rollupBelow(o.tree, hidden, new Set(shown.map((t) => t.id)), flags);
    expect(below.get("main")).toMatchObject({ needs: 1 });
  });

  test("Attention, its count and the overview do not depend on Levels", () => {
    const o = ownerProject();
    const board = { projects: [project], tasks: o.tasks, events: [], automation: [job("C5a.1", "needs_human")], attentionDismissals: [] };
    const a1 = attentionItems(board, [], [], false);
    expect(a1.map((i) => i.task.id)).toEqual(["C5a.1"]);
    // Levels is a view of the board's cards; the attention inputs never pass through it.
    levels(o, { level: 1 });
    expect(attentionItems(board, [], [], false)).toEqual(a1);
    expect(boardOverview(project, o.tasks, [], a1)).toEqual(boardOverview(project, o.tasks, [], attentionItems(board, [], [], false)));
  });

  test("signals in order; running and unread follow Session activity; one accessibility sentence", () => {
    setLocale("en");
    const below = { hidden: 11, needs: 1, errors: 0, held: 1, running: 2, unread: 1 };
    expect(belowSignals(below, true).map((s) => s.text)).toEqual(["11 hidden below", "1 below needs you", "1 below held", "2 below running", "1 below unread"]);
    expect(belowSignals(below, false).map((s) => s.key)).toEqual(["hidden", "needs", "held"]);
    expect(belowSignals({ ...below, hidden: 0 }, true)).toEqual([]);
    expect(belowLabel({ hidden: 11, needs: 1, errors: 0, held: 0, running: 2, unread: 0 })).toBe("11 sub-cards hidden: 1 needs you, 2 running");
    expect(belowLabel({ hidden: 1, needs: 0, errors: 0, held: 0, running: 0, unread: 0 })).toBe("1 hidden below");
  });
});
