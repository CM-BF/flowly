import { afterEach, expect, test, vi } from "vitest";
import { perfActive, perfConfigure, perfEnd, perfLap, perfMark, perfRecord, perfStart, perfTake } from "./perf";
import { perfLine, perfReportSchema } from "../shared/perf";

vi.mock("react", () => ({ useEffect: () => undefined }));

afterEach(() => {
  perfConfigure(false, null);
  vi.useRealTimers();
});

test("while the log is off nothing is measured or kept", () => {
  expect(perfActive()).toBe(false);
  expect(perfStart()).toBe(0);
  perfRecord("x", 5);
  perfEnd("x", perfStart());
  perfMark("m");
  perfLap("m", "lap");
  expect(perfTake()).toEqual([]);
});

test("timings are aggregated per name and sent every 10 seconds", () => {
  vi.useFakeTimers();
  const sent: unknown[] = [];
  perfConfigure(true, (report) => sent.push(report), "ios");
  perfRecord("board.apply", 2);
  perfRecord("board.apply", 6);
  perfRecord("board.read.same", 1);
  expect(sent).toEqual([]);
  vi.advanceTimersByTime(10_000);
  expect(sent).toEqual([
    {
      platform: "ios",
      entries: [
        { name: "board.apply", count: 2, totalMs: 8, maxMs: 6 },
        { name: "board.read.same", count: 1, totalMs: 1, maxMs: 1 },
      ],
    },
  ]);
  // Nothing recorded since: nothing sent.
  vi.advanceTimersByTime(10_000);
  expect(sent).toHaveLength(1);
});

test("a mark can be lapped several times and cleared by the last lap", () => {
  vi.useFakeTimers();
  perfConfigure(true, () => undefined);
  perfMark("drawer.open");
  vi.advanceTimersByTime(40);
  perfLap("drawer.open", "mount");
  vi.advanceTimersByTime(260);
  perfLap("drawer.open", "settled", true);
  perfLap("drawer.open", "again");
  const byName = Object.fromEntries(perfTake().map((e) => [e.name, e.totalMs]));
  expect(byName.mount).toBeGreaterThanOrEqual(40);
  expect(byName.settled).toBeGreaterThanOrEqual(300);
  expect(byName.again).toBeUndefined();
});

test("turning the log off drops what was collected", () => {
  perfConfigure(true, () => undefined);
  perfRecord("x", 1);
  perfConfigure(false, null);
  perfConfigure(true, () => undefined);
  expect(perfTake()).toEqual([]);
});

test("a report is one readable log line and rejects malformed input", () => {
  const report = { platform: "android", entries: [{ name: "board.render", count: 4, totalMs: 20, maxMs: 9.5 }] };
  expect(perfReportSchema.parse(report)).toEqual(report);
  expect(perfLine(report)).toBe("[perf] android board.render n=4 avg=5.0ms max=9.5ms");
  expect(perfReportSchema.safeParse({ platform: "x", entries: [] }).success).toBe(false);
  expect(perfReportSchema.safeParse({ platform: "x", entries: [{ name: "a", count: 1, totalMs: -1, maxMs: 0 }] }).success).toBe(false);
});
