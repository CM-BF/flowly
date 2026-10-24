import { describe, expect, test } from "vitest";
import { buildCardTree, cardFlag, chainOf, groupRowId, nextUp, outlineRows, scopeOf, type CardTree } from "../shared/card-tree";
import type { Link, Status, Task } from "../shared/model";
import { setLocale } from "../shared/i18n";
import { chainRows, connectors, nowNextText, revealOverrides, rowLabel, samePageProps, sectionOf, stepState, totalsText, waitChips, withRevealed, withoutFolds } from "./card-tree-view";

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
const all = () => true;

function project(statuses: Record<string, Status> = {}, extra: Partial<Record<string, Partial<Task>>> = {}) {
  clock = 0;
  const ids = ["main", "C1", "C2", "C3", "C3a", "C3b", "lone", "old"];
  const tasks = ids.map((id) => task(id, statuses[id] ?? (id === "old" ? "done" : "todo"), extra[id]));
  const links = [sub("C1", "main"), sub("C2", "main"), sub("C3", "main"), sub("C3a", "C3"), sub("C3b", "C3"), blocks("C1", "C2"), blocks("C2", "C3"), blocks("C3a", "C3b")];
  const tree = buildCardTree(tasks, links);
  return { tasks, tree, byId: new Map(tasks.map((x) => [x.id, x] as const)) };
}
const flagsOf = (tree: CardTree, byId: Map<string, Task>, extra: Record<string, number> = {}) =>
  new Map(tree.ids.map((id) => [id, (byId.get(id)!.status === "done" ? cardFlag.done : byId.get(id)!.status === "cancelled" ? cardFlag.cancelled : 0) | (extra[id] ?? 0)] as const));

