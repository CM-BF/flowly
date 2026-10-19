/** Short timestamps for lists (DRAWER-SPEC, Section order §6). Pure; the locale is passed in. */

/**
 * Today: time only ("21:57", "9:57 PM"); this year: month, day and time ("Oct 19, 21:57");
 * earlier: the date with its year ("Oct 19, 2025"). No seconds. Empty for an invalid time.
 */
export function compactDateTime(iso: string, locale: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString(locale, time);
  if (at.getFullYear() === now.getFullYear()) return at.toLocaleString(locale, { month: "short", day: "numeric", ...time });
  return at.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}
