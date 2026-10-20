import { z } from "zod";

/** Phone timing report (PERFORMANCE-SPEC §3, Timing log). */
export const perfEntrySchema = z.strictObject({
  name: z.string().min(1).max(60),
  count: z.number().int().positive().max(1_000_000),
  totalMs: z.number().nonnegative().max(1e9),
  maxMs: z.number().nonnegative().max(1e9),
});
export const perfReportSchema = z.strictObject({
  platform: z.string().max(40),
  entries: z.array(perfEntrySchema).min(1).max(60),
});
export type PerfReport = z.infer<typeof perfReportSchema>;

/** One log line per report; stays readable in `paseo plugin logs`. */
export function perfLine(report: PerfReport) {
  const parts = report.entries.map((e) => `${e.name} n=${e.count} avg=${(e.totalMs / e.count).toFixed(1)}ms max=${e.maxMs.toFixed(1)}ms`);
  return `[perf] ${report.platform} ${parts.join(" | ")}`;
}
