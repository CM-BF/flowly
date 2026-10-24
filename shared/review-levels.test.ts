import { describe, expect, test } from "vitest";
import type { Board, Link, Task, Workpad } from "./model";
import {
  automationSettingsSchema,
  deepKeyword,
  levelChoice,
  levelRounds,
  resolveReviewLevel,
  reviewPlan,
  reviewStartNote,
  roundSeat,
  seatModel,
} from "./automation";

// AUTOMATION-SPEC §5.2: how hard a card is reviewed, resolved deterministically from the board.
const at = "2026-10-24T00:00:00.000Z";
const card = (id: string, extra: Partial<Task> = {}): Task => ({
  id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/p", repoPaths: [], title: `Card ${id}`, description: "", status: "development",
  priority: "normal", position: 0, revision: 1, operationId: `op-${id}`, createdAt: at, updatedAt: at, archivedAt: null, ...extra,
});
const tagged = (...tags: string[]) => ({ tags: tags.map((tag) => ({ tag, by: "human" as const, at })) });
const sub = (from: string, to: string): Link => ({ id: `${from}-sub-${to}`, projectId: "p", kind: "subtask", from, to, createdBy: "human", createdAt: at });
const pad = (taskId: string, criteria: string[]): Workpad => ({
  taskId, projectId: "p", revision: 1, acceptance: criteria.map((text, i) => ({ id: `a${i}`, text, done: false, by: "agent", at })),
  validation: [], confusions: [], env: null, head: null, updatedAt: at, updatedBy: "agent",
});
const board = (tasks: Task[], links: Link[] = [], workpads: Workpad[] = []) => ({ tasks, links, workpads }) as Pick<Board, "tasks" | "links" | "workpads">;
const level = (b: ReturnType<typeof board>, id: string) => resolveReviewLevel(b, b.tasks.find((t) => t.id === id)!);
const luna = { provider: "codex", model: "gpt-6-luna" };
const opus = { provider: "claude", model: "claude-opus-5-5" };
const sol = { provider: "codex", model: "gpt-6.1-sol" };

