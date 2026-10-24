import { describe, expect, test } from "vitest";
import type { AutomationJob } from "./automation-schema";
import { readiness } from "./automation";
import {
  blockerIndex,
  blockerState,
  buildCardTree,
  cardFlag,
  cardTreeOf,
  chainOf,
  foldByLevel,
  isHeld,
  levelChoices,
  levelHistogram,
  nextUp,
  outlineRows,
  rollupBelow,
  rootGroup,
  sameRowList,
  scopeOf,
  statusFlags,
  subtreeTotals,
  type CardTree,
  type OutlineRow,
} from "./card-tree";
import { waitingOn } from "./links";
import type { Board, Link, Status, Task } from "./model";

// CARD-TREE-SPEC §9.1: the owner's real project shape (2026-10-24), 19 cards.
let clock = 0;
const task = (id: string, status: Status = "todo", extra: Partial<Task> = {}): Task => {
  const at = new Date(Date.UTC(2026, 9, 24, 0, 0, clock++)).toISOString();
  return {
    id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/p", repoPaths: [], title: id, description: "", status,
    priority: "normal", position: 0, revision: 1, operationId: `op-${id}`, createdAt: at, updatedAt: at, archivedAt: null, ...extra,
  };
};
const link = (kind: Link["kind"], from: string, to: string): Link => ({
  id: `${from}-${kind}-${to}`, projectId: "p", kind, from, to, createdBy: "human", createdAt: "2026-10-24T00:00:00.000Z",
});
const sub = (child: string, parent: string) => link("subtask", child, parent);
const blocks = (blocker: string, card: string) => link("blocks", blocker, card);
const job = (taskId: string, state: AutomationJob["state"] = "queued"): AutomationJob => ({
  taskId, projectId: "p", state, role: "implementer", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
});

const research = ["inventory", "behaviour", "architecture"];
const steps = ["C1", "C2", "C3", "C4", "C5"];
function ownerProject() {
  clock = 0;
  const ids = ["main", ...research, ...steps, "C4a", "C4b", "C5a", "C5b", "C5a.1", "C5a.2", "C5a.3", "C5b.1", "C5b.2", "C5b.3"];
  const tasks = ids.map((id) => task(id));
  const links = [
    ...[...research, ...steps].map((id) => sub(id, "main")),
    sub("C4a", "C4"), sub("C4b", "C4"), sub("C5a", "C5"), sub("C5b", "C5"),
    ...["C5a.1", "C5a.2", "C5a.3"].map((id) => sub(id, "C5a")),
    ...["C5b.1", "C5b.2", "C5b.3"].map((id) => sub(id, "C5b")),
    blocks("C1", "C2"), blocks("C2", "C3"), blocks("C3", "C4"), blocks("C4", "C5"),
    blocks("C4a", "C4b"),
    blocks("C5a.1", "C5a.2"), blocks("C5a.2", "C5a.3"),
    blocks("C5a", "C5b"),
    blocks("C5b.1", "C5b.2"), blocks("C5b.2", "C5b.3"),
  ];
  return { tasks, links };
}
const stepsOf = (tree: CardTree, ids: readonly string[]) => ids.map((id) => tree.step.get(id));
const all = () => true;
const byId = (tasks: readonly Task[]) => new Map(tasks.map((t) => [t.id, t] as const));
const visibleCount = (tree: CardTree, hidden: ReadonlySet<string>) => tree.ids.filter((id) => !hidden.has(id)).length;

