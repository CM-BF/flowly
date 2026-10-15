import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function whose identity never changes but always runs the latest render's
 * `fn`, so memoized children (cards, drawer) are not re-rendered by a new
 * closure on every parent render (PERFORMANCE-SPEC §5). Call it from event
 * handlers, not during render.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}

/** Shallow equality of two plain objects (or identical values). */
export function shallowEqual(a: unknown, b: unknown) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const key of ka)
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  return true;
}

/** The same theme object until one of its colors changes. */
export function useStableTheme<T extends { colors: object }>(theme: T): T {
  const held = useRef(theme);
  if (held.current !== theme && !shallowEqual(held.current.colors, theme.colors)) held.current = theme;
  return held.current;
}