describe("Card tree rows (CARD-TREE-SPEC §2.2)", () => {
  test("step circle states", () => {
    expect([cardFlag.done, cardFlag.cancelled, cardFlag.needs | cardFlag.active, cardFlag.error, cardFlag.active, cardFlag.held | cardFlag.waiting, cardFlag.waiting, 0].map(stepState)).toEqual([
      "done", "cancelled", "needs", "needs", "active", "held", "waiting", "ready",
    ]);
  });

  test("sections and the overrides that bring a card into view", () => {
    const { tree, byId } = project();
    const flags = flagsOf(tree, byId);
    expect(["main", "lone", "old"].map((r) => sectionOf(tree, r, flags, all))).toEqual(["items", "other", "finished"]);
    expect(revealOverrides(tree, "C3b", flags, all)).toEqual([[groupRowId("items"), true], ["main", true], ["C3", true]]);
    expect(revealOverrides(tree, "lone", flags, all)).toEqual([[groupRowId("other"), true]]);
    // Applied, the row is in the outline even at Level 1.
    const overrides = new Map(revealOverrides(tree, "C3b", flags, all));
    expect(outlineRows(tree, { inScope: all, flags, level: 1, overrides }).map((r) => r.id)).toContain("C3b");
  });

  test("connectors join adjacent siblings; a later step gets an arrow, an open row passes it to its sub-cards", () => {
    const { tree, byId } = project();
    const flags = flagsOf(tree, byId);
    const closed = outlineRows(tree, { inScope: all, flags, level: 2 });
    const ids = closed.map((r) => r.id);
    const join = connectors(closed);
    const at = (id: string) => join[ids.indexOf(id)];
    expect(at("C1")).toEqual({ above: false, below: true, arrow: false });
    expect(at("C2")).toEqual({ above: true, below: true, arrow: true });
    expect(at("C3")).toEqual({ above: true, below: false, arrow: true });
    const open = outlineRows(tree, { inScope: all, flags, level: null });
    const openIds = open.map((r) => r.id);
    const j = connectors(open);
    expect(j[openIds.indexOf("C3a")]).toEqual({ above: false, below: true, arrow: false });
    expect(j[openIds.indexOf("C3b")]).toEqual({ above: true, below: false, arrow: true });
  });

  test("waits-for chips: unfinished blockers, other groups named, stuck only when they hold a queued card", () => {
    setLocale("en");
    clock = 0;
    const tasks = [task("A"), task("A1"), task("B"), task("B1"), task("x", "cancelled"), task("y", "done", { archivedAt: now }), task("z", "todo", { archivedAt: now })];
    const tree = buildCardTree(tasks, [sub("A1", "A"), sub("B1", "B"), blocks("B1", "A1"), blocks("x", "A1"), blocks("y", "A1"), blocks("z", "A1"), blocks("B", "A")]);
    const byId = new Map(tasks.map((x) => [x.id, x] as const));
    expect(waitChips(tree, "A1", byId, false).map((c) => c.text)).toEqual(["B1 (in B)"]);
    expect(waitChips(tree, "A1", byId, true).map((c) => [c.text, c.tone])).toEqual([
      ["B1 (in B)", "muted"],
      ["x · Cancelled, holds this", "warning"],
      ["z · Archived, holds this", "warning"],
    ]);
    // A sibling (here a top-level card) is named alone.
    expect(waitChips(tree, "A", byId, false).map((c) => c.text)).toEqual(["B"]);
  });

  test("the item line: Now, Next (queued) and Needs you, two titles then +n", () => {
    setLocale("en");
    const { tree, byId } = project();
    const flags = flagsOf(tree, byId, { C1: cardFlag.active, C3a: cardFlag.needs });
    const line = nowNextText(nextUp(tree, "main", flags), (id) => byId.get(id)!.title, (id) => id === "C2");
    expect(line).toBe("Now: C1 · Next: C2 (queued) · Needs you: C3a");
    expect(nowNextText({ now: ["a", "b", "c", "d"], next: [], needs: [] }, (id) => id, () => false)).toBe("Now: a, b, +2");
    expect(nowNextText({ now: [], next: [], needs: [] }, (id) => id, () => false)).toBe("");
  });

  test("collapsed totals and the row's accessibility label", () => {
    setLocale("en");
    expect(totalsText({ total: 8, done: 3, active: 2, needs: 1 })).toBe("3/8 done · 2 running · 1 needs you");
    expect(totalsText({ total: 2, done: 0, active: 0, needs: 0 })).toBe("0/2 done");
    expect(rowLabel({ title: "C3", lane: "Development", signal: "Agent working", step: 3, steps: 5, parent: "main card", waits: [{ id: "C2", text: "C2", tone: "muted" }], cyclic: false })).toBe(
      "C3, Development, Agent working, Step 3 of 5, under main card, waits for C2",
    );
    expect(rowLabel({ title: "A", lane: "Todo", step: 1, steps: 2, waits: [], cyclic: true })).toBe("A, Todo, Step 1 of 2, order is circular");
  });

  test("an archived parent is out of scope: its sub-cards take its place", () => {
    const { tree, byId } = project({}, { C3: { archivedAt: now } });
    const flags = flagsOf(tree, byId);
    const inScope = scopeOf(tree, false);
    const rows = outlineRows(tree, { inScope, flags, level: null });
    expect(rows.map((r) => r.id)).not.toContain("C3");
    expect(rows.find((r) => r.id === "C3a")?.depth).toBe(1);
  });
});

describe("chain highlight, chevrons and Show in tree (CARD-TREE-SPEC §2.2)", () => {
  const setup = () => {
    const { tree, byId } = project();
    const flags = flagsOf(tree, byId);
    const chain = { ...chainOf(tree, "C3b"), focus: "C3b" };
    const ids = (opts: Partial<Parameters<typeof outlineRows>[1]>) => outlineRows(tree, { inScope: all, flags, level: 1, ...opts }).map((r) => r.id);
    const row = (id: string, opts: Partial<Parameters<typeof outlineRows>[1]>) => outlineRows(tree, { inScope: all, flags, level: 1, ...opts }).find((r) => r.id === id);
    return { tree, flags, chain, ids, row };
  };

  test("Show in tree keeps the card revealed after the chain is cleared", () => {
    const { tree, flags, chain, ids } = setup();
    expect(ids({ chain })).toContain("C3b");
    const overrides = withRevealed(new Map(), tree, "C3b", flags, all);
    expect(ids({ chain: null, overrides })).toContain("C3b");
    expect(withRevealed(overrides, tree, "C3b", flags, all)).toBe(overrides);
  });

  test("a chevron folds a row the chain holds open, and the row stays as it was left", () => {
    const { chain, row } = setup();
    expect(row("C3", { chain })!.open).toBe(true);
    const folded = new Map([["C3", false]]);
    expect(row("C3", { chain, overrides: folded })!.open).toBe(false);
    expect(row("C3b", { chain, overrides: folded })).toBeUndefined();
    expect(row("C3", { level: null, chain: null, overrides: folded })!.open).toBe(false);
    // Group rows too.
    expect(row(groupRowId("items"), { chain, overrides: new Map([[groupRowId("items"), false]]) })!.open).toBe(false);
  });

  test("a new chain drops the earlier folds on the rows it opens, and only those", () => {
    const { tree, flags, chain, ids } = setup();
    const opens = chainRows(tree, chain, flags, all);
    expect([...opens].sort()).toEqual(["C3", groupRowId("items"), "main"]);
    const before = new Map([["C3", false], [groupRowId("other"), true], ["C1", false]]);
    const after = withoutFolds(before, opens);
    expect([...after]).toEqual([[groupRowId("other"), true], ["C1", false]]);
    expect(ids({ chain, overrides: after })).toContain("C3b");
    expect(withoutFolds(after, opens)).toBe(after);
  });
});