describe("buildCardTree on the owner's project", () => {
  test("parents, depth 0 to 3, children in link order", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, links);
    expect(tree.roots).toEqual(["main"]);
    expect(tree.children.get("main")).toEqual([...research, ...steps]);
    expect(["main", "C5", "C5a", "C5a.1"].map((id) => tree.depth.get(id))).toEqual([0, 1, 2, 3]);
    expect(tree.chain("C5b.3")).toEqual(["main", "C5", "C5b", "C5b.3"]);
    expect(levelHistogram(tree, all)).toEqual([1, 8, 4, 6]);
    expect(tree.anomalies).toEqual([]);
  });

  test("steps: the research cards run beside C1 (no links between them), then C2..C5 follow", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, links);
    expect(stepsOf(tree, research)).toEqual([1, 1, 1]);
    expect(stepsOf(tree, steps)).toEqual([1, 2, 3, 4, 5]);
    expect(tree.steps.get("main")).toBe(5);
    expect(stepsOf(tree, ["C4a", "C4b", "C5a", "C5b"])).toEqual([1, 2, 1, 2]);
    expect(stepsOf(tree, ["C5a.1", "C5a.2", "C5a.3", "C5b.1", "C5b.2", "C5b.3"])).toEqual([1, 2, 3, 1, 2, 3]);
    expect(tree.cyclic.size).toBe(0);
  });

  test("once C1 waits for the research, C1..C5 become steps 2..6", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, [...links, ...research.map((r) => blocks(r, "C1"))]);
    expect(stepsOf(tree, research)).toEqual([1, 1, 1]);
    expect(stepsOf(tree, steps)).toEqual([2, 3, 4, 5, 6]);
  });

  test("siblings sort by step, then creation, then id", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, links);
    expect(tree.ordered.get("main")).toEqual(["inventory", "behaviour", "architecture", "C1", "C2", "C3", "C4", "C5"]);
    // C1 created first: the ties at step 1 follow creation, whatever the link order.
    const reversed = buildCardTree(tasks, [...links].reverse());
    expect(reversed.ordered.get("main")!.slice(0, 4)).toEqual(["inventory", "behaviour", "architecture", "C1"]);
    expect(reversed.ordered.get("C5a")).toEqual(["C5a.1", "C5a.2", "C5a.3"]);
  });
});

describe("sibling edge lifting", () => {
  test("C4b → C5a.1 lifts to C4 → C5 and merges with the edge already there", () => {
    const { tasks, links } = ownerProject();
    const cross = blocks("C4b", "C5a.1");
    const tree = buildCardTree(tasks, [...links, cross]);
    expect(tree.siblingEdges.get("main")!.filter(([a, b]) => a === "C4" && b === "C5")).toHaveLength(1);
    expect(tree.lifted.has(cross.id)).toBe(true);
    expect(tree.lifted.has(blocks("C4", "C5").id)).toBe(false);
    expect(tree.blockers.get("C5a.1")).toEqual(["C4b"]);
    expect(stepsOf(tree, steps)).toEqual([1, 2, 3, 4, 5]);
  });

  test("an edge between two trees lands in the top-level group", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree([...tasks, task("other"), task("X")], [...links, sub("X", "other"), blocks("C2", "X")]);
    expect(tree.siblingEdges.get(rootGroup)).toEqual([["main", "other"]]);
    expect(stepsOf(tree, ["main", "other"])).toEqual([1, 2]);
  });

  test("an edge to the card's own ancestor is not lifted", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, [...links, blocks("main", "C1")]);
    expect(tree.anomalies).toContainEqual({ kind: "ancestor", link: blocks("main", "C1").id });
    expect(stepsOf(tree, steps)).toEqual([1, 2, 3, 4, 5]);
  });

  test("A1 → B2 with B1 → A2 ends, marks the cycle and orders it the same way every time", () => {
    clock = 0;
    const tasks = ["A", "B", "A1", "A2", "B1", "B2", "C"].map((id) => task(id));
    const links = [sub("A1", "A"), sub("A2", "A"), sub("B1", "B"), sub("B2", "B"), blocks("A1", "B2"), blocks("B1", "A2"), blocks("B", "C")];
    const tree = buildCardTree(tasks, links);
    expect([...tree.cyclic].sort()).toEqual(["A", "B"]);
    expect(stepsOf(tree, ["A", "B", "C"])).toEqual([1, 2, 3]);
    expect(buildCardTree(tasks, links).step).toEqual(tree.step);
  });
});

