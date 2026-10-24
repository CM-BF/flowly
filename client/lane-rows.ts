/** What the phone's lane list shows, top to bottom (PERFORMANCE-SPEC §3, virtualized lane list). */
export type LaneRow<T> =
  | { key: string; kind: "task"; task: T }
  /** No recent cards: the lane is empty, only older finished cards remain, or Levels hides the rest (`hidden`). */
  | { key: "empty"; kind: "empty"; hasOlder: boolean; hidden: number }
  /** "Show {n} hidden sub-cards" / "Hide sub-cards" (CARD-TREE-SPEC §2.3): after the current cards, before older. */
  | { key: "levels"; kind: "levels"; count: number; shown: boolean }
  | { key: "older"; kind: "older" };

/** The lane's cards hidden by Levels, and whether its footer has shown them for this visit. */
export type LaneLevels = { count: number; shown: boolean };
const noLevels: LaneLevels = { count: 0, shown: false };

export function laneRows<T extends { id: string }>(recent: readonly T[], older: readonly T[], showOlder: boolean, levels: LaneLevels = noLevels): LaneRow<T>[] {
  const rows: LaneRow<T>[] = recent.map((task) => ({ key: task.id, kind: "task", task }));
  if (!recent.length) rows.push({ key: "empty", kind: "empty", hasOlder: older.length > 0, hidden: levels.shown ? 0 : levels.count });
  if (levels.count) rows.push({ key: "levels", kind: "levels", count: levels.count, shown: levels.shown });
  if (older.length) rows.push({ key: "older", kind: "older" });
  if (older.length && showOlder) for (const task of older) rows.push({ key: task.id, kind: "task", task });
  return rows;
}

/** The previous rows when nothing in them changed, so the list is not handed new data on every board render. */
export function sameRows<T>(prev: readonly LaneRow<T>[] | undefined, next: LaneRow<T>[]): LaneRow<T>[] {
  if (!prev || prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i],
      b = next[i];
    if (a.key !== b.key || a.kind !== b.kind) return next;
    if (a.kind === "task" && b.kind === "task" && a.task !== b.task) return next;
    if (a.kind === "empty" && b.kind === "empty" && (a.hasOlder !== b.hasOlder || a.hidden !== b.hidden)) return next;
    if (a.kind === "levels" && b.kind === "levels" && (a.count !== b.count || a.shown !== b.shown)) return next;
  }
  return prev as LaneRow<T>[];
}
