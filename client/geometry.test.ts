import { describe, expect, test } from "vitest";
import {
  columnAtPoint,
  drawerWidth,
  dropUpdate,
  edgeScroll,
  isCompactLayout,
} from "./geometry";

const viewport = { x: 100, y: 80, width: 600, height: 500 };
const columns = [
  { status: "todo" as const, x: 12, width: 280 },
  { status: "in_progress" as const, x: 304, width: 280 },
];

describe("board interaction geometry", () => {
  test("targets measured columns with viewport origin and horizontal scroll", () => {
    expect(columnAtPoint({ x: 115, y: 100 }, viewport, 0, columns)).toBe(
      "todo",
    );
    expect(columnAtPoint({ x: 420, y: 100 }, viewport, 0, columns)).toBe(
      "in_progress",
    );
    expect(columnAtPoint({ x: 130, y: 100 }, viewport, 292, columns)).toBe(
      "in_progress",
    );
  });
  test("gaps, toolbar, drawer and outside pointers are not drop targets", () => {
    for (const point of [
      { x: 398, y: 100 },
      { x: 130, y: 79 },
      { x: 700, y: 100 },
      { x: 130, y: 580 },
    ]) {
      expect(columnAtPoint(point, viewport, 0, columns)).toBeNull();
    }
  });
  test("same/outside drops do not write and a cross-column update retains the captured revision", () => {
    const task = { id: "t", revision: 7, status: "todo" as const };
    expect(dropUpdate(task, "todo")).toBeNull();
    expect(dropUpdate(task, null)).toBeNull();
    expect(dropUpdate(task, "in_review")).toEqual({
      id: "t",
      revision: 7,
      status: "in_review",
    });
  });
  test("edge scroll is bounded and inactive outside the viewport", () => {
    expect(edgeScroll({ x: 690, y: 100 }, viewport, 0, 1200)).toBe(18);
    expect(edgeScroll({ x: 110, y: 100 }, viewport, 10, 1200)).toBe(0);
    expect(edgeScroll({ x: 690, y: 100 }, viewport, 595, 1200)).toBe(600);
    expect(edgeScroll({ x: 690, y: 60 }, viewport, 100, 1200)).toBe(100);
    expect(edgeScroll({ x: 400, y: 100 }, viewport, 100, 1200)).toBe(100);
    expect(edgeScroll({ x: 690, y: 100 }, viewport, 0, 200)).toBe(0);
  });
  test("drawer resize keeps a readable drawer and at least 300 points of board", () => {
    expect(drawerWidth(100, 1200)).toBe(340);
    expect(drawerWidth(1000, 1600)).toBe(720);
    expect(drawerWidth(720, 800)).toBe(488);
    expect(drawerWidth(440, 760)).toBe(440);
  });
  test("native and narrow surfaces use a vertical list even when host compact is false", () => {
    expect(isCompactLayout(false, "ios", 1000)).toBe(true);
    expect(isCompactLayout(false, "android", 1000)).toBe(true);
    expect(isCompactLayout(false, "web", 759)).toBe(true);
    expect(isCompactLayout(false, "web", 760)).toBe(false);
    expect(isCompactLayout(true, "web", 1600)).toBe(true);
  });
});