describe("robustness", () => {
  test("sub-card loops, a second parent, missing or foreign cards and self links are reported, not followed", () => {
    clock = 0;
    const tasks = ["X", "Y", "Z", "W"].map((id) => task(id));
    const tree = buildCardTree(tasks, [sub("X", "Y"), sub("Y", "X"), sub("Z", "X"), sub("Z", "W"), blocks("W", "gone"), blocks("W", "W"), link("subtask", "q1", "q2")]);
    expect(tree.anomalies).toEqual(
      expect.arrayContaining([
        { kind: "second-parent", link: sub("Z", "W").id, card: "Z" },
        { kind: "subtask-cycle", card: "Y" },
        { kind: "outside", link: blocks("W", "gone").id },
        { kind: "self", link: blocks("W", "W").id },
      ]),
    );
    expect(tree.anomalies).toHaveLength(4);
    expect(tree.roots).toEqual(["Y", "W"]);
    expect(tree.chain("Z")).toEqual(["Y", "X", "Z"]);
  });

  test("300 cards with a random DAG of blockers finish quickly", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    clock = 0;
    const tasks = Array.from({ length: 300 }, (_, i) => task(`n${i}`));
    const links: Link[] = [];
    for (let i = 1; i < 300; i++) if (rand() < 0.8) links.push(sub(`n${i}`, `n${Math.floor(rand() * i)}`));
    for (let k = 0; k < 600; k++) {
      const a = Math.floor(rand() * 300), b = Math.floor(rand() * 300);
      if (a < b) links.push({ ...blocks(`n${a}`, `n${b}`), id: `b${k}` });
    }
    const started = performance.now();
    const tree = buildCardTree(tasks, links);
    const flags = statusFlags(tree, byId(tasks), new Map());
    outlineRows(tree, { inScope: all, flags, level: null });
    subtreeTotals(tree, flags);
    expect(performance.now() - started).toBeLessThan(500);
    expect(tree.step.size).toBe(300);
  });
});

test("cardTreeOf reuses the tree across state changes and rebuilds it when links or the card shape change", () => {
  const { tasks, links } = ownerProject();
  const board = { tasks: [...tasks, { ...task("elsewhere"), projectId: "q" }], links } as Pick<Board, "tasks" | "links">;
  const tree = cardTreeOf(board, "p");
  expect(tree.ids).not.toContain("elsewhere");
  const moved = { ...board, tasks: board.tasks.map((t) => (t.id === "C3" ? { ...t, status: "development" as const, title: "renamed" } : t)) };
  expect(cardTreeOf(moved, "p")).toBe(tree);
  expect(cardTreeOf({ ...moved, links: [...links] }, "p")).not.toBe(tree);
  const archived = { ...moved, tasks: moved.tasks.map((t) => (t.id === "C3" ? { ...t, archivedAt: "2026-10-24T01:00:00.000Z" } : t)) };
  expect(cardTreeOf(archived, "p").archived.has("C3")).toBe(true);
});

