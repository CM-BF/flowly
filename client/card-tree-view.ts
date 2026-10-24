import { blockerState, cardFlag, groupRowId, rootGroup, scopedChildren, type Chain, type CardTree, type Flags, type InScope, type NextUp, type OutlineRow, type OutlineSection } from "../shared/card-tree";
import type { Task } from "../shared/model";
import { t, tn } from "../shared/i18n";

/**
 * What the Card tree page shows per row, from the pure tree model (CARD-TREE-SPEC §2.2). No React,
 * so the page only wires these.
 */

/** The step circle: filled for done / moving / needs you, outlined for held / waiting / ready. */
export type StepState = "done" | "cancelled" | "active" | "needs" | "held" | "waiting" | "ready";

export function stepState(flag: number): StepState {
  if (flag & cardFlag.done) return "done";
  if (flag & cardFlag.cancelled) return "cancelled";
  if (flag & (cardFlag.needs | cardFlag.error)) return "needs";
  if (flag & cardFlag.active) return "active";
  if (flag & cardFlag.held) return "held";
  if (flag & cardFlag.waiting) return "waiting";
  return "ready";
}

/** Which section an item root sits in, as `outlineRows` sorts it. */
export function sectionOf(tree: Pick<CardTree, "blockers" | "blocked" | "ordered" | "roots">, root: string, flags: Flags, inScope: InScope): OutlineSection {
  if ((flags.get(root) ?? 0) & (cardFlag.done | cardFlag.cancelled)) return "finished";
  const related = scopedChildren(tree, root, inScope).length > 0 || !!tree.blockers.get(root)?.length || !!tree.blocked.get(root)?.length;
  return related ? "items" : "other";
}

/** The row overrides that bring `id` into view: its section and every in-scope ancestor opened. */
export function revealOverrides(tree: CardTree, id: string, flags: Flags, inScope: InScope): [string, boolean][] {
  const up = tree.chain(id).filter(inScope);
  if (!up.length) return [];
  return [[groupRowId(sectionOf(tree, up[0], flags, inScope)), true], ...up.slice(0, -1).map((a) => [a, true] as [string, boolean])];
}

/**
 * The rows a chain highlight opens: the section and in-scope ancestors of every card on it. A new chain
 * drops the chevron folds on these rows, so the whole chain shows; a chevron press after that still wins.
 */
export function chainRows(tree: CardTree, chain: Chain & { focus: string }, flags: Flags, inScope: InScope): Set<string> {
  const out = new Set<string>();
  for (const id of [chain.focus, ...chain.up, ...chain.inherited, ...chain.down]) for (const [key] of revealOverrides(tree, id, flags, inScope)) out.add(key);
  return out;
}

/** `overrides` without the folds (false) on `rows`; the same map when there are none. */
export function withoutFolds(overrides: ReadonlyMap<string, boolean>, rows: ReadonlySet<string>): ReadonlyMap<string, boolean> {
  let next: Map<string, boolean> | null = null;
  for (const [key, open] of overrides)
    if (!open && rows.has(key)) {
      next ??= new Map(overrides);
      next.delete(key);
    }
  return next ?? overrides;
}

/** `overrides` with `id`'s section and ancestors opened (Show in tree, a waits-for chip), or as it is when nothing changes. */
export function withRevealed(overrides: ReadonlyMap<string, boolean>, tree: CardTree, id: string, flags: Flags, inScope: InScope): ReadonlyMap<string, boolean> {
  const open = revealOverrides(tree, id, flags, inScope).filter(([key]) => overrides.get(key) !== true);
  if (!open.length) return overrides;
  const next = new Map(overrides);
  for (const [key] of open) next.set(key, true);
  return next;
}

/**
 * CardTreePage's memo (PERFORMANCE-SPEC §5): while the phone's card overlay covers it (inactive before
 * and after) it does not render at all; otherwise a shallow compare.
 */
export function samePageProps<P extends { active: boolean }>(a: P, b: P): boolean {
  if (!a.active && !b.active) return true;
  const keys = Object.keys(a) as (keyof P)[];
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k], b[k]));
}

/**
 * The step connector between rows: a row joins the one below when the next row is its next sibling
 * (its own sub-cards are not open in between); the arrow marks a later step, no arrow runs in parallel.
 */
export function connectors(rows: readonly OutlineRow[]): { above: boolean; below: boolean; arrow: boolean }[] {
  const below = rows.map((row, i) => row.kind === "card" && row.joinNext && !row.open && rows[i + 1]?.kind === "card" && rows[i + 1].depth === row.depth);
  return rows.map((row, i) => ({ above: i > 0 && below[i - 1], below: below[i], arrow: i > 0 && below[i - 1] && rows[i - 1].nextStepHigher }));
}

export type WaitChip = { id: string; text: string; tone: "muted" | "warning" };

/**
 * The "waits for" chips of a card (CARD-TREE-SPEC §2.2): only blockers that still matter, so a plain
 * chain reads by its numbers alone. An unfinished blocker shows its title ("(in {parent})" when it is
 * not a sibling); a Cancelled or archived one shows only when it holds a queued card (§1.2: otherwise it
 * counts as resolved). Done and missing blockers show nothing.
 */