describe("CardTreePage memo (PERFORMANCE-SPEC §5)", () => {
  test("holds still while covered, else compares shallowly", () => {
    const fn = () => {};
    expect(samePageProps({ active: false, n: 1 }, { active: false, n: 2 })).toBe(true);
    expect(samePageProps({ active: true, n: 1, fn }, { active: true, n: 1, fn })).toBe(true);
    expect(samePageProps({ active: true, n: 1 }, { active: true, n: 2 })).toBe(false);
    expect(samePageProps({ active: false, n: 1 }, { active: true, n: 1 })).toBe(false);
  });
});

describe("drawer Dependencies (CARD-TREE-SPEC §2.6)", () => {
  test("path, neighbours, upstream count, sub-card strip in step order, and what holds a queued card", async () => {
    const { dependencyView, dependencySummary } = await import("./card-tree-view");
    setLocale("en");
    clock = 0;
    const tasks = [task("root"), task("P"), task("Q", "done"), task("X", "cancelled"), task("me"), task("k1"), task("k2"), task("after")];
    const tree = buildCardTree(tasks, [sub("me", "root"), sub("P", "root"), sub("Q", "root"), sub("X", "root"), sub("k1", "me"), sub("k2", "me"), blocks("Q", "P"), blocks("P", "me"), blocks("X", "me"), blocks("me", "after"), blocks("k1", "k2")]);
    const byId = new Map(tasks.map((x) => [x.id, x] as const));
    const view = dependencyView(tree, "me", byId, true)!;
    expect(view.path).toEqual(["root"]);
    expect(view.left).toEqual([{ id: "P", state: "open" }, { id: "X", state: "stuck" }]);
    expect(view.right).toEqual([{ id: "after", state: "open" }]);
    expect(view.upstream).toBe(0); // Q, above P, is Done
    expect(view.strip).toEqual([{ id: "k1", step: 1 }, { id: "k2", step: 2 }]);
    expect(view.holding).toEqual(["X"]);
    expect(dependencyView(tree, "me", byId, false)!.holding).toEqual([]);
    expect(dependencySummary(view)).toBe("Waits for 2 · Blocks 1");
    expect(dependencySummary({ left: [], right: [{ id: "a", state: "open" }], holding: [] })).toBe("Blocks 1");
  });

  test("a Cancelled or archived blocker that does not hold the card is not waited for", async () => {
    const { dependencyView, dependencySummary } = await import("./card-tree-view");
    setLocale("en");
    clock = 0;
    const tasks = [task("X", "cancelled"), task("Y", "todo", { archivedAt: now }), task("me"), task("after")];
    const tree = buildCardTree(tasks, [blocks("X", "me"), blocks("Y", "me"), blocks("me", "after")]);
    const byId = new Map(tasks.map((x) => [x.id, x] as const));
    expect(dependencySummary(dependencyView(tree, "me", byId, false)!)).toBe("Blocks 1");
    expect(dependencySummary(dependencyView(tree, "me", byId, true)!)).toBe("Waits for 2 · Blocks 1");
  });

  test("unfinished blockers further up are counted; a card with no relation has no section", async () => {
    const { dependencyView } = await import("./card-tree-view");
    clock = 0;
    const tasks = [task("a"), task("b"), task("c"), task("lone")];
    const tree = buildCardTree(tasks, [blocks("a", "b"), blocks("b", "c")]);
    const byId = new Map(tasks.map((x) => [x.id, x] as const));
    expect(dependencyView(tree, "c", byId, false)!.upstream).toBe(1);
    expect(dependencyView(tree, "lone", byId, false)).toBeNull();
    expect(dependencyView(tree, "missing", byId, false)).toBeNull();
  });
});
