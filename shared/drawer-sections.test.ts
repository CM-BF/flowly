import { describe, expect, test } from "vitest";
import { defaultDrawerLayout, defaultSectionOpen, drawerSectionOrder, drawerSections, drawerSectionsOpen, isDefaultDrawerOpen, isDefaultDrawerOrder, withDrawerSectionMoved, withSectionOpen } from "./drawer-sections";

describe("drawer section order", () => {
  test("defaults when nothing is stored", () => {
    expect(drawerSectionOrder(undefined)).toEqual([...drawerSections]);
    expect(drawerSectionOrder([])).toEqual([...drawerSections]);
    expect(isDefaultDrawerOrder([])).toBe(true);
  });

  test("keeps the stored order and drops unknown and duplicate ids", () => {
    expect(drawerSectionOrder(["sessions", "later", "progress", "comments", "sessions", "workpad", "artifacts", "ideas", "links"])).toEqual([
      "sessions", "progress", "comments", "workpad", "artifacts", "ideas", "dependencies", "links",
    ]);
  });

  test("puts a missing section after the one before it by default", () => {
    // An older value without "links" and "workpad": workpad follows sessions, links follows ideas.
    expect(drawerSectionOrder(["artifacts", "progress", "sessions", "ideas"])).toEqual([
      "artifacts", "progress", "comments", "sessions", "workpad", "ideas", "dependencies", "links",
    ]);
    // Nothing before it is stored: it goes first.
    expect(drawerSectionOrder(["links"])[0]).toBe("progress");
  });

  test("Comments arrive under Progress, also for a layout stored before they existed (CARD-COMMENTS-SPEC §1)", () => {
    expect(drawerSectionOrder(["sessions", "progress", "workpad", "artifacts", "ideas", "links"])).toEqual([
      "sessions", "progress", "comments", "workpad", "artifacts", "ideas", "dependencies", "links",
    ]);
    expect(drawerSectionsOpen({}).comments).toBe(true);
  });

  test("Dependencies arrive after Ideas, open, also in a layout stored before them (CARD-TREE-SPEC §2.6)", () => {
    expect(drawerSectionOrder(["links", "ideas", "progress"])).toEqual(["links", "ideas", "dependencies", "progress", "comments", "sessions", "workpad", "artifacts"]);
    expect(drawerSectionsOpen({}).dependencies).toBe(true);
    expect(drawerSectionsOpen({ dependencies: false }).dependencies).toBe(false);
  });

  test("moving a section stores the full order and keeps unknown ids", () => {
    const next = withDrawerSectionMoved(["future"], "sessions", 0);
    expect(next).toEqual(["sessions", "progress", "comments", "workpad", "artifacts", "ideas", "dependencies", "links", "future"]);
    expect(isDefaultDrawerOrder(next)).toBe(false);
    expect(drawerSectionOrder(withDrawerSectionMoved(next, "sessions", 2))).toEqual([...drawerSections]);
    expect(withDrawerSectionMoved([], "links", 99).at(-1)).toBe("links");
  });

  test("default order and open state; stored choices win", () => {
    expect([...drawerSections]).toEqual(["progress", "comments", "sessions", "workpad", "artifacts", "ideas", "dependencies", "links"]);
    expect(drawerSectionsOpen(undefined)).toEqual(defaultSectionOpen);
    expect(defaultSectionOpen).toEqual({ progress: true, comments: true, sessions: true, workpad: true, artifacts: true, ideas: true, dependencies: true, links: false, details: false, usage: false, activity: false });
    expect(drawerSectionsOpen({ workpad: false, activity: true, later: true, links: "yes" as unknown as boolean })).toMatchObject({ workpad: false, activity: true, links: false, details: false });
    expect(isDefaultDrawerOpen({})).toBe(true);
  });

  test("setting a section to its default drops the stored choice", () => {
    const closed = withSectionOpen({ future: true }, "workpad", false);
    expect(closed).toEqual({ future: true, workpad: false });
    expect(isDefaultDrawerOpen(closed)).toBe(false);
    expect(withSectionOpen(closed, "workpad", true)).toEqual({ future: true });
    expect(withSectionOpen({}, "usage", true)).toEqual({ usage: true });
  });

  test("the default layout keeps only unknown ids", () => {
    expect(defaultDrawerLayout(["sessions", "future"], { workpad: false, newer: true })).toEqual({ drawerOrder: ["future"], drawerOpen: { newer: true } });
  });
});
