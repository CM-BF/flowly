import type { AutomationJob } from "./automation-schema";
import { subCardLimits } from "./links";
import type { Board, Link, Task } from "./model";

/**
 * The card tree of one project (CARD-TREE-SPEC §2.1, §3): sub-card parents and children, `blocks`
 * edges, sibling edges lifted to the level where two branches part, and step numbers per sibling
 * group. Display only: nothing here writes the board. Runtime-neutral (no React), shared by the
 * board, the drawer and the Card tree page.
 *
 * The tree depends only on links and the project's card shape (ids, archived, createdAt), so it is
 * cached across status, title and live-agent changes; everything that reads a card's state takes
 * the fresh cards (`tasksById`) or per-card flags instead.
 */

/** Group key of the top-level cards (card ids are never empty). */
export const rootGroup = "";

export type TreeTask = Pick<Task, "id" | "createdAt"> & Partial<Pick<Task, "archivedAt">>;
export type TreeLink = Pick<Link, "id" | "kind" | "from" | "to">;
/** The fresh state of a card, read at use (the tree itself may be older). */
export type CardState = Pick<Task, "id" | "title" | "status" | "archivedAt">;

export type TreeAnomaly =
  /** A sub-card link whose card already has a parent: the first link wins, like `parentOf`. */
  | { kind: "second-parent"; link: string; card: string }
  /** A sub-card loop; `card` is the card that closed it, shown as a top-level card. */
  | { kind: "subtask-cycle"; card: string }
  /** One end is missing or in another project; the link is left out of the tree. */
  | { kind: "outside"; link: string }
  | { kind: "self"; link: string }
  /** A `blocks` link between a card and its own ancestor (the daemon refuses these). */
  | { kind: "ancestor"; link: string };

export interface CardTree {
  /** The project's cards, in input order. */
  ids: readonly string[];
  createdAt: ReadonlyMap<string, string>;
  archived: ReadonlySet<string>;
  parent: ReadonlyMap<string, string>;
  /** Direct sub-cards in link (creation) order. */
  children: ReadonlyMap<string, readonly string[]>;
  depth: ReadonlyMap<string, number>;
  roots: readonly string[];
  /** Root..id. */
  chain(id: string): readonly string[];
  /** Every `blocks` edge inside the project, whatever the state of its ends. */
  blockers: ReadonlyMap<string, readonly string[]>;
  blocked: ReadonlyMap<string, readonly string[]>;
  /** Group (parent id, or `rootGroup`) → lifted sibling edges, unique. */
  siblingEdges: ReadonlyMap<string, readonly (readonly [string, string])[]>;
  step: ReadonlyMap<string, number>;
  /** Group → its highest step. */
  steps: ReadonlyMap<string, number>;
  /** Members of the group, by (step, createdAt, id). */
  ordered: ReadonlyMap<string, readonly string[]>;
  /** Cards on a step cycle of their group. */
  cyclic: ReadonlySet<string>;
  /** Ids of `blocks` links whose sibling edge connects other cards than the link's own ends. */
  lifted: ReadonlySet<string>;
  anomalies: readonly TreeAnomaly[];
}

const groupOf = (tree: Pick<CardTree, "parent">, id: string) => tree.parent.get(id) ?? rootGroup;

