import { useEffect, useRef, useState } from "react";
import { useSettings } from "@getpaseo/plugin/client";
import { boardViewSettings, boardViewValues, type BoardView } from "../shared/settings";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Settings = {
  status: string;
  values?: unknown;
  revision?: string;
  save(values: BoardView, revision: string): Promise<boolean>;
  reload(): Promise<void>;
};

/** A patch, or a function building it from the freshly read values (records such as `subCardLevels` that must merge with another device's write). */
export type BoardViewPatch = Partial<BoardView> | ((base: BoardView) => Partial<BoardView>);

/**
 * Saves `patch` on top of the latest stored values; on a revision conflict
 * reloads and merges again (a few attempts), calling a function patch again
 * on the reloaded values. Returns whether it was stored.
 */
export async function saveMerged(read: () => Settings, patch: BoardViewPatch, pause = wait) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = read();
    if (current.status !== "ready" || current.revision === undefined) {
      await pause(150);
      continue;
    }
    const base = boardViewValues(current.values);
    const next = { ...base, ...(typeof patch === "function" ? patch(base) : patch) };
    if (JSON.stringify(next) === JSON.stringify(base)) return true;
    if (await current.save(next, current.revision)) return true;
    // Someone else saved first: pick up their revision and merge again.
    await current.reload();
    await pause(50 * (attempt + 1));
  }
  return false;
}

/**
 * The host-scoped board view preferences with safe writes. Several parts of the
 * plugin save different fields of the same document, so a save against a
 * stale revision is merged into the latest values and retried instead of being
 * dropped. Changes show immediately (optimistic) until the stored values agree.
 */
export function useBoardView() {
  const settings = useSettings(boardViewSettings);
  const latest = useRef(settings);
  latest.current = settings;
  const stored = settings.status === "ready" ? boardViewValues(settings.values) : null;
  const [overlay, setOverlay] = useState<Partial<BoardView>>({});
  // Drop optimistic fields once the stored document shows them.
  useEffect(() => {
    if (!stored) return;
    setOverlay((current) => {
      const left = Object.fromEntries(
        Object.entries(current).filter(([key, value]) => JSON.stringify(stored[key as keyof BoardView]) !== JSON.stringify(value)),
      );
      return Object.keys(left).length === Object.keys(current).length ? current : left;
    });
  }, [settings.status === "ready" ? settings.revision : ""]);
  const values: BoardView | null = stored ? { ...stored, ...overlay } : null;
  async function update(patch: BoardViewPatch) {
    // A function patch shows at once as built on what is on screen; the stored write rebuilds it on the fresh values.
    const shown = typeof patch === "function" ? patch(values ?? boardViewValues(undefined)) : patch;
    setOverlay((current) => ({ ...current, ...shown }));
    if (await saveMerged(() => latest.current, patch)) return true;
    // Give up visibly rather than show a value that was not stored.
    setOverlay((current) => {
      const copy = { ...current };
      for (const key of Object.keys(shown)) delete copy[key as keyof BoardView];
      return copy;
    });
    return false;
  }
  return { ready: !!values, values, update };
}
