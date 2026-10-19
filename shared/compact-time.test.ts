import { expect, test } from "vitest";
import { compactDateTime } from "./compact-time";

const now = new Date(2026, 9, 19, 22, 30);
const local = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();

test("today shows the time only, without seconds", () => {
  const text = compactDateTime(local(2026, 9, 19, 9, 57), "en-US", now);
  expect(text).toMatch(/^9:57\sAM$/);
  expect(compactDateTime(local(2026, 9, 19, 21, 57), "zh-CN", now)).toBe("21:57");
});

test("earlier this year adds month and day, no year", () => {
  const text = compactDateTime(local(2026, 9, 18, 21, 5), "en-US", now);
  expect(text).toContain("Oct 18");
  expect(text).not.toContain("2026");
  expect(text).toMatch(/9:05/);
});

test("other years show the date with the year and no time", () => {
  expect(compactDateTime(local(2025, 11, 31, 23, 0), "en-US", now)).toBe("Dec 31, 2025");
});

test("an invalid time is empty", () => {
  expect(compactDateTime("nope", "en-US", now)).toBe("");
});