describe("Auto resolution", () => {
  test("a card's own level wins over every trigger", () => {
    const b = board([card("a", { reviewLevel: "light", title: "Database schema migration", ...tagged("foundation") })]);
    expect(level(b, "a")).toEqual({ level: "light", reason: { kind: "card" } });
  });

  test("deep-review and foundation tags make the card and every card below it Deep, the nearest ancestor first", () => {
    const b = board(
      [card("root", tagged("foundation")), card("mid", { title: "Middle", ...tagged("deep-review") }), card("leaf"), card("own", tagged("ui", "deep-review"))],
      [sub("mid", "root"), sub("leaf", "mid")],
    );
    expect(level(b, "own")).toEqual({ level: "deep", reason: { kind: "tag", tag: "deep-review" } });
    expect(level(b, "leaf")).toEqual({ level: "deep", reason: { kind: "ancestor_tag", tag: "deep-review", cardId: "mid", title: "Middle" } });
    expect(level(b, "mid")).toEqual({ level: "deep", reason: { kind: "tag", tag: "deep-review" } });
  });

  test("a cycle of sub-card links ends the ancestor walk instead of looping", () => {
    const b = board([card("x"), card("y")], [sub("x", "y"), sub("y", "x")]);
    expect(level(b, "x")).toEqual({ level: "standard", reason: { kind: "default" } });
  });

  test("an ancestor's own level and light-review tag do not pass down", () => {
    const b = board([card("root", { reviewLevel: "deep", ...tagged("light-review") }), card("leaf")], [sub("leaf", "root")]);
    expect(level(b, "leaf")).toEqual({ level: "standard", reason: { kind: "default" } });
  });

  test("deep keywords in the title, description or acceptance criteria, in English and Chinese", () => {
    const b = board(
      [
        card("t", { title: "Persist sessions in a journal" }),
        card("d", { description: "Store cards in the existing Postgres DATABASES and add an index." }),
        card("c", { title: "Settings page" }),
        card("z", { description: "把看板数据持久化到本地文件" }),
        card("p", { title: "Add a Write-Ahead-Log to the store" }),
      ],
      [],
      [pad("c", ["Survives a crash-safe restart", "Shows the button"])],
    );
    expect(level(b, "t")).toEqual({ level: "deep", reason: { kind: "keyword", keyword: "journal", field: "title" } });
    expect(level(b, "d")).toEqual({ level: "deep", reason: { kind: "keyword", keyword: "database", field: "description" } });
    expect(level(b, "c")).toEqual({ level: "deep", reason: { kind: "keyword", keyword: "crash-safe", field: "acceptance" } });
    expect(level(b, "z")).toEqual({ level: "deep", reason: { kind: "keyword", keyword: "持久化", field: "description" } });
    expect(level(b, "p")).toEqual({ level: "deep", reason: { kind: "keyword", keyword: "write-ahead log", field: "title" } });
  });

  test.each([
    "Fix the login button",
    "Change the date format on cards",
    "Add a lock icon to private projects",
    "Unlock the composer while a turn runs",
    "Read the theme from localStorage",
    "Show storage usage in Settings",
    "Update the changelog and the blog post",
    "Journalist profile page",
    "Draw the schematic of the board",
    "A catalog of icons",
    "调整日志格式",
    "锁屏按钮的样式",
    "格式化日期",
  ])("no deep keyword in %j", (title) => {
    expect(deepKeyword(title)).toBeNull();
    expect(level(board([card("a", { title })]), "a")).toEqual({ level: "standard", reason: { kind: "default" } });
  });

  test.each([
    ["Rename the schemas", "schema"],
    ["Run the migrations", "migration"],
    ["Fix two vulnerabilities", "vulnerability"],
    ["Check permissions before saving", "permission"],
    ["Use OAuth for GitHub", "OAuth"],
    ["Fix the race condition in send", "race condition"],
    ["鉴权中间件", "鉴权"],
    ["修复并发写入", "并发"],
    ["数据丢失问题", "数据丢失"],
  ])("%j mentions %j", (text, keyword) => {
    expect(deepKeyword(text)).toBe(keyword);
  });

  test("light-review counts only on the card itself, and only after every deep trigger", () => {
    expect(level(board([card("a", tagged("light-review"))]), "a")).toEqual({ level: "light", reason: { kind: "light_tag" } });
    expect(level(board([card("a", { title: "Database index", ...tagged("light-review") })]), "a").level).toBe("deep");
  });

  test("the card editor's draft tags count before they are saved, typed like people type them", () => {
    const b = board([card("a")]);
    expect(resolveReviewLevel(b, { ...b.tasks[0], tags: ["#Deep Review"] })).toEqual({ level: "deep", reason: { kind: "tag", tag: "deep-review" } });
    expect(resolveReviewLevel(b, { ...b.tasks[0], tags: ["light_review"] }).level).toBe("light");
  });
});