describe("Held and blockers (CARD-LINKS-SPEC §2.5)", () => {
  test("blocker states", () => {
    expect(blockerState(undefined)).toBe("gone");
    expect(blockerState(task("a", "done"))).toBe("done");
    expect(blockerState(task("a", "done", { archivedAt: "2026-10-24T00:00:00.000Z" }))).toBe("done");
    expect(blockerState(task("a", "cancelled"))).toBe("stuck");
    expect(blockerState(task("a", "test", { archivedAt: "2026-10-24T00:00:00.000Z" }))).toBe("stuck");
    expect(blockerState(task("a", "blocked"))).toBe("open");
  });

  test("a queued card behind a Cancelled blocker is held; without a job the blocker counts as resolved", () => {
    const tasks = [task("B", "cancelled"), task("O"), task("Q")];
    const tree = buildCardTree(tasks, [blocks("B", "Q"), blocks("O", "Q")]);
    const states = byId(tasks);
    expect(isHeld(tree, states, job("Q"))).toBe(true);
    expect(isHeld(tree, states, undefined)).toBe(false);
    expect(isHeld(tree, states, job("Q", "working"))).toBe(false);
    expect(blockerIndex(tree, states, new Map([["Q", job("Q")]])).get("Q")).toEqual({ open: 1, stuck: 1, titles: "O", stuckTitles: ["B"], held: true });
    expect(blockerIndex(tree, states, new Map()).get("Q")).toMatchObject({ open: 1, held: false });
    expect(statusFlags(tree, states, new Map([["Q", job("Q")]])).get("Q")! & cardFlag.held).toBeTruthy();
  });

  test("isHeld agrees with readiness() and blockerIndex with waitingOn() on random boards", () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
    const statuses: Status[] = ["backlog", "todo", "development", "in_review", "blocked", "done", "cancelled"];
    for (let round = 0; round < 40; round++) {
      const tasks = Array.from({ length: 12 }, (_, i) => task(`t${i}`, pick(statuses), rand() < 0.2 ? { archivedAt: "2026-10-24T00:00:00.000Z" } : {}));
      const pairs = new Set<string>();
      const links: Link[] = [];
      for (let k = 0; k < 20; k++) {
        const a = Math.floor(rand() * 12), b = Math.floor(rand() * 12);
        if (a === b || pairs.has(`${a}>${b}`)) continue;
        pairs.add(`${a}>${b}`);
        links.push(blocks(`t${a}`, `t${b}`));
      }
      if (rand() < 0.5) links.push(blocks("t0", "missing"));
      const jobs = tasks.filter(() => rand() < 0.6).map((t) => job(t.id, pick(["queued", "queued", "working", "failed"] as const)));
      const board = { tasks, links } as Pick<Board, "tasks" | "links">;
      const tree = buildCardTree(tasks, links);
      const states = byId(tasks);
      const index = blockerIndex(tree, states, new Map(jobs.map((j) => [j.taskId, j])));
      for (const j of jobs.filter((x) => x.state === "queued")) {
        const r = readiness(board, j.taskId);
        expect(isHeld(tree, states, j)).toBe(!r.ready && r.reason === "blockers" && r.cancelled.length > 0);
        expect(index.get(j.taskId)?.held ?? false).toBe(isHeld(tree, states, j));
      }
      for (const t of tasks) expect(index.get(t.id)?.open ?? 0).toBe(waitingOn(board, t.id).length);
    }
  });
});

describe("Levels", () => {
  test("Levels 1 / 2 / 3 / All show 1 / 9 / 13 / 19 cards", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, links);
    const shown = [1, 2, 3, null].map((level) => visibleCount(tree, foldByLevel(tree, level, new Set(), new Set(), all)));
    expect(shown).toEqual([1, 9, 13, 19]);
    expect(levelChoices(tree, all)).toEqual([
      { level: 1, hides: 18 },
      { level: 2, hides: 10 },
      { level: 3, hides: 6 },
      { level: null, hides: 0 },
    ]);
  });

  test("the open card stays visible, and a revealed card shows its whole sub-tree", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, links);
    const kept = foldByLevel(tree, 1, new Set(), new Set(["C5a.2"]), all);
    expect(kept.has("C5a.2")).toBe(false);
    expect(kept.has("C5a")).toBe(true);
    const revealed = foldByLevel(tree, 2, new Set(["C5"]), new Set(), all);
    expect(["C5a", "C5b", "C5a.1", "C5b.3"].filter((id) => revealed.has(id))).toEqual([]);
    expect(revealed.has("C4a")).toBe(true);
  });

  test("an archived parent outside the scope does not count: its live sub-cards are top-level", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks.map((t) => (t.id === "main" ? { ...t, archivedAt: "2026-10-24T02:00:00.000Z" } : t)), links);
    const hiddenArchived = scopeOf(tree, false);
    const hidden = foldByLevel(tree, 1, new Set(), new Set(), hiddenArchived);
    expect(tree.ids.filter((id) => hiddenArchived(id) && !hidden.has(id))).toEqual([...research, ...steps]);
    expect(levelChoices(tree, hiddenArchived).map((c) => c.level)).toEqual([1, 2, null]);
    expect(visibleCount(tree, foldByLevel(tree, 1, new Set(), new Set(), scopeOf(tree, true)))).toBe(1);
  });

  test("a project without sub-cards offers no Levels", () => {
    const tree = buildCardTree([task("a"), task("b")], [blocks("a", "b")]);
    expect(levelChoices(tree, all)).toEqual([]);
  });
});