export function buildCardTree(tasks: readonly TreeTask[], links: readonly TreeLink[]): CardTree {
  const ids = tasks.map((t) => t.id);
  const known = new Set(ids);
  const createdAt = new Map(tasks.map((t) => [t.id, t.createdAt] as const));
  const archived = new Set(tasks.filter((t) => t.archivedAt).map((t) => t.id));
  const anomalies: TreeAnomaly[] = [];
  // Links of other projects touch none of these cards and are skipped silently.
  const usable = (l: TreeLink) => {
    const from = known.has(l.from), to = known.has(l.to);
    if (!from && !to) return false;
    if (!from || !to) return anomalies.push({ kind: "outside", link: l.id }), false;
    if (l.from === l.to) return anomalies.push({ kind: "self", link: l.id }), false;
    return true;
  };
  const subtasks = links.filter((l) => l.kind === "subtask" && usable(l));
  const blockLinks = links.filter((l) => l.kind === "blocks" && usable(l));

  const parent = new Map<string, string>();
  for (const l of subtasks) {
    if (parent.has(l.from)) anomalies.push({ kind: "second-parent", link: l.id, card: l.from });
    else parent.set(l.from, l.to);
  }
  // A sub-card loop: the card whose parent link closes it becomes a top-level card.
  const state = new Map<string, 1 | 2>();
  for (const id of ids) {
    const path: string[] = [];
    let at: string | undefined = id;
    while (at !== undefined && !state.has(at)) {
      state.set(at, 1);
      path.push(at);
      at = parent.get(at);
    }
    if (at !== undefined && state.get(at) === 1) {
      const closer = path[path.length - 1];
      parent.delete(closer);
      anomalies.push({ kind: "subtask-cycle", card: closer });
    }
    for (const p of path) state.set(p, 2);
  }
  const children = new Map<string, string[]>();
  const placed = new Set<string>();
  for (const l of subtasks) {
    if (parent.get(l.from) !== l.to || placed.has(l.from)) continue;
    placed.add(l.from);
    const list = children.get(l.to);
    if (list) list.push(l.from);
    else children.set(l.to, [l.from]);
  }
  const roots = ids.filter((id) => !parent.has(id));
  const chains = new Map<string, readonly string[]>();
  const chain = (id: string): readonly string[] => {
    const cached = chains.get(id);
    if (cached) return cached;
    const up: string[] = [];
    for (let at: string | undefined = id; at !== undefined; at = parent.get(at)) up.push(at);
    up.reverse();
    chains.set(id, up);
    return up;
  };
  const depth = new Map(ids.map((id) => [id, chain(id).length - 1] as const));

  const blockers = new Map<string, string[]>();
  const blocked = new Map<string, string[]>();
  const pairs = new Set<string>();
  const siblingEdges = new Map<string, (readonly [string, string])[]>();
  const edgeKeys = new Set<string>();
  const lifted = new Set<string>();
  for (const l of blockLinks) {
    // Blockers keep every edge, as `readiness()` and `waitingOn()` do; only the lifting skips ancestor edges.
    const pair = `${l.from}\n${l.to}`;
    if (!pairs.has(pair)) {
      pairs.add(pair);
      push(blockers, l.to, l.from);
      push(blocked, l.from, l.to);
    }
    const cu = chain(l.from), cv = chain(l.to);
    const shorter = Math.min(cu.length, cv.length);
    let i = 0;
    while (i < shorter && cu[i] === cv[i]) i++;
    if (i === shorter) {
      anomalies.push({ kind: "ancestor", link: l.id });
      continue;
    }
    const a = cu[i], b = cv[i], group = i === 0 ? rootGroup : cu[i - 1];
    if (a !== l.from || b !== l.to) lifted.add(l.id);
    const key = `${group}\n${a}\n${b}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    push(siblingEdges, group, [a, b] as const);
  }

  const step = new Map<string, number>();
  const steps = new Map<string, number>();
  const ordered = new Map<string, string[]>();
  const cyclic = new Set<string>();
  const order = (a: string, b: string) =>
    step.get(a)! - step.get(b)! || compare(createdAt.get(a)!, createdAt.get(b)!) || compare(a, b);
  const groups: [string, readonly string[]][] = [[rootGroup, roots], ...children];
  for (const [group, members] of groups) {
    steps.set(group, stepGroup(members, siblingEdges.get(group) ?? [], step, cyclic));
    ordered.set(group, [...members].sort(order));
  }
  return { ids, createdAt, archived, parent, children, depth, roots, chain, blockers, blocked, siblingEdges, step, steps, ordered, cyclic, lifted, anomalies };
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Kahn longest-path layering: step = 1 + the highest step before it. When only cycles are left, the
 * first remaining member (member order) that is on a cycle goes after everything placed so far and Kahn
 * continues, so a card that only waits for a cycle still comes after it.
 * Returns the group's highest step.
 */
function stepGroup(members: readonly string[], edges: readonly (readonly [string, string])[], step: Map<string, number>, cyclic: Set<string>) {
  const succ = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const [a, b] of edges) {
    push(succ, a, b);
    indegree.set(b, (indegree.get(b) ?? 0) + 1);
  }
  const least = new Map<string, number>();
  const placed = new Set<string>();
  const queue = members.filter((m) => !indegree.get(m));
  let head = 0;
  let max = 0;
  let stalled: string[] | null = null;
  const place = (x: string, s: number) => {
    step.set(x, s);
    placed.add(x);
    max = Math.max(max, s);
    for (const y of succ.get(x) ?? []) {
      least.set(y, Math.max(least.get(y) ?? 1, s + 1));
      const left = indegree.get(y)! - 1;
      indegree.set(y, left);
      if (!left) queue.push(y);
    }
  };
  while (placed.size < members.length) {
    while (head < queue.length) {
      const x = queue[head++];
      if (!placed.has(x)) place(x, least.get(x) ?? 1);
    }
    if (placed.size === members.length) break;
    const rest = members.filter((m) => !placed.has(m));
    if (!stalled) stalled = rest;
    // Release a card on a cycle, never one merely downstream of it: that one keeps its place after its blockers.
    // Kahn stalls only when every remaining card has a remaining predecessor, so a cycle is always left.
    const unplaced = new Set(rest);
    const x = rest.find((m) => reaches(m, m, succ, unplaced)) ?? rest[0];
    place(x, Math.max(max + 1, least.get(x) ?? 1));
  }
  if (stalled) {
    // Only the cards on a cycle are marked, not the ones merely ordered after one.
    const inside = new Set(stalled);
    for (const x of stalled) if (reaches(x, x, succ, inside)) cyclic.add(x);
  }
  return max;
}

function reaches(from: string, target: string, succ: ReadonlyMap<string, readonly string[]>, inside: ReadonlySet<string>) {
  const seen = new Set<string>();
  const stack = [...(succ.get(from) ?? [])];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === target) return true;
    if (seen.has(x) || !inside.has(x)) continue;
    seen.add(x);
    stack.push(...(succ.get(x) ?? []));
  }
  return false;
}

let lastTree: { links: readonly TreeLink[]; projectId: string; key: string; tree: CardTree } | null = null;

/** The project's tree, rebuilt only when the links array or the project's card shape changes. */
export function cardTreeOf(board: Pick<Board, "tasks" | "links">, projectId: string): CardTree {
  const tasks = board.tasks.filter((t) => t.projectId === projectId);
  const key = tasks.map((t) => `${t.id}:${t.archivedAt ? 1 : 0}:${t.createdAt}`).join("\n");
  if (lastTree && lastTree.links === board.links && lastTree.projectId === projectId && lastTree.key === key) return lastTree.tree;
  const tree = buildCardTree(tasks, board.links);
  lastTree = { links: board.links, projectId, key, tree };
  return tree;
}

/** Cards in the current scope: the project, archived ones only with Show archived. */
export type InScope = (id: string) => boolean;
export const scopeOf = (tree: Pick<CardTree, "archived">, showArchived: boolean): InScope =>
  showArchived ? () => true : (id) => !tree.archived.has(id);

// ---------------------------------------------------------------------------------------------
// Blockers and Held (CARD-TREE-SPEC §2.1, CARD-LINKS-SPEC §2.5)

/** done; open (unfinished); stuck (Cancelled, or archived before Done); gone (no such card). */
export type BlockerState = "done" | "open" | "stuck" | "gone";

export function blockerState(task: Pick<Task, "status" | "archivedAt"> | undefined): BlockerState {
  if (!task) return "gone";
  if (task.status === "done") return "done";
  if (task.status === "cancelled" || task.archivedAt) return "stuck";
  return "open";
}

const live = (task: Pick<Task, "status" | "archivedAt"> | undefined) =>
  !!task && !task.archivedAt && task.status !== "done" && task.status !== "cancelled";

/**
 * A queued card the dispatcher never releases until a person removes the link: one of its
 * blockers is Cancelled or archived unfinished. The same as `readiness()` giving reason
 * "blockers" with `cancelled` not empty (AUTOMATION-SPEC §4.1).
 */
export function isHeld(tree: Pick<CardTree, "blockers">, tasksById: ReadonlyMap<string, Pick<Task, "status" | "archivedAt">>, job: Pick<AutomationJob, "taskId" | "state"> | undefined) {
  if (job?.state !== "queued" || !live(tasksById.get(job.taskId))) return false;
  return (tree.blockers.get(job.taskId) ?? []).some((b) => blockerState(tasksById.get(b)) === "stuck");
}

export interface BlockerInfo {
  /** Unfinished blockers ("Waiting on {n}"), the same count as `waitingOn()`. */
  open: number;
  stuck: number;
  /** Titles of the open blockers, joined. */
  titles: string;
  stuckTitles: readonly string[];
  held: boolean;
}

/** Per card with an open or stuck blocker, in one pass over the tree's edges. */
export function blockerIndex(
  tree: Pick<CardTree, "blockers">,
  tasksById: ReadonlyMap<string, CardState>,
  jobsById: ReadonlyMap<string, Pick<AutomationJob, "taskId" | "state">>,
): Map<string, BlockerInfo> {
  const index = new Map<string, BlockerInfo>();
  for (const [id, list] of tree.blockers) {
    const open: string[] = [];
    const stuck: string[] = [];
    for (const b of list) {
      const blocker = tasksById.get(b);
      const state = blockerState(blocker);
      if (state === "open") open.push(blocker!.title);
      else if (state === "stuck") stuck.push(blocker!.title);
    }
    if (!open.length && !stuck.length) continue;
    const job = jobsById.get(id);
    const held = job?.state === "queued" && !!stuck.length && live(tasksById.get(id));
    index.set(id, { open: open.length, stuck: stuck.length, titles: open.join(", "), stuckTitles: stuck, held });
  }
  return index;
}

// ---------------------------------------------------------------------------------------------
// Per-card flags. The client adds NEEDS, ERROR, UNREAD and ACTIVE (client/card-flags.ts); the
// board-derived bits come from `statusFlags`.

export const cardFlag = {
  /** Unanswered question or permission, or automation needs a person. */
  needs: 1,
  error: 2,
  unread: 4,
  /** A running session or a job holding a slot. */
  active: 8,
  held: 16,
  /** Has an open blocker. */
  waiting: 32,
  /** Has a stuck blocker. */
  stuck: 64,
  done: 128,
  cancelled: 256,
  archived: 512,
} as const;
const finishedFlags = cardFlag.done | cardFlag.cancelled;
export type Flags = ReadonlyMap<string, number>;

export function statusFlags(
  tree: Pick<CardTree, "ids" | "blockers">,
  tasksById: ReadonlyMap<string, CardState>,
  jobsById: ReadonlyMap<string, Pick<AutomationJob, "taskId" | "state">>,
): Map<string, number> {
  const flags = new Map<string, number>();
  const blockers = blockerIndex(tree, tasksById, jobsById);
  for (const id of tree.ids) {
    const task = tasksById.get(id);
    if (!task) continue;
    const b = blockers.get(id);
    let f = 0;
    if (task.status === "done") f |= cardFlag.done;
    if (task.status === "cancelled") f |= cardFlag.cancelled;
    if (task.archivedAt) f |= cardFlag.archived;
    if (b?.open) f |= cardFlag.waiting;
    if (b?.stuck) f |= cardFlag.stuck;
    if (b?.held) f |= cardFlag.held;
    flags.set(id, f);
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------
// Levels (CARD-TREE-SPEC §2.3). "Level L" shows cards with fewer than L in-scope ancestors; null is All.

export type Level = number | null;

/** In-scope ancestors per in-scope card: an archived parent hidden by Show archived does not count. */
export function levelDepths(tree: Pick<CardTree, "ids" | "chain">, inScope: InScope): Map<string, number> {
  const depths = new Map<string, number>();
  for (const id of tree.ids) {
    if (!inScope(id)) continue;
    const up = tree.chain(id);
    let d = 0;
    for (let i = 0; i < up.length - 1; i++) if (inScope(up[i])) d++;
    depths.set(id, d);
  }
  return depths;
}

/** Number of in-scope cards per level depth. */
export function levelHistogram(tree: Pick<CardTree, "ids" | "chain">, inScope: InScope): number[] {
  const hist: number[] = [];
  for (const d of levelDepths(tree, inScope).values()) hist[d] = (hist[d] ?? 0) + 1;
  return Array.from(hist, (n) => n ?? 0);
}

/** The Levels choices, each with how many in-scope cards it hides; none when nothing is nested. */
export function levelChoices(tree: Pick<CardTree, "ids" | "chain">, inScope: InScope, cap: number = subCardLimits.depth): { level: Level; hides: number }[] {
  const hist = levelHistogram(tree, inScope);
  const deepest = Math.min(hist.length - 1, cap);
  if (deepest < 1) return [];
  const choices: { level: Level; hides: number }[] = [];
  for (let level = 1; level <= deepest; level++) choices.push({ level, hides: hist.slice(level).reduce((a, b) => a + b, 0) });
  choices.push({ level: null, hides: 0 });
  return choices;
}

/**
 * The in-scope cards the level hides. `revealed` cards show their whole sub-tree (Show its
 * sub-cards, the lane footer); `keep` cards (the open card, the dragged card) always show.
 */
export function foldByLevel(
  tree: Pick<CardTree, "ids" | "chain">,
  level: Level,
  revealed: ReadonlySet<string>,
  keep: ReadonlySet<string>,
  inScope: InScope,
): Set<string> {
  const hidden = new Set<string>();
  if (level === null) return hidden;
  for (const [id, d] of levelDepths(tree, inScope)) {
    if (d < level || keep.has(id)) continue;
    if (tree.chain(id).some((c) => revealed.has(c))) continue;
    hidden.add(id);
  }
  return hidden;
}

// ---------------------------------------------------------------------------------------------
// Roll-up (CARD-TREE-SPEC §2.4)

export interface Below {
  hidden: number;
  needs: number;
  errors: number;
  held: number;
  running: number;
  unread: number;
}
const noneBelow = (): Below => ({ hidden: 0, needs: 0, errors: 0, held: 0, running: 0, unread: 0 });

/**
 * Each hidden card counted once, on its nearest ancestor that is on screen (hidden levels in
 * between are skipped). A hidden card without an on-screen ancestor is left out: it counts only
 * in the Levels chip, and Attention and the lane footer still reach it.
 */
export function rollupBelow(tree: Pick<CardTree, "chain">, hidden: Iterable<string>, onScreen: ReadonlySet<string>, flags: Flags): Map<string, Below> {
  const below = new Map<string, Below>();
  for (const id of hidden) {
    const up = tree.chain(id);
    let target: string | undefined;
    for (let i = up.length - 2; i >= 0 && target === undefined; i--) if (onScreen.has(up[i])) target = up[i];
    if (target === undefined) continue;
    let entry = below.get(target);
    if (!entry) below.set(target, (entry = noneBelow()));
    const f = flags.get(id) ?? 0;
    entry.hidden++;
    if (f & cardFlag.needs) entry.needs++;
    if (f & cardFlag.error) entry.errors++;
    if (f & cardFlag.held) entry.held++;
    if (f & cardFlag.active) entry.running++;
    if (f & cardFlag.unread) entry.unread++;
  }
  return below;
}

/** Same counts, for memoized card props. */
export const sameBelow = (a: Below | undefined, b: Below | undefined) =>
  a === b || (!!a && !!b && a.hidden === b.hidden && a.needs === b.needs && a.errors === b.errors && a.held === b.held && a.running === b.running && a.unread === b.unread);

/**
 * A card's in-scope descendants (itself excluded), each in exactly one class, in this order:
 * done (Done or Cancelled), needs (needs you or error), active, waiting (held or open blockers), rest.
 */
export interface Totals {
  total: number;
  done: number;
  needs: number;
  active: number;
  waiting: number;
  rest: number;
}

export function classOf(f: number): Exclude<keyof Totals, "total"> {
  if (f & finishedFlags) return "done";
  if (f & (cardFlag.needs | cardFlag.error)) return "needs";
  if (f & cardFlag.active) return "active";
  if (f & (cardFlag.held | cardFlag.waiting | cardFlag.stuck)) return "waiting";
  return "rest";
}

export function subtreeTotals(tree: Pick<CardTree, "ids" | "chain">, flags: Flags, inScope: InScope = () => true): Map<string, Totals> {
  const totals = new Map<string, Totals>();
  for (const id of tree.ids) {
    if (!inScope(id)) continue;
    const kind = classOf(flags.get(id) ?? 0);
    const up = tree.chain(id);
    for (let i = 0; i < up.length - 1; i++) {
      if (!inScope(up[i])) continue;
      let t = totals.get(up[i]);
      if (!t) totals.set(up[i], (t = { total: 0, done: 0, needs: 0, active: 0, waiting: 0, rest: 0 }));
      t.total++;
      t[kind]++;
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------------------------
// Chains and the item status line (CARD-TREE-SPEC §2.2)

function walk(starts: readonly string[], next: (id: string) => readonly string[] | undefined, skip: ReadonlySet<string>) {
  const out: string[] = [];
  const seen = new Set(skip);
  const queue = [...starts];
  for (let i = 0; i < queue.length; i++)
    for (const y of next(queue[i]) ?? []) {
      if (seen.has(y)) continue;
      seen.add(y);
      out.push(y);
      queue.push(y);
    }
  return out;
}

export interface Chain {
  /** Transitive blockers. */
  up: readonly string[];
  /** Transitive blockers of its ancestors (lighter, "inherited"). */
  inherited: readonly string[];
  /** Transitive blocked cards and their sub-cards. */
  down: readonly string[];
}

export function chainOf(tree: Pick<CardTree, "chain" | "blockers" | "blocked" | "children">, id: string): Chain {
  const up = walk([id], (x) => tree.blockers.get(x), new Set([id]));
  const ancestors = tree.chain(id).slice(0, -1);
  const inherited = walk(ancestors, (x) => tree.blockers.get(x), new Set([id, ...ancestors, ...up]));
  const blocked = walk([id], (x) => tree.blocked.get(x), new Set([id]));
  const down = [...blocked, ...walk(blocked, (x) => tree.children.get(x), new Set([id, ...blocked]))];
  return { up, inherited, down };
}

/** The in-scope sub-cards shown under `id` (or the top-level cards for `rootGroup`), in step order; an out-of-scope card's own sub-cards take its place. */
export function scopedChildren(tree: Pick<CardTree, "ordered" | "roots">, id: string, inScope: InScope): string[] {
  const out: string[] = [];
  const add = (group: string) => {
    for (const c of tree.ordered.get(group) ?? []) {
      if (inScope(c)) out.push(c);
      else add(c);
    }
  };
  add(id);
  return out;
}

export interface NextUp {
  /** Moving now: a running session or a job holding a slot. */
  now: readonly string[];
  /** Next in line: unfinished, not moving, no unfinished sub-cards, and every blocker (its own and its ancestors') Done or moving now. */
  next: readonly string[];
  needs: readonly string[];
}

/** The "Now · Next · Needs you" line of an item: `root` and its in-scope sub-tree, in outline order. */
export function nextUp(tree: CardTree, root: string, flags: Flags, inScope: InScope = () => true): NextUp {
  const now: string[] = [], next: string[] = [], needs: string[] = [];
  const f = (id: string) => flags.get(id) ?? 0;
  // A blocker lets its card go next once it is Done, or is moving now (its card starts after it).
  const clear = (id: string) =>
    tree.chain(id).every((x) => (tree.blockers.get(x) ?? []).every((b) => !!(f(b) & cardFlag.done) || (!!(f(b) & cardFlag.active) && !(f(b) & finishedFlags))));
  const visit = (id: string) => {
    const kids = scopedChildren(tree, id, inScope);
    const flag = f(id);
    if (flag & (cardFlag.needs | cardFlag.error)) needs.push(id);
    if (!(flag & finishedFlags)) {
      if (flag & cardFlag.active) now.push(id);
      else if (!(flag & (cardFlag.needs | cardFlag.error)) && kids.every((k) => f(k) & finishedFlags) && clear(id)) next.push(id);
    }
    kids.forEach(visit);
  };
  if (inScope(root)) visit(root);
  return { now, next, needs };
}

// ---------------------------------------------------------------------------------------------
// Outline rows for the Card tree page (CARD-TREE-SPEC §2.2). All fields are primitives so rows
// compare cheaply and FlatList items stay memoized.

export type OutlineSection = "items" | "other" | "finished";

export interface OutlineRow {
  kind: "card" | "group";
  /** Card id, or `group:<section>`. */
  id: string;
  section: OutlineSection;
  /** Outline depth (in-scope ancestors). */
  depth: number;
  step: number;
  /** Highest step of its sibling group. */
  steps: number;
  /** The next row at this depth is a sibling of the same step group (draw the connector). */
  joinNext: boolean;
  /** …and has a higher step (the connector ends in an arrow; equal steps run in parallel). */
  nextStepHigher: boolean;
  cyclic: boolean;
  hasKids: boolean;
  open: boolean;
  /** Bit k: the ancestor at depth k+1 has later siblings (a rail continues through this row). */
  rails: number;
  /** Last among its siblings (the elbow ends here). */
  last: boolean;
  /** Group rows: cards in the section. */
  count: number;
  inChain: boolean;
  /** On the chain only through an ancestor's blockers. */
  inherited: boolean;
  dim: boolean;
}

export interface OutlineOptions {
  inScope: InScope;
  flags: Flags;
  /** Default expansion follows the level; null is All. */
  level: Level;
  /** Per-row (and `group:<section>`) open state set with the chevron; it wins over the level and over the chain. */
  overrides?: ReadonlyMap<string, boolean>;
  /** Chain highlight: the chosen card and its chain; ancestors of every card on it open unless a chevron override says otherwise. */
  chain?: (Chain & { focus: string }) | null;
}

export const groupRowId = (section: OutlineSection) => `group:${section}`;

export function outlineRows(tree: CardTree, opts: OutlineOptions): OutlineRow[] {
  const { inScope, flags, level, overrides } = opts;
  const chain = opts.chain ?? null;
  const onChain = new Set<string>();
  const inherited = new Set(chain?.inherited ?? []);
  if (chain) for (const id of [chain.focus, ...chain.up, ...chain.inherited, ...chain.down]) onChain.add(id);
  const forced = new Set<string>();
  for (const id of onChain) {
    const up = tree.chain(id);
    for (let i = 0; i < up.length - 1; i++) forced.add(up[i]);
  }
  const finished = (id: string) => !!((flags.get(id) ?? 0) & finishedFlags);
  const newest = (a: string, b: string) => compare(tree.createdAt.get(b)!, tree.createdAt.get(a)!) || compare(a, b);
  const sections: Record<OutlineSection, string[]> = { items: [], other: [], finished: [] };
  const kidsOf = new Map<string, string[]>();
  const kids = (id: string) => {
    let list = kidsOf.get(id);
    if (!list) kidsOf.set(id, (list = scopedChildren(tree, id, inScope)));
    return list;
  };
  for (const root of scopedChildren(tree, rootGroup, inScope)) {
    const related = kids(root).length > 0 || !!tree.blockers.get(root)?.length || !!tree.blocked.get(root)?.length;
    sections[finished(root) ? "finished" : related ? "items" : "other"].push(root);
  }
  const rows: OutlineRow[] = [];
  const base = { step: 0, steps: 0, joinNext: false, nextStepHigher: false, cyclic: false, rails: 0, last: false, inherited: false };
  const card = (id: string, section: OutlineSection, depth: number, rails: number, last: boolean, next: string | undefined) => {
    const children = kids(id);
    // An explicit chevron choice wins, so a row the chain opens can still be folded (and stays as the person left it).
    const open = children.length > 0 && (overrides?.get(id) ?? (forced.has(id) || level === null || depth + 1 < level));
    const group = groupOf(tree, id);
    const joinNext = depth > 0 && next !== undefined && groupOf(tree, next) === group;
    rows.push({
      kind: "card",
      id,
      section,
      depth,
      step: tree.step.get(id) ?? 1,
      steps: tree.steps.get(group) ?? 1,
      joinNext,
      nextStepHigher: joinNext && tree.step.get(next!)! > (tree.step.get(id) ?? 1),
      cyclic: tree.cyclic.has(id),
      hasKids: children.length > 0,
      open,
      rails,
      last,
      count: 0,
      inChain: onChain.has(id),
      inherited: inherited.has(id),
      dim: !!chain && !onChain.has(id),
    });
    if (!open) return;
    const childRails = depth >= 1 && !last ? rails | (1 << (depth - 1)) : rails;
    children.forEach((c, i) => card(c, section, depth + 1, childRails, i === children.length - 1, children[i + 1]));
  };
  (["items", "other", "finished"] as const).forEach((section) => {
    const list = sections[section].sort(newest);
    if (!list.length) return;
    const holdsChain = list.some((r) => onChain.has(r) || forced.has(r));
    const open = overrides?.get(groupRowId(section)) ?? (holdsChain || section === "items");
    rows.push({ ...base, kind: "group", id: groupRowId(section), section, depth: 0, hasKids: true, open, count: list.length, inChain: false, dim: !!chain });
    if (open) list.forEach((root, i) => card(root, section, 0, 0, i === list.length - 1, list[i + 1]));
  });
  return rows;
}

const rowKeys = Object.keys({
  kind: 0, id: 0, section: 0, depth: 0, step: 0, steps: 0, joinNext: 0, nextStepHigher: 0, cyclic: 0, hasKids: 0, open: 0, rails: 0, last: 0, count: 0, inChain: 0, inherited: 0, dim: 0,
} satisfies Record<keyof OutlineRow, 0>) as (keyof OutlineRow)[];

const sameRow = (a: OutlineRow, b: OutlineRow) => rowKeys.every((k) => a[k] === b[k]);

/** `next` with every unchanged row kept as the previous object; `prev` itself when nothing changed. */
export function sameRowList(prev: readonly OutlineRow[] | undefined, next: OutlineRow[]): OutlineRow[] {
  if (!prev) return next;
  const old = new Map(prev.map((r) => [r.id, r] as const));
  let changed = prev.length !== next.length;
  const out = next.map((row, i) => {
    const was = old.get(row.id);
    if (was && sameRow(was, row)) {
      if (prev[i] !== was) changed = true;
      return was;
    }
    changed = true;
    return row;
  });
  return changed ? out : (prev as OutlineRow[]);
}