describe("levels in the project settings", () => {
  const saved = automationSettingsSchema.parse({ enabled: true, reviewer: luna });

  test("defaults: Light reviews at most min(2, Review rounds) on the reviewer, Deep on the panel model in panels of 3", () => {
    expect([levelRounds(saved, "light"), levelRounds(saved, "standard"), levelRounds(saved, "deep")]).toEqual([2, 3, 3]);
    expect(levelRounds({ ...saved, maxReviewRounds: 1 }, "light")).toBe(1);
    const b = board([card("a", { reviewLevel: "deep" }), card("b", { reviewLevel: "light" }), card("c")]);
    expect(reviewPlan(saved, b, b.tasks[0], 1)).toEqual({ level: "deep", reason: { kind: "card" }, max: 3, size: 3 });
    expect(reviewPlan(saved, b, b.tasks[1], 1)).toEqual({ level: "light", reason: { kind: "card" }, max: 2, size: 1 });
    // Standard is today's: serial, then a panel from the third round of a cycle.
    expect([1, 2, 3].map((round) => reviewPlan(saved, b, b.tasks[2], round).size)).toEqual([1, 1, 3]);
    expect(roundSeat(saved, { level: "deep", size: 3 })).toBeUndefined();
    expect(seatModel({ ...saved, panelReviewer: opus }, roundSeat({ ...saved, panelReviewer: opus }, { level: "deep", size: 3 }))).toEqual(opus);
  });

  test("set values win: each level on its own model, size and cap", () => {
    const set = automationSettingsSchema.parse({ enabled: true, reviewer: luna, panelReviewer: opus, levels: { light: { reviewer: sol, maxReviewRounds: 1 }, deep: { panelReviewer: sol, panelSize: 5, maxReviewRounds: 4 } } });
    const b = board([card("a", { reviewLevel: "deep" }), card("b", { reviewLevel: "light" })]);
    expect(reviewPlan(set, b, b.tasks[0], 2)).toMatchObject({ max: 4, size: 5 });
    expect(roundSeat(set, reviewPlan(set, b, b.tasks[0], 1))).toBe("deep");
    expect(roundSeat(set, reviewPlan(set, b, b.tasks[1], 1))).toBe("light");
    expect(seatModel(set, "deep")).toEqual(sol);
    expect(seatModel(set, "light")).toEqual(sol);
    expect(levelRounds(set, "light")).toBe(1);
    expect(() => automationSettingsSchema.parse({ enabled: true, levels: { deep: { panelSize: 1 } } })).toThrow();
    expect(() => automationSettingsSchema.parse({ enabled: true, levels: { light: { maxReviewRounds: 6 } } })).toThrow();
    expect(() => automationSettingsSchema.parse({ enabled: true, levels: { huge: {} } })).toThrow();
  });

  test("Edit project stores a level choice only when it changes something; back to the default removes it", () => {
    expect(levelChoice(saved, "light", "maxReviewRounds", 2)).toBeNull();
    expect(levelChoice(saved, "deep", "panelSize", 3)).toBeNull();
    expect(levelChoice(saved, "deep", "maxReviewRounds", 3)).toBeNull();
    expect(levelChoice(saved, "light", "reviewer", null)).toBeNull();
    expect(levelChoice(saved, "deep", "panelSize", 4)).toEqual({ levels: { deep: { panelSize: 4 } } });
    const both = { ...saved, levels: { light: { reviewer: sol }, deep: { panelSize: 4 } } };
    expect(levelChoice(both, "deep", "panelSize", 4)).toBeNull();
    expect(levelChoice(both, "deep", "panelSize", 3)).toEqual({ levels: { light: { reviewer: sol } } });
    expect(levelChoice(both, "light", "reviewer", sol)).toBeNull();
    expect(levelChoice(both, "light", "reviewer", opus)).toEqual({ levels: { light: { reviewer: opus }, deep: { panelSize: 4 } } });
    // The last stored value goes: so does `levels`, and an older build reads the board again.
    const patch = levelChoice({ ...saved, levels: { deep: { panelSize: 4 } } }, "deep", "panelSize", 3)!;
    expect(JSON.parse(JSON.stringify({ ...saved, levels: { deep: { panelSize: 4 } }, ...patch }))).not.toHaveProperty("levels");
  });

  test("the review-start note reads as today for a Standard round without a trigger, and names the level and why otherwise", () => {
    expect(reviewStartNote(1, { level: "standard", reason: { kind: "default" }, max: 3, size: 1 })).toBe("Review round 1 of 3");
    expect(reviewStartNote(3, { level: "standard", reason: { kind: "default" }, max: 3, size: 3 })).toBe("Review round 3 of 3 (panel of 3 reviewers)");
    expect(reviewStartNote(1, { level: "deep", reason: { kind: "keyword", keyword: "database", field: "description" }, max: 3, size: 3 })).toBe(
      'Deep review round 1 of 3 (panel of 3 reviewers); level deep: its description mentions "database"',
    );
    expect(reviewStartNote(2, { level: "light", reason: { kind: "light_tag" }, max: 2, size: 1 })).toBe("Light review round 2 of 2; level light: the card has the tag light-review");
    expect(reviewStartNote(1, { level: "standard", reason: { kind: "card" }, max: 3, size: 1 })).toBe("Standard review round 1 of 3; level standard: set on the card");
  });
});