describe("roll-up", () => {
  const setup = () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, links);
    const flags = new Map<string, number>([
      ["C5b.2", cardFlag.needs],
      ["C5a.1", cardFlag.active | cardFlag.unread],
      ["C5b", cardFlag.error],
      ["C4b", cardFlag.held],
    ]);
    return { tree, flags };
  };

  test("a hidden card counts once, on its nearest card on screen, skipping hidden levels between", () => {
    const { tree, flags } = setup();
    const hidden = foldByLevel(tree, 2, new Set(), new Set(), all);
    const onScreen = new Set(tree.ids.filter((id) => !hidden.has(id)));
    const below = rollupBelow(tree, hidden, onScreen, flags);
    expect(below.get("C5")).toEqual({ hidden: 8, needs: 1, errors: 1, held: 0, running: 1, unread: 1 });
    expect(below.get("C4")).toEqual({ hidden: 2, needs: 0, errors: 0, held: 1, running: 0, unread: 0 });
    expect(below.has("main")).toBe(false);
    expect([...below.values()].reduce((n, b) => n + b.hidden, 0)).toBe(hidden.size);
  });

  test("when the nearest ancestor is filtered out the count climbs higher, or to nobody", () => {
    const { tree, flags } = setup();
    const hidden = foldByLevel(tree, 2, new Set(), new Set(), all);
    const withoutC5 = new Set(tree.ids.filter((id) => !hidden.has(id) && id !== "C5"));
    expect(rollupBelow(tree, hidden, withoutC5, flags).get("main")).toMatchObject({ hidden: 8, needs: 1 });
    expect(rollupBelow(tree, hidden, new Set(["C1"]), flags).size).toBe(0);
  });

  test("sub-tree totals put each descendant in one class", () => {
    const { tree, flags } = setup();
    const withDone = new Map(flags).set("C1", cardFlag.done).set("C2", cardFlag.cancelled).set("C5b.2", cardFlag.needs | cardFlag.active);
    const totals = subtreeTotals(tree, withDone);
    expect(totals.get("main")).toEqual({ total: 18, done: 2, needs: 2, active: 1, waiting: 1, rest: 12 });
    expect(totals.get("C5a")).toEqual({ total: 3, done: 0, needs: 0, active: 1, waiting: 0, rest: 2 });
    expect(totals.has("C5a.1")).toBe(false);
  });
});

describe("chains and the item line", () => {
  test("chainOf: transitive blockers, blockers inherited from ancestors, and blocked cards with their sub-cards", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, links);
    expect(chainOf(tree, "C3")).toEqual({
      up: ["C2", "C1"],
      inherited: [],
      down: ["C4", "C5", "C4a", "C4b", "C5a", "C5b", "C5a.1", "C5a.2", "C5a.3", "C5b.1", "C5b.2", "C5b.3"],
    });
    expect(chainOf(tree, "C5a.2")).toEqual({ up: ["C5a.1"], inherited: ["C4", "C3", "C2", "C1"], down: ["C5a.3"] });
  });

  test("nextUp: now, next in line, and what needs the person, in outline order", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, links);
    const flags = new Map<string, number>([
      ["inventory", cardFlag.done],
      ["behaviour", cardFlag.active],
      ["C1", cardFlag.done],
      ["C2", cardFlag.done],
      ["C3", cardFlag.active],
      ["C5b.2", cardFlag.needs],
    ]);
    // C4 waits only on C3, which is moving, but has unfinished sub-cards: its first one is next.
    expect(nextUp(tree, "main", flags)).toEqual({ now: ["behaviour", "C3"], next: ["architecture", "C4a"], needs: ["C5b.2"] });
    // A Cancelled blocker never lets its card (or the card's sub-cards) go next.
    flags.set("C3", cardFlag.cancelled);
    expect(nextUp(tree, "main", flags)).toMatchObject({ now: ["behaviour"], next: ["architecture"] });
  });
});