export function waitChips(tree: Pick<CardTree, "blockers" | "parent">, id: string, tasksById: ReadonlyMap<string, Pick<Task, "title" | "status" | "archivedAt">>, held: boolean): WaitChip[] {
  const chips: WaitChip[] = [];
  const group = tree.parent.get(id) ?? rootGroup;
  for (const b of tree.blockers.get(id) ?? []) {
    const blocker = tasksById.get(b);
    const state = blockerState(blocker);
    if (state === "open") {
      const parent = tree.parent.get(b) ?? rootGroup;
      const parentTitle = parent !== group && parent !== rootGroup ? tasksById.get(parent)?.title : undefined;
      chips.push({ id: b, text: parentTitle ? t("{title} (in {parent})", { title: blocker!.title, parent: parentTitle }) : blocker!.title, tone: "muted" });
    } else if (state === "stuck" && held) {
      chips.push({
        id: b,
        text: blocker!.status === "cancelled" ? t("{title} · Cancelled, holds this", { title: blocker!.title }) : t("{title} · Archived, holds this", { title: blocker!.title }),
        tone: "warning",
      });
    }
  }
  return chips;
}

/** Up to two titles, then "+{n}". */
function names(ids: readonly string[], titleOf: (id: string) => string, suffix: (id: string) => string = () => "") {
  const shown = ids.slice(0, 2).map((id) => `${titleOf(id)}${suffix(id)}`);
  if (ids.length > 2) shown.push(t("+{n}", { n: ids.length - 2 }));
  return shown.join(", ");
}

/** An item's status line: "Now: C3 · Next: C4 (queued) · Needs you: C5b". Empty when nothing applies. */
export function nowNextText(next: NextUp, titleOf: (id: string) => string, queued: (id: string) => boolean): string {
  return [
    next.now.length ? t("Now: {cards}", { cards: names(next.now, titleOf) }) : "",
    next.next.length ? t("Next: {cards}", { cards: names(next.next, titleOf, (id) => (queued(id) ? ` ${t("(queued)")}` : "")) }) : "",
    next.needs.length ? t("Needs you: {cards}", { cards: names(next.needs, titleOf) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A collapsed row's sub-tree line: "3/8 done · 2 running · 1 needs you". */
export function totalsText(totals: { total: number; done: number; active: number; needs: number }): string {
  return [
    t("{done}/{total} done", { done: totals.done, total: totals.total }),
    totals.active ? t("{n} running", { n: totals.active }) : "",
    totals.needs ? tn(totals.needs, "{n} needs you", "{n} need you") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "C3, Development, Agent working, step 3 of 5 under main card, waits for C2" (CARD-TREE-SPEC §4.3). */
export function rowLabel(parts: { title: string; lane: string; signal?: string; step: number; steps: number; parent?: string; waits: readonly WaitChip[]; cyclic: boolean }): string {
  return [
    parts.title,
    parts.lane,
    parts.signal ?? "",
    t("Step {step} of {total}", { step: parts.step, total: parts.steps }),
    parts.parent ? t("under {title}", { title: parts.parent }) : "",
    parts.waits.length ? t("waits for {titles}", { titles: parts.waits.map((w) => w.text).join(", ") }) : "",
    parts.cyclic ? t("order is circular") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

export type Neighbour = { id: string; state: "done" | "open" | "stuck" };

/** What the drawer's Dependencies section shows for a card (CARD-TREE-SPEC §2.6). */
export interface DependencyView {
  /** Root..parent ids (empty for a top-level card). */
  path: string[];
  /** Direct blockers and direct blocked cards, as they stand. */
  left: Neighbour[];
  right: Neighbour[];
  /** Unfinished blockers further up the chain than the direct ones. */
  upstream: number;
  /** Direct sub-cards in step order. */
  strip: { id: string; step: number }[];
  /** Blockers that hold the card (it is queued and they are Cancelled or archived). */
  holding: string[];
}

export function dependencyView(
  tree: CardTree,
  id: string,
  tasksById: ReadonlyMap<string, Pick<Task, "status" | "archivedAt">>,
  held: boolean,
): DependencyView | null {
  if (!tree.ids.includes(id)) return null;
  const path = tree.chain(id).slice(0, -1);
  const neighbour = (other: string): Neighbour | null => {
    const state = blockerState(tasksById.get(other));
    return state === "gone" ? null : { id: other, state };
  };
  const left = (tree.blockers.get(id) ?? []).map(neighbour).filter((n): n is Neighbour => !!n);
  const right = (tree.blocked.get(id) ?? []).map(neighbour).filter((n): n is Neighbour => !!n);
  const kids = tree.ordered.get(id) ?? [];
  if (!path.length && !left.length && !right.length && !kids.length) return null;
  const direct = new Set(left.map((n) => n.id));
  const upstream = chainOfUp(tree, id).filter((b) => !direct.has(b) && blockerState(tasksById.get(b)) === "open").length;
  return {
    path,
    left,
    right,
    upstream,
    strip: kids.map((k) => ({ id: k, step: tree.step.get(k) ?? 1 })),
    holding: held ? left.filter((n) => n.state === "stuck").map((n) => n.id) : [],
  };
}

/** Transitive blockers, nearest first. */
function chainOfUp(tree: Pick<CardTree, "blockers">, id: string): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  const queue = [id];
  for (let i = 0; i < queue.length; i++)
    for (const b of tree.blockers.get(queue[i]) ?? []) {
      if (seen.has(b)) continue;
      seen.add(b);
      out.push(b);
      queue.push(b);
    }
  return out;
}

/**
 * The collapsed section's line: "Waits for 2 · Blocks 1", either part left out at 0. It counts the
 * blockers the card still waits for: unfinished ones, and Cancelled or archived ones only while they
 * hold a queued card (`holding`); otherwise those count as resolved (§1.2), as on the card face and in Links.
 */
export function dependencySummary(view: Pick<DependencyView, "left" | "right" | "holding">): string {
  const waits = view.left.filter((n) => n.state === "open").length + view.holding.length;
  return [waits ? t("Waits for {n}", { n: waits }) : "", view.right.length ? t("Blocks {n}", { n: view.right.length }) : ""].filter(Boolean).join(" · ");
}
