import { createHash } from "node:crypto";

/** `{ etag, value }`, or only `{ etag }` when the caller already holds this value (PERFORMANCE-SPEC §3). */
export function ifChanged<T>(value: T, etag?: string): { etag: string; value?: T } {
  const tag = etagOf(value);
  return tag === etag ? { etag: tag } : { etag: tag, value };
}

export const etagOf = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("base64url");

/**
 * The board read for a phone (PERFORMANCE-SPEC §3): events are append-only and
 * are most of the board's bytes, so a caller that already holds the first
 * `since.count` events (ending in `since.lastId`) gets only the newer ones.
 * Anything else about that prefix (a deleted card's events, a different order)
 * makes the counts disagree and falls back to the full board.
 */
export function boardIfChanged<B extends { events: readonly { id: string }[] }>(
  view: B,
  input: { etag?: string; since?: { count: number; lastId: string } },
): { etag: string; value?: Omit<B, "events"> & { events: B["events"] }; delta?: boolean } {
  const tag = etagOf(view);
  if (tag === input.etag) return { etag: tag };
  const since = input.since;
  if (since) {
    for (let i = view.events.length - 1; i >= 0; i--) {
      if (view.events[i].id !== since.lastId) continue;
      if (i + 1 === since.count) return { etag: tag, value: { ...view, events: view.events.slice(i + 1) }, delta: true };
      break;
    }
  }
  return { etag: tag, value: view };
}