describe("outline rows", () => {
  const ids = (rows: readonly OutlineRow[]) => rows.map((r) => r.id);
  const row = (rows: readonly OutlineRow[], id: string) => rows.find((r) => r.id === id)!;

  test("Levels All: every card in step order, with rails, elbows and step connectors", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, links);
    const rows = outlineRows(tree, { inScope: all, flags: new Map(), level: null });
    expect(ids(rows)).toEqual([
      "group:items", "main", "inventory", "behaviour", "architecture", "C1", "C2", "C3", "C4", "C4a", "C4b",
      "C5", "C5a", "C5a.1", "C5a.2", "C5a.3", "C5b", "C5b.1", "C5b.2", "C5b.3",
    ]);
    expect(row(rows, "inventory")).toMatchObject({ depth: 1, step: 1, steps: 5, joinNext: true, nextStepHigher: false });
    expect(row(rows, "C1")).toMatchObject({ joinNext: true, nextStepHigher: true });
    expect(row(rows, "C5")).toMatchObject({ last: true, joinNext: false });
    expect(row(rows, "C4a")).toMatchObject({ depth: 2, rails: 0b1, last: false });
    expect(row(rows, "C5a.1")).toMatchObject({ depth: 3, rails: 0b10 });
    expect(row(rows, "C5b.1")).toMatchObject({ depth: 3, rails: 0 });
  });

  test("default expansion follows the level and a row's chevron overrides it", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, links);
    const level2 = outlineRows(tree, { inScope: all, flags: new Map(), level: 2 });
    expect(ids(level2)).toEqual(["group:items", "main", "inventory", "behaviour", "architecture", "C1", "C2", "C3", "C4", "C5"]);
    expect(row(level2, "C4")).toMatchObject({ hasKids: true, open: false });
    expect(ids(outlineRows(tree, { inScope: all, flags: new Map(), level: 2, overrides: new Map([["C4", true]]) }))).toContain("C4b");
    expect(ids(outlineRows(tree, { inScope: all, flags: new Map(), level: null, overrides: new Map([["main", false]]) }))).toEqual(["group:items", "main"]);
  });

  test("a chain highlight opens the ancestors of every card on it and dims the rest", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, links);
    const rows = outlineRows(tree, { inScope: all, flags: new Map(), level: 1, chain: { focus: "C5a.2", ...chainOf(tree, "C5a.2") } });
    expect(ids(rows)).toContain("C5a.3");
    expect(row(rows, "C5a.1")).toMatchObject({ inChain: true, dim: false, inherited: false });
    expect(row(rows, "C2")).toMatchObject({ inChain: true, inherited: true });
    expect(row(rows, "C5b")).toMatchObject({ inChain: false, dim: true });
    expect(ids(rows)).not.toContain("C4a");
  });

  test("lone cards and finished trees sit in collapsed groups; items are newest first", () => {
    const { tasks, links } = ownerProject();
    const extra = [task("solo"), task("old", "done"), task("old.1", "done"), task("pair-a"), task("pair-b")];
    const all19 = [...tasks, ...extra];
    const tree = buildCardTree(all19, [...links, sub("old.1", "old"), blocks("pair-a", "pair-b")]);
    const flags = statusFlags(tree, byId(all19), new Map());
    const rows = outlineRows(tree, { inScope: all, flags, level: 1 });
    expect(rows.filter((r) => r.kind === "group").map((r) => [r.id, r.count, r.open])).toEqual([
      ["group:items", 3, true],
      ["group:other", 1, false],
      ["group:finished", 1, false],
    ]);
    expect(ids(rows)).toEqual(["group:items", "pair-b", "pair-a", "main", "group:other", "group:finished"]);
    const opened = outlineRows(tree, { inScope: all, flags, level: 1, overrides: new Map([["group:finished", true]]) });
    expect(ids(opened).slice(-2)).toEqual(["group:finished", "old"]);
  });

  test("sameRowList keeps unchanged rows and the list itself when nothing on it changed", () => {
    const { tasks, links } = ownerProject();
    const tree = buildCardTree(tasks, links);
    const first = outlineRows(tree, { inScope: all, flags: new Map(), level: 2 });
    const again = sameRowList(first, outlineRows(tree, { inScope: all, flags: new Map([["C4a", cardFlag.active]]), level: 2 }));
    expect(again).toBe(first);
    const opened = sameRowList(first, outlineRows(tree, { inScope: all, flags: new Map(), level: 2, overrides: new Map([["C4", true]]) }));
    expect(opened).not.toBe(first);
    expect(row(opened, "main")).toBe(row(first, "main"));
    expect(row(opened, "C4")).not.toBe(row(first, "C4"));
  });
});
