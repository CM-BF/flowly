import { useEffect } from "react";
import type { PerfReport } from "../shared/perf";

/**
 * Lightweight timing log (PERFORMANCE-SPEC §3, Timing log). Off by default:
 * every call is one boolean check. When the daemon setting `performance.log`
 * is on, timings are aggregated per name and sent to the daemon every 10 s,
 * which prints them to the plugin log (`paseo plugin logs flowly`).
 */

type Stat = { count: number; total: number; max: number };
const FLUSH_MS = 10_000;

const now = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());

let enabled = false;
let send: ((report: PerfReport) => void) | null = null;
let platform = "";
let timer: ReturnType<typeof setInterval> | null = null;
const stats = new Map<string, Stat>();
const marks = new Map<string, number>();
/** Start-up timings measured before the log's setting could be read; reported once when it turns on. */
const early = new Map<string, number>();

/** The current time in ms (for spans that start before the log is configured). */
export const perfNow = now;

/** Keeps a start-up timing until the log is switched on (one value per name). */
export function perfEarly(name: string, ms: number) {
  if (enabled) perfRecord(name, ms);
  else early.set(name, ms);
}

/** The aggregate since the last flush, cleared. Exported for tests. */
export function perfTake(): PerfReport["entries"] {
  const entries = [...stats]
    .slice(0, 60)
    .map(([name, s]) => ({ name, count: s.count, totalMs: s.total, maxMs: s.max }));
  stats.clear();
  return entries;
}

function flush() {
  const entries = perfTake();
  if (entries.length) send?.({ platform, entries });
}

/** Turns the log on or off; `sink` receives each flush. Safe to call repeatedly. */
export function perfConfigure(on: boolean, sink: ((report: PerfReport) => void) | null, platformName = "") {
  const wasOn = enabled;
  enabled = on && !!sink;
  send = enabled ? sink : null;
  platform = platformName;
  if (enabled && !timer) timer = setInterval(flush, FLUSH_MS);
  if (!enabled) {
    if (timer) clearInterval(timer);
    timer = null;
    stats.clear();
    marks.clear();
  } else if (!wasOn) {
    stats.clear();
    early.forEach((ms, name) => perfRecord(name, ms));
    early.clear();
  }
}

export const perfActive = () => enabled;

/** The start time of a span; 0 while the log is off. */
export function perfStart() {
  return enabled ? now() : 0;
}

export function perfRecord(name: string, ms: number) {
  if (!enabled) return;
  const stat = stats.get(name);
  if (stat) {
    stat.count++;
    stat.total += ms;
    if (ms > stat.max) stat.max = ms;
  } else if (stats.size < 60) {
    stats.set(name, { count: 1, total: ms, max: ms });
  }
}

/** Ends a span started with `perfStart`. */
export function perfEnd(name: string, start: number) {
  if (start) perfRecord(name, now() - start);
}

/** Starts a named span that other code ends with `perfLap`, e.g. a tap and the frames after it. */
export function perfMark(name: string) {
  if (enabled) marks.set(name, now());
}

/** Records the time since `perfMark(mark)` under `name`; the mark stays for further laps. */
export function perfLap(mark: string, name: string, clear = false) {
  const at = marks.get(mark);
  if (at === undefined) return;
  perfRecord(name, now() - at);
  if (clear) marks.delete(mark);
}

/** Time from this render to its commit, i.e. the component's render plus its subtree's. Call first in the component. */
export function usePerfRender(name: string) {
  const start = perfStart();
  useEffect(() => {
    perfEnd(name, start);
  });
}
