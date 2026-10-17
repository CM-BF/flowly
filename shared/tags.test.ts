import { describe, expect, test } from "vitest";
import {
  changeTags,
  mergeTagEdit,
  normalizeTag,
  normalizeTags,
  parseTagSearch,
  projectTagStats,
  splitTagInput,
  tagPrefixes,
  taskMatchesSearch,
  taskMatchesTagFilter,
} from "./tags";
import type { Task, TaskTag } from "./model";
import { taskTagSchema } from "./model";

const at = "2026-10-18T00:00:00.000Z";
const human = (tag: string): TaskTag => ({ tag, by: "human", at });
const agent = (tag: string): TaskTag => ({ tag, by: "agent", agentId: "a1", at });

describe("normalizeTag", () => {
  test("lowercases, strips #, folds spaces and underscores, trims separators", () => {
    expect(normalizeTag("  #Session Composer ")).toBe("session-composer");
    expect(normalizeTag("perf__startup")).toBe("perf-startup");
    expect(normalizeTag("--a11y--")).toBe("a11y");
    expect(normalizeTag("Module//Drawer/")).toBe("module/drawer");
    expect(normalizeTag("ＡＢＣ")).toBe("abc");
  });
  test("keeps non-Latin letters", () => {
    expect(normalizeTag("性能")).toBe("性能");
    expect(normalizeTag("抽屉 优化")).toBe("抽屉-优化");
  });
  test("refuses empty, invalid characters and long values", () => {
    expect(() => normalizeTag(" # ")).toThrow("can't be empty");
    expect(() => normalizeTag("a,b")).toThrow("letters, numbers");
    expect(() => normalizeTag("x!")).toThrow("letters, numbers");
    expect(() => normalizeTag("a".repeat(33))).toThrow("at most 32");
    expect(normalizeTag("a".repeat(32))).toHaveLength(32);
  });
  test("normalized values are valid stored values", () => {
    for (const raw of ["Drawer", "性能", "module/drawer", "v1.2"])
      expect(taskTagSchema.safeParse({ tag: normalizeTag(raw), by: "human", at }).success).toBe(true);
    expect(taskTagSchema.safeParse({ tag: "Drawer", by: "human", at }).success).toBe(false);
  });
  test("lists de-duplicate after normalizing", () => {
    expect(normalizeTags(["Drawer", "#drawer", "perf"])).toEqual(["drawer", "perf"]);
    expect(splitTagInput("drawer, perf，性能 #a11y")).toEqual(["drawer", "perf", "性能", "#a11y"]);
  });
});

describe("changeTags", () => {
  test("adds in order, keeps origin on re-add, ignores missing removals", () => {
    const c = changeTags([human("drawer")], { add: ["drawer", "perf"], remove: ["nope"] }, { actor: "agent", agentId: "a1", at });
    expect(c.tags).toEqual([human("drawer"), agent("perf")]);
    expect(c.added).toEqual(["perf"]);
    expect(c.removed).toEqual([]);
  });
  test("agents can't remove human tags; people can remove any", () => {
    expect(() => changeTags([human("drawer")], { remove: ["drawer"] }, { actor: "agent", at })).toThrow("Only the user");
    expect(changeTags([agent("perf")], { remove: ["perf"] }, { actor: "human", at }).tags).toEqual([]);
  });
  test("refuses overlap and more than 12 tags", () => {
    expect(() => changeTags([], { add: ["a"], remove: ["a"] }, { actor: "human", at })).toThrow("both added and removed");
    const many = Array.from({ length: 12 }, (_, i) => human(`t${i}`));
    expect(() => changeTags(many, { add: ["x"] }, { actor: "human", at })).toThrow("at most 12");
  });
  test("a form save keeps tags added meanwhile and does not revive removed ones", () => {
    // Opened with [drawer, old]; an agent then added perf; the person removed old and added a11y.
    const current = [human("drawer"), human("old"), agent("perf")];
    const c = mergeTagEdit(current, ["drawer", "old"], ["drawer", "a11y"], at);
    expect(c.tags.map((t) => t.tag)).toEqual(["drawer", "perf", "a11y"]);
    expect(c.removed).toEqual(["old"]);
    // The person removing an agent tag in the form is allowed.
    expect(mergeTagEdit(current, ["drawer", "old", "perf"], ["drawer", "old"], at).removed).toEqual(["perf"]);
  });
});

const card = (id: string, tags: TaskTag[], extra: Partial<Task> = {}) =>
  ({ id, projectId: "p", title: `Card ${id}`, description: "", archivedAt: null, tags, ...extra }) as Task;

test("project vocabulary: unarchived cards of the project, most used then most recent", () => {
  const tasks = [
    card("1", [human("drawer"), { ...human("perf"), at: "2026-10-18T02:00:00.000Z" }]),
    card("2", [human("drawer"), human("a11y")]),
    card("3", [human("old")], { archivedAt: at }),
    card("4", [human("other")], { projectId: "q" }),
  ];
  expect(projectTagStats(tasks, "p").map((s) => [s.tag, s.count])).toEqual([["drawer", 2], ["perf", 1], ["a11y", 1]]);
});

test("filter and search: OR filter with prefixes, #tag terms AND, text also matches tags", () => {
  const a = card("a", [human("module/drawer"), human("perf")]),
    b = card("b", [human("a11y")], { title: "Contrast" });
  expect(taskMatchesTagFilter(a, [])).toBe(true);
  expect(taskMatchesTagFilter(a, ["a11y", "perf"])).toBe(true);
  expect(taskMatchesTagFilter(b, ["module/"])).toBe(false);
  expect(taskMatchesTagFilter(a, ["module/"])).toBe(true);
  expect(taskMatchesTagFilter(a, ["module"])).toBe(false);
  expect(tagPrefixes(["module/drawer", "module/board", "perf"])).toEqual(["module/"]);
  expect(parseTagSearch("#Perf fix #module/ #!")).toEqual({ text: "fix #!", tags: ["perf", "module/"] });
  expect(taskMatchesSearch(a, "#perf #module/")).toBe(true);
  expect(taskMatchesSearch(a, "#perf #a11y")).toBe(false);
  expect(taskMatchesSearch(b, "a11y")).toBe(true);
  expect(taskMatchesSearch(b, "contrast")).toBe(true);
  expect(taskMatchesSearch(b, "#a11y contrast")).toBe(true);
});
