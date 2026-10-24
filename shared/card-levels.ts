import type { Level } from "./card-tree";
import { subCardLimits } from "./links";

/** Projects kept in the stored Levels record (CARD-TREE-SPEC §2.3). */
export const levelRecordLimit = 100;

/** The project's Levels value from the host-level board view; absent, or deeper than any card can be, is All. */
export function levelOf(view: { subCardLevels?: Readonly<Record<string, number>> } | null | undefined, projectId: string): Level {
  const level = view?.subCardLevels?.[projectId];
  return typeof level === "number" && level >= 1 && level <= subCardLimits.depth ? Math.floor(level) : null;
}

/**
 * The stored record with `projectId` set to `level` (All removes it). Projects no longer on the
 * board are dropped and at most `levelRecordLimit` are kept, the changed one last. Build it on the
 * freshly read record so another device's change to another project survives.
 */
export function withSubCardLevel(record: Readonly<Record<string, number>> | undefined, projectId: string, level: Level, liveIds: ReadonlySet<string>): Record<string, number> {
  const kept = Object.entries(record ?? {}).filter(([id]) => id !== projectId && liveIds.has(id));
  if (level !== null) kept.push([projectId, level]);
  return Object.fromEntries(kept.slice(-levelRecordLimit));
}
