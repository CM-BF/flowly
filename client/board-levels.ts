import { foldByLevel, levelChoices, scopeOf, type Below, type CardTree, type Level } from "../shared/card-tree";
import type { Status } from "../shared/model";
import { t, tn } from "../shared/i18n";

/**
 * The board's Levels step (CARD-TREE-SPEC §2.3), between the filters and the older-finished fold:
 * which cards the project's "Levels shown" value hides, how many of the filtered cards that is, per
 * lane, and what stays. Pure, so the board only wires it.
 */
export interface LevelsInput<T extends { id: string; status: Status }> {
  tree: Pick<CardTree, "ids" | "chain" | "archived">;
  /** The stored value (null is All). */
  level: Level;
  showArchived: boolean;
  /** The search box is not empty: the fold pauses, so search always finds a hidden sub-card. */
  searching: boolean;
  /** Cards whose whole sub-tree shows for this visit (Show its sub-cards). */
  revealed: ReadonlySet<string>;
  /** Always shown: the open card, the card just dragged. */
  keep: ReadonlySet<string>;
  /** The cards after search, priority, type and tag filters. */
  visible: readonly T[];
  /** Lanes whose footer shows their hidden sub-cards for this visit. */
  lanesShown: readonly Status[];
}

export interface BoardLevels<T> {
  choices: { level: Level; hides: number }[];
  /** The level in effect: null when it is All, when nothing is nested, or when the stored level is deeper than any card. */
  level: Level;
  paused: boolean;
  /** In-scope cards the level hides, filtered or not (empty while paused). */
  hidden: ReadonlySet<string>;
  /** Filtered cards hidden by Levels (the chip's "{n} hidden"); those a lane footer shows are not hidden. */
  hiddenCount: number;
  /**
   * Those same cards by id: the one population behind the chip, the roll-up's "{n} hidden below" and
   * the menu's "Show its sub-cards" (§2.4), so a card never offers to show sub-cards a filter or an
   * open lane footer already decides about.
   */
  folded: ReadonlySet<string>;
  /** Filtered cards hidden by Levels per lane (the lane footer). */
  byLane: ReadonlyMap<Status, number>;
  /** `visible` without the hidden cards, except in lanes whose footer shows them. */
  shown: T[];
}

const none: ReadonlySet<string> = new Set();

export function boardLevels<T extends { id: string; status: Status }>(input: LevelsInput<T>): BoardLevels<T> {
  const inScope = scopeOf(input.tree, input.showArchived);
  const choices = levelChoices(input.tree, inScope);
  const level = input.level !== null && choices.some((c) => c.level === input.level) ? input.level : null;
  const paused = input.searching && level !== null;
  const hidden = level === null || paused ? none : foldByLevel(input.tree, level, input.revealed, input.keep, inScope);
  const byLane = new Map<Status, number>();
  const folded = new Set<string>();
  const shown: T[] = [];
  for (const card of input.visible) {
    if (!hidden.has(card.id)) {
      shown.push(card);
      continue;
    }
    byLane.set(card.status, (byLane.get(card.status) ?? 0) + 1);
    if (input.lanesShown.includes(card.status)) shown.push(card);
    else folded.add(card.id);
  }
  return { choices, level, paused, hidden, hiddenCount: folded.size, folded, byLane, shown };
}

/** The cards with a sub-card the level hides (the menu's "Show its sub-cards"), in one pass; pass `folded`. */
export function hiddenAncestors(tree: Pick<CardTree, "chain">, hidden: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const h of hidden) {
    const up = tree.chain(h);
    for (let i = 0; i < up.length - 1; i++) out.add(up[i]);
  }
  return out;
}

/** The OverviewBar chip: "Levels: All", "Levels: 1 · 11 hidden", or paused while searching. */
export function levelChipText(levels: Pick<BoardLevels<unknown>, "level" | "paused" | "hiddenCount">): string {
  if (levels.level === null) return t("Levels: All");
  const name = t("Levels: {n}", { n: levels.level });
  if (levels.paused) return t("Levels: {n} (paused while searching)", { n: levels.level });
  return levels.hiddenCount ? `${name} · ${tn(levels.hiddenCount, "1 hidden", "{n} hidden")}` : name;
}

/** The Levels menu's line for a choice. */
export function levelChoiceText(level: Level): string {
  switch (level) {
    case null:
      return t("All levels");
    case 1:
      return t("Top-level cards only");
    case 2:
      return t("Down to level 2");
    default:
      return t("Down to level 3");
  }
}

export type BelowSignal = { key: keyof Omit<Below, "hidden"> | "hidden"; text: string; tone: "muted" | "warning" | "danger" | "accent" | "success" };

/**
 * A visible card's roll-up signals, in order (CARD-TREE-SPEC §2.4): "hidden below", "below needs
 * you", errors and held always show; running and unread follow the Session activity switch.
 */
export function belowSignals(below: Below | null | undefined, sessions: boolean): BelowSignal[] {
  if (!below?.hidden) return [];
  const out: BelowSignal[] = [{ key: "hidden", text: tn(below.hidden, "{n} hidden below", "{n} hidden below"), tone: "muted" }];
  if (below.needs) out.push({ key: "needs", text: tn(below.needs, "{n} below needs you", "{n} below need you"), tone: "warning" });
  if (below.errors) out.push({ key: "errors", text: tn(below.errors, "{n} below with errors", "{n} below with errors"), tone: "danger" });
  if (below.held) out.push({ key: "held", text: tn(below.held, "{n} below held", "{n} below held"), tone: "warning" });
  if (sessions && below.running) out.push({ key: "running", text: tn(below.running, "{n} below running", "{n} below running"), tone: "accent" });
  if (sessions && below.unread) out.push({ key: "unread", text: tn(below.unread, "{n} below unread", "{n} below unread"), tone: "success" });
  return out;
}

/** One sentence for the card's accessibility label: "11 sub-cards hidden: 1 needs you, 2 running". */
export function belowLabel(below: Below | null | undefined): string {
  if (!below?.hidden) return "";
  const details = [
    below.needs ? tn(below.needs, "{n} needs you", "{n} need you") : "",
    below.errors ? tn(below.errors, "{n} error", "{n} errors") : "",
    below.held ? tn(below.held, "{n} below held", "{n} below held") : "",
    below.running ? t("{n} running", { n: below.running }) : "",
    below.unread ? t("{n} unread", { n: below.unread }) : "",
  ].filter(Boolean);
  return details.length
    ? tn(below.hidden, "{n} sub-card hidden: {details}", "{n} sub-cards hidden: {details}", { details: details.join(", ") })
    : tn(below.hidden, "{n} hidden below", "{n} hidden below");
}
