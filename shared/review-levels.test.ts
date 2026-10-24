import { deepKeyword, resolveReviewLevel, reviewPlan } from "../server/review-levels";
import { describe, expect, test } from "vitest";
import type { Board, Link, Task, Workpad } from "./model";
import {
  automationSettingsSchema,
  levelChoice,
  levelRounds,
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
    // zh-TW: 儲存 is the Save button, 憑證 also a receipt, 協議 an agreement (protocol is 協定).
    "設定頁新增儲存按鈕",
    "點擊「儲存」按鈕後關閉視窗",
    "上傳付款憑證頁面",
    "使用者協議頁面",
    // Broad English words stay out, like 安全 alone in Chinese.
    "Security settings page layout",
    "Show the transaction history page",
    "Add a transaction around card moves",
    // Persist, persistent, migrate, transactional, file format and on/to disk alone describe UI work too (§5.2.2).
    "Make the toolbar persistent while scrolling",
    "Show a persistent banner when offline",
    "Persistent notifications for failed uploads",
    "Persist the selected tab across reloads",
    "Persist the sidebar width in localStorage",
    "Persist the state of the filters",
    "Clear persisted data on logout",
    "Migrate the settings page to the new design system",
    "Migrate buttons to the new Button component",
    "Design transactional email templates",
    "Show the file format icon in the attachment list",
    "Add a Save to disk button to the export dialog",
    "Show size on disk in the file details panel",
    "Close data panels on Escape",
    // Only a leading verb takes its forms, not the first word of a noun phrase (security issue, wire format).
    "Show the securities issued this year",
    "Wiring format of the cable diagram",
    // The Chinese twins of the same, and words that are UI in Chinese.
    "迁移到新的设计系统",
    "把按钮迁移到新的 Button 组件",
    "显示文件格式图标",
    "不支持的文件格式提示",
    "设计事务性邮件模板",
    "导出对话框里加一个保存到磁盘按钮",
    "在文件详情里显示磁盘占用",
    "上传付款凭证页面",
    "记账凭证列表",
    "原子设计的按钮组件",
    "原子化 CSS 工具类",
    "手写盘压感设置",
    "数据丢包率图表",
    // Third review round: "data" or 数据 starting a compound noun (data table, data fetching, 数据看板) is not a data
    // object, so the migrate and lose phrases do not count there (§5.2.2).
    "Migrate data tables to the new Table component",
    "Migrate data fetching to React Query",
    "Migrate data-fetching hooks to SWR",
    "Migrate data grid to AG Grid v31",
    "Migrate data table columns to the new API of TanStack Table",
    "Migrate the data table to the new design system",
    "Migrate the data grid to AG Grid v30",
    "Migrate data views to the new layout",
    "Migrate existing data cards to the new Card component",
    "Migrate old data charts to Recharts",
    "Migrate data grid styles to the new tokens",
    "Migrate data visualization charts to Recharts",
    "Migrate data fetching to TanStack Query",
    "Migrate data fetching hooks to Suspense",
    "Migrate data-testid attributes to the new naming",
    "Migrate mock data to MSW",
    "Show a banner when the app loses data connection",
    "Warn when the phone is losing data connection",
    "迁移数据看板到新的设计系统",
    "迁移数据可视化组件到 ECharts 5",
    "迁移数据表格组件到新的 Table",
    "迁移数据大屏页面到 Vue 3",
    "迁移数据统计页面到新的路由",
    "迁移数据看板页面到新的设计系统",
    "迁移数据统计页面到新组件库",
    "迁移数据表格组件到新的设计系统",
    "迁移数据请求到 React Query",
    "弱网下保证数据不丢包",
    // Persistent state is the localStorage card's wording, like persist state; transactional updates are emails.
    "Persistent state for the filter panel",
    "Keep the sidebar collapse in persistent state",
    "Send transactional updates to customers by email",
    // 只追加 and 仅追加 are also plain "only add"; 保存到磁盘 and 儲存到磁碟 are Save buttons.
    "工具栏只追加一个导出按钮",
    "这次只追加一列状态，不改别的",
    "表格仅追加一行合计",
    "只追加到产生这次进展的那个 session",
    "新增「儲存到磁碟」按鈕",
    // Words between a verb and its data object or medium stop at a preposition or a clause word.
    "Inputs lose focus when data reloads",
    "Write docs on disk usage",
    "输入框丢失焦点时数据不更新",
    "页面迁移后刷新数据",
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
    ["新增資料庫索引", "資料庫"],
    ["權限檢查", "權限"],
    ["重新設計儲存格式", "儲存格式"],
    ["登入憑證過期處理", "登入憑證"],
    ["通訊協定升級", "協定"],
    ["Fix a security issue in token refresh", "security issue"],
  ])("%j mentions %j", (text, keyword) => {
    expect(deepKeyword(text)).toBe(keyword);
  });

  // English terms written right next to Chinese or Japanese, without spaces, as Chinese users write them.
  test.each([
    ["实现OAuth登录", "OAuth"],
    ["修改schema定义", "schema"],
    ["增加migration脚本", "migration"],
    ["更新protocol版本", "protocol"],
    ["给API contract加字段", "API contract"],
    ["修改board的schema", "schema"],
    ["修复race condition问题", "race condition"],
    ["加入fsync调用", "fsync"],
    ["新增schema校验", "schema"],
    ["把状态写进database里", "database"],
    ["重写journal格式，加入schema版本", "journal"],
    ["データをSQLiteに保存する", "SQLite"],
  ])("%j mentions %j next to CJK text", (text, keyword) => {
    expect(deepKeyword(text)).toBe(keyword);
  });

  test("a mixed-script foundation card resolves to Deep", () => {
    const b = board([card("a", { title: "重写journal格式", description: "加入schema版本号，进程崩溃时不丢数据" })]);
    expect(level(b, "a")).toEqual({ level: "deep", reason: { kind: "keyword", keyword: "journal", field: "title" } });
  });

  // Foundation work as English cards name it: verbs, adjectives and storage names, not only the listed nouns. A verb
  // or adjective that also describes UI work counts only with a storage medium or data object (§5.2.2).
  test.each([
    ["Persist to disk before acknowledging the write", "persist to disk"],
    ["Keep sessions in persistent storage", "persistent storage"],
    ["Add a persistent queue for outgoing webhooks", "persistent queue"],
    ["Store the event history in SQLite", "SQLite"],
    ["Move the boards to Postgres", "Postgres"],
    ["Write to disk on every change", "write to disk"],
    ["Writing to disk after each card move", "write to disk"],
    ["Board changes are written to disk at once", "write to disk"],
    ["Flush to disk before replying", "flush to disk"],
    ["Change the on-disk layout of the cache", "on-disk layout"],
    ["Version the on disk format", "on-disk format"],
    ["Append-only event log for the board", "append-only"],
    ["Turn on write-ahead logging", "write-ahead logging"],
    ["Migrate the data to the v6 layout", "migrate data"],
    ["Migrating old data from v5 boards", "migrate data"],
    ["Migrated data keeps its card ids", "migrate data"],
    ["Encrypt tokens at rest", "encrypt"],
    ["Tokens are encrypted before upload", "encrypt"],
    ["Authenticate webhook requests", "authenticate"],
    ["Only authorized users may export", "authorize"],
    ["Handle concurrent edits to the same card", "concurrent"],
    ["Run the jobs concurrently", "concurrent"],
    ["Write files atomically so a crash mid-write keeps the old file", "atomically"],
    ["Atomicity of card moves", "atomicity"],
    ["Bump the file format version of exported boards", "file format version"],
    ["Use transactional writes for card moves", "transactional write"],
    ["Journaling for the outbox", "journal"],
    // Data loss as people write it: a verb more often than the noun.
    ["Never lose data if the process crashes mid-write", "lose data"],
    ["Losing data on a crash is not acceptable", "lose data"],
    ["Restarts must not lose any data", "lose data"],
    ["Close the window without losing the data", "lose data"],
    ["Recover lost data after a crash", "lose data"],
  ])("%j mentions %j", (text, keyword) => {
    expect(deepKeyword(text)).toBe(keyword);
  });

  // The same foundation cards written in Chinese (Simplified, then Traditional) resolve the same way (§5.2.2).
  test.each([
    ["每次修改都把看板写入磁盘", "写入磁盘"],
    ["卡片移动后立即刷盘", "刷盘"],
    ["定义导出看板的序列化格式", "序列化格式"],
    ["提升导出看板的文件格式版本", "文件格式版本"],
    ["看板的只追加事件日志", "只追加"],
    ["状态只追加、从不删除", "只追加"],
    ["事件仅追加的存放方式", "仅追加"],
    ["加一个预写日志", "预写日志"],
    ["把 v5 看板的数据迁移到 v6", "数据迁移"],
    ["迁移旧数据", "迁移数据"],
    ["编写 v6 的迁移脚本", "迁移脚本"],
    ["卡片移动改为事务性写入", "事务性写入"],
    ["原子地写文件，写到一半崩溃时保留旧文件", "原子地"],
    ["原子写看板文件", "原子写"],
    ["保证卡片移动的原子性", "原子性"],
    ["轮换访问凭证", "访问凭证"],
    ["登录凭证过期处理", "登录凭证"],
    ["导出接口的访问控制", "访问控制"],
    ["修复发送时的竞争条件", "竞争条件"],
    ["这次是破坏性变更", "破坏性变更"],
    ["进程崩溃后不能丢失数据", "丢失数据"],
    ["重启时不丢数据", "丢数据"],
    ["写到一半崩溃，数据不会丢", "数据不会丢"],
    ["每次修改都把看板寫入磁碟", "寫入磁碟"],
    ["提升匯出看板的檔案格式版本", "檔案格式版本"],
    ["撰寫 v6 的遷移腳本", "遷移腳本"],
    ["遷移舊資料", "遷移資料"],
    ["程序崩潰後不能遺失資料", "遺失資料"],
    ["加一個預寫式日誌", "預寫式日誌"],
    ["匯出介面的存取控制", "存取控制"],
  ])("%j mentions %j", (text, keyword) => {
    expect(deepKeyword(text)).toBe(keyword);
  });

  // Third review round: the same card in English and in Chinese resolves Deep in both. English puts the object between
  // the verb and the medium ("write the board file to disk"), Chinese before the verb; data loss is also passive.
  test.each([
    ["Persist board state to disk", "persist to disk", "把看板状态持久化到磁盘", "持久化"],
    ["Persisting board state on disk", "persist to disk", "把看板状态持久化在磁盘上", "持久化"],
    ["Write the board file to disk on every change", "write to disk", "每次修改都把看板文件写入磁盘", "写入磁盘"],
    ["Persist the list of cards to disk", "persist to disk", "把卡片列表写到磁盘", "写到磁盘"],
    ["Flush the buffer to disk before replying", "flush to disk", "回复前把缓冲区刷到磁盘", "刷到磁盘"],
    ["The old code wrote the whole state to disk on every change", "write to disk", "旧代码每次修改都把整个状态存到磁盘", "存到磁盘"],
    ["Migrate user data to v6", "migrate data", "把用户数据迁移到 v6", "数据迁移"],
    ["Migrate user data to v6", "migrate data", "迁移用户数据到 v6", "迁移数据"],
    ["Migrate board data to the new layout", "migrate data", "把看板数据迁移到新布局", "数据迁移"],
    ["Migrate stored data to v6", "migrate data", "迁移已保存的数据到 v6", "迁移数据"],
    ["Migrate all of the existing data to v6", "migrate data", "迁移 v5 的全部数据", "迁移数据"],
    ["Make sure no data is lost when the process crashes", "data is lost", "进程崩溃时数据不会丢", "数据不会丢"],
    ["Data will not be lost if the daemon restarts", "data is lost", "daemon 重启时数据不会丢", "数据不会丢"],
    ["Data must not be lost on restart", "data is lost", "重启后数据不能丢", "数据不会丢"],
    ["No data gets lost if the daemon dies mid-write", "data is lost", "daemon 写到一半退出时数据也不会丢失", "数据不会丢"],
    ["Data lost after a restart", "data is lost", "重启后数据丢失", "数据丢失"],
    ["Restarts must not lose any data", "lose data", "重启时不会丢失任何数据", "丢失数据"],
    ["Never lose user data on a crash", "lose data", "保证任何时候都不丢失用户数据", "丢失数据"],
    ["Restarts lose no data", "lose data", "重啟後資料不會遺失", "資料不會遺失"],
  ])("%j (%s) and %j (%s) are both Deep", (en, enKeyword, zh, zhKeyword) => {
    expect(deepKeyword(en)).toBe(enKeyword);
    expect(level(board([card("a", { title: en })]), "a").level).toBe("deep");
    expect(deepKeyword(zh)).toBe(zhKeyword);
    expect(level(board([card("a", { title: zh })]), "a").level).toBe("deep");
  });

  test("a C1-style card written in Chinese resolves to Deep", () => {
    const b = board([card("a", { title: "把看板文件迁移到 v6 格式，进程崩溃时不能丢失数据" })]);
    expect(level(b, "a")).toEqual({ level: "deep", reason: { kind: "keyword", keyword: "丢失数据", field: "title" } });
  });

  test("light-review counts only on the card itself and takes priority over keyword fallback", () => {
    expect(level(board([card("a", tagged("light-review"))]), "a")).toEqual({ level: "light", reason: { kind: "light_tag" } });
    expect(level(board([card("a", { title: "Database index", ...tagged("light-review") })]), "a").level).toBe("light");
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

  test("settings saved before review levels parse without levels and keep today's Standard reviews", () => {
    const before = automationSettingsSchema.parse({ enabled: true, maxRunning: 2, reviewer: luna, maxReviewRounds: 3, panelAfter: 1, panelSize: 4, fullAccess: true, nudgeLimit: 2, failureLimit: 2 });
    expect(before).not.toHaveProperty("levels");
    const b = board([card("a")]);
    expect([1, 2, 3].map((round) => reviewPlan(before, b, b.tasks[0], round))).toEqual([
      { level: "standard", reason: { kind: "default" }, max: 3, size: 1 },
      { level: "standard", reason: { kind: "default" }, max: 3, size: 4 },
      { level: "standard", reason: { kind: "default" }, max: 3, size: 4 },
    ]);
    expect(seatModel(before, roundSeat(before, { level: "standard", size: 4 }))).toEqual(luna);
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

  test("the review-start note always names the level and why, also for a Standard round without a trigger", () => {
    expect(reviewStartNote(1, { level: "standard", reason: { kind: "default" }, max: 3, size: 1 })).toBe(
      "Standard review round 1 of 3; level standard: keyword fallback: no tag or keyword calls for a deep or light review",
    );
    expect(reviewStartNote(3, { level: "standard", reason: { kind: "default" }, max: 3, size: 3 })).toBe(
      "Standard review round 3 of 3 (panel of 3 reviewers); level standard: keyword fallback: no tag or keyword calls for a deep or light review",
    );
    expect(reviewStartNote(1, { level: "deep", reason: { kind: "keyword", keyword: "database", field: "description" }, max: 3, size: 3 })).toBe(
      'Deep review round 1 of 3 (panel of 3 reviewers); level deep: keyword fallback: its description mentions "database"',
    );
    expect(reviewStartNote(2, { level: "light", reason: { kind: "light_tag" }, max: 2, size: 1 })).toBe("Light review round 2 of 2; level light: the card has the tag light-review");
    expect(reviewStartNote(1, { level: "standard", reason: { kind: "card" }, max: 3, size: 1 })).toBe("Standard review round 1 of 3; level standard: it is set on the card");
  });
});
