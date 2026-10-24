import type { AgentModel } from "./agent-defaults";
import { parentOf } from "./links";
import type { Board, Task } from "./model";
import type { AutomationJob, AutomationSettings, LevelReason, LevelSettings, ReviewLevel, ReviewPlan } from "./automation-schema";

/**
 * Review levels (AUTOMATION-SPEC §5.2): how hard agent automation reviews a card. Runtime-neutral and small, so the
 * card editor shows the same Auto resolution the daemon records when a review round starts.
 */

/** Panel review (§5.1) when a project never chose: from the third round of a cycle, three reviewers. */
export const panelDefaults = { after: 2, size: 3 } as const;
/** How many reviewers check review round `round` of a Standard cycle: 1 for a serial round, the panel size for a panel round. */
export function reviewersFor(settings: AutomationSettings, round: number) {
  const after = settings.panelAfter === undefined ? panelDefaults.after : settings.panelAfter;
  return after !== null && round > after ? (settings.panelSize ?? panelDefaults.size) : 1;
}

/** Tags that make a card Deep (on the card or any ancestor) or Light (on the card itself). */
export const levelTags = { deep: ["deep-review", "foundation"], light: "light-review" } as const;

/**
 * Specific technical terms that make a card Deep when its title, description or acceptance criteria mention them
 * (§5.2.2). English matches whole words, also right next to Chinese or Japanese text; a keyword's last word takes its
 * usual forms (-s/-es, -ed, -ing, -ly; -e and -y words theirs), so does the verb a phrase starts with (`leadingVerbs`),
 * and a space in a phrase also matches a hyphen. Chinese matches as a substring. Broad words (log, format, lock, storage,
 * state, transaction, security, and alone persist, persistent, migrate, transactional, file format, on/to disk; 日志,
 * 格式, 锁, 安全, 迁移, 文件格式, 事务性, zh-CN 凭证 and 原子, zh-TW 儲存 and 憑證) stay out on purpose: they describe UI
 * work too, so a verb or adjective counts only with a storage medium or data object, and data that starts a compound
 * noun ("data table", 数据看板) is not one (`objectNext`). The same card should resolve the same in both languages, so a
 * verb may stand a few words from its object (`gap`, `zhGap`) and data loss also counts when passive (`custom`). List
 * order decides which keyword a card's reason names.
 */
export const deepKeywords = {
  en: [
    "storage format", "storage layer", "storage engine", "on-disk format", "on-disk layout", "on-disk state", "on-disk data",
    "write to disk", "flush to disk", "persist to disk", "wire format", "serialization format", "file format version",
    "persistence", "persistent storage", "persistent queue", "journal", "write-ahead log", "write-ahead logging", "append-only",
    "database", "SQLite", "Postgres", "PostgreSQL", "MySQL", "IndexedDB", "schema", "migration", "migrate data",
    "protocol", "API contract", "public API", "external interface", "backward compatibility", "backwards compatibility", "breaking change",
    "authentication", "authenticate", "authorization", "authorisation", "authorize", "authorise", "access control", "permission", "OAuth", "OAuth2",
    "encryption", "decryption", "encrypt", "decrypt", "credential",
    "security boundary", "security model", "security fix", "security issue", "security hole", "security flaw", "security bug",
    "security review", "security audit", "security hardening", "security-sensitive", "security-critical", "vulnerability",
    "concurrency", "concurrent", "race condition", "deadlock", "transactional write", "atomic write", "atomically", "atomicity",
    "crash recovery", "crash safety", "crash-safe", "data loss", "lose data", "data is lost", "data corruption",
    "durability", "fsync",
  ],
  zh: [
    "存储", "持久化", "落盘", "刷盘", "写入磁盘", "写到磁盘", "写进磁盘", "刷到磁盘", "存到磁盘", "序列化格式", "文件格式版本", "只追加", "仅追加",
    "追加写入", "预写日志", "预写式日志", "数据库", "数据迁移", "迁移数据", "迁移脚本", "表结构", "协议", "鉴权", "认证", "授权", "权限", "访问控制",
    "加密", "解密", "凭据", "登录凭证", "访问凭证", "安全漏洞", "安全边界", "破坏性变更", "并发", "竞态", "竞争条件", "死锁", "事务性写入", "事务写入",
    "原子写", "原子地", "原子性", "崩溃恢复", "数据丢失", "丢失数据", "丢数据", "数据不会丢", "数据损坏", "向后兼容",
    // Traditional Chinese (zh-TW) spellings and terms of the same, where they differ. Not 儲存 alone (the Save button),
    // 憑證 alone (also a receipt) or 協議 (an agreement; protocol is 協定).
    "儲存格式", "儲存層", "儲存引擎", "資料儲存", "持久儲存", "落盤", "寫入磁碟", "寫到磁碟", "刷到磁碟", "存到磁碟", "檔案格式版本", "僅追加",
    "追加寫入", "預寫日誌", "預寫式日誌", "資料庫", "數據庫", "資料遷移", "數據遷移", "遷移資料", "遷移腳本", "表結構", "協定", "鑑權", "認證", "授權",
    "權限", "存取控制", "登入憑證", "存取憑證", "憑據", "安全邊界", "破壞性變更", "並發", "競態", "競爭條件", "死鎖", "原子寫", "崩潰恢復", "崩潰復原",
    "資料遺失", "遺失資料", "丟失資料", "丟資料", "資料丟失", "數據丟失", "資料不會遺失", "資料損毀", "向後相容",
  ],
} as const;

/**
 * Not a Latin letter, a digit or an underscore: every English keyword is ASCII, so Chinese, Japanese or Korean text
 * right next to one is a word boundary ("修改schema定义").
 */
const edge = "[^A-Za-z0-9_\\u00C0-\\u024F]";
const letter = "A-Za-z0-9_'’\\u00C0-\\u024F";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const anyOf = (words: readonly string[]) => `(?:${words.join("|")})`;
/** Irregular forms of the leading verbs ("wrote the state to disk", "lost data"). */
const irregular: Readonly<Record<string, readonly string[]>> = { write: ["wrote", "written"], lose: ["lost"] };
/** A word with its usual forms ("databases", "migrated", "vulnerabilities", "concurrently"). */
function forms(word: string) {
  const regular = word.endsWith("e")
    ? `${escape(word.slice(0, -1))}(?:e|es|ed|ing)`
    : word.endsWith("y")
      ? `${escape(word.slice(0, -1))}(?:y|ies|ied|ying)`
      : `${escape(word)}(?:s|es|ed|ing|ly)?`;
  const extra = irregular[word];
  return extra ? `(?:${regular}|${extra.join("|")})` : regular;
}
/**
 * Verbs that start a keyword phrase and take their forms too ("losing data", "writes to disk", "migrated data"). Only
 * these: the first word of a noun phrase stays as listed, or "racing conditions" would be a race condition.
 */
const leadingVerbs: ReadonlySet<string> = new Set(["write", "flush", "persist", "migrate", "lose"]);
/**
 * Words that cannot stand between a leading verb and the rest of its phrase: prepositions and clause words start
 * another phrase ("lose focus when data reloads"), and test or mock data is not real data ("Migrate mock data to MSW").
 */
const gapStops = [
  "to", "into", "onto", "on", "in", "at", "from", "for", "with", "without", "within", "by", "about", "via", "per", "over", "under",
  "after", "before", "during", "since", "until", "till", "when", "whenever", "while", "where", "if", "unless", "because", "so",
  "that", "which", "who", "whose", "then", "than", "as", "but",
  "test", "mock", "sample", "demo", "dummy", "fake", "example", "placeholder",
];
/** Up to four words between a leading verb and its object or medium ("Write the board file to disk", "lose no data"). */
const gap = `(?:[\\s-]+(?!${anyOf(gapStops)}(?![${letter}]))[${letter}]+){0,4}`;
/**
 * After a phrase's last word, what makes it a modifier rather than the data object or medium: a hyphen or a noun it
 * starts ("data table", "data-fetching", "data connection", "disk usage").
 */
const dataNouns = [
  "table", "grid", "view", "panel", "pane", "chart", "graph", "card", "connection", "picker", "dashboard", "list", "tab", "fetch", "fetcher",
  "load", "loader", "visualization", "visualisation", "viz", "hook", "component", "page", "screen", "widget", "form", "entry", "label",
  "filter", "explorer", "viewer", "binding", "display", "plan", "usage", "saver", "roaming", "cap", "attribute", "tooltip", "legend",
  "modal", "dialog", "button", "icon", "badge", "chip", "tile", "selector", "dropdown", "menu", "preview", "fixture", "mock",
];
const diskNouns = ["usage", "space", "quota", "size", "cleanup", "icon", "button", "label", "indicator", "meter", "badge", "chart"];
const nounAfter = (nouns: readonly string[]) => `[\\s-]+${anyOf(nouns.map(forms))}(?=$|${edge})`;
const objectNext: Readonly<Record<string, string>> = { data: `(?!-|${nounAfter(dataNouns)})`, disk: `(?!${nounAfter(diskNouns)})` };
/** Data loss written in the passive: data, up to four auxiliaries or negations, lost ("no data is lost", "Data will not be lost"). */
const auxiliaries = [
  "is", "are", "was", "were", "be", "been", "being", "get", "gets", "got", "gotten", "getting", "will", "would", "must", "should", "shall",
  "can", "could", "may", "might", "cannot", "not", "never", "ever", "also", "still",
  ...["won", "can", "isn", "aren", "wasn", "weren", "mustn", "shouldn", "wouldn", "couldn", "doesn", "don", "didn"].map((w) => `${w}['’]t`),
];
const custom: Readonly<Record<string, string>> = { "data is lost": `data(?:[\\s-]+${anyOf(auxiliaries)}){0,4}[\\s-]+lost` };
/** The keyword's last word, and a leading verb, with their forms; a space or a hyphen in it matches either. */
function keywordPattern(keyword: string) {
  if (custom[keyword]) return custom[keyword];
  const words = keyword.split(/\s+/);
  const verb = words.length > 1 && leadingVerbs.has(words[0]);
  const parts = words.join("-").split("-");
  const last = parts.length - 1;
  const word = (part: string, i: number) =>
    i === last || (i === 0 && verb) ? forms(part) : verb && part === "to" ? "(?:to|onto|on)" : escape(part);
  const body = parts.map((part, i) => (i === 0 ? word(part, i) : `${verb && i === 1 ? gap : ""}[\\s-]+${word(part, i)}`)).join("");
  return body + (objectNext[parts[last]] ?? "");
}

/**
 * Chinese, as a substring. A verb before 数据 (迁移数据, 丢失数据) may stand up to eight characters from it, none of
 * them punctuation or a character that starts another phrase (迁移用户数据, 不会丢失任何数据; not 丢失焦点时数据);
 * 数据 or 磁盘 at the end does not count before a noun it modifies (迁移数据看板, 数据丢包).
 */
const zhVerbs = ["迁移", "丢失", "遷移", "遺失", "丟失"];
const zhObjects = ["数据", "資料", "數據"];
const zhGap = "[^，。、；：！？,.;:!?()（）「」『』“”\"'\\[\\]【】《》<>\\n\\r\\t到至后後时時前并並再就把将將在从從给給让讓被向往成为為]{0,8}";
const zhDataNouns = [
  "看板", "表格", "大屏", "可视化", "視覺化", "统计", "統計", "报表", "報表", "面板", "页", "頁", "请求", "請求", "列表", "图表", "圖表", "卡片",
  "组件", "元件", "视图", "檢視", "筛选", "篩選", "展示", "包", "连接", "連線", "绑定", "綁定", "加载", "載入", "获取", "擷取", "埋点", "分析",
  "标签", "標籤", "弹窗", "彈窗", "按钮", "按鈕", "图标", "圖示",
];
const zhDiskNouns = ["空间", "空間", "占用", "佔用", "使用", "用量", "图标", "圖示", "按钮", "按鈕"];
const zhNext = (keyword: string) =>
  zhObjects.some((o) => keyword.endsWith(o)) ? `(?!${anyOf(zhDataNouns)})` : /磁[盘碟]$/.test(keyword) ? `(?!${anyOf(zhDiskNouns)})` : "";
/** 只追加 counts when it means append-only, not "only add one button"; 保存到磁盘 and 儲存到磁碟 are Save buttons. */
const appendOnly = `(?=的|写|寫|式|日志|日誌|事件|记录|記錄|文件|檔案|模式|存储|儲存|队列|佇列|数据|資料|流|[、，,]?(?:从|從)?不(?:删|刪))`;
const zhCustom: Readonly<Record<string, string>> = {
  只追加: `只追加${appendOnly}`,
  仅追加: `仅追加${appendOnly}`,
  僅追加: `僅追加${appendOnly}`,
  存到磁盘: `(?:^|[^保储儲])存到磁盘${zhNext("磁盘")}`,
  存到磁碟: `(?:^|[^保储儲])存到磁碟${zhNext("磁碟")}`,
  数据不会丢: "数据(?:都|也|就|绝|绝对|永远|可能)?(?:可能会|不应该|不会|不能|不可|不得|不应|不该|会|不)丢(?!包)",
  資料不會遺失: "(?:資料|數據)(?:都|也|就|絕|絕對|永遠|可能)?(?:可能會|不應該|不會|不能|不可|不得|不應|不該|會|不)(?:丟|遺失)(?!包)",
};
function chinesePattern(keyword: string) {
  if (zhCustom[keyword]) return zhCustom[keyword];
  const verb = zhVerbs.find((v) => keyword.startsWith(v) && zhObjects.includes(keyword.slice(v.length)));
  return (verb ? `${verb}${zhGap}${keyword.slice(verb.length)}` : escape(keyword)) + zhNext(keyword);
}

/** Compiled on first use: the client evaluates this module at every app start (AGENTS.md, cold start). */
let compiled: { keyword: string; pattern: RegExp }[] | undefined;
const patterns = () =>
  (compiled ??= [
    ...deepKeywords.en.map((keyword) => ({ keyword, pattern: new RegExp(`(?:^|${edge})${keywordPattern(keyword)}(?=$|${edge})`, "iu") })),
    ...deepKeywords.zh.map((keyword) => ({ keyword, pattern: new RegExp(chinesePattern(keyword), "u") })),
  ]);

/** The first deep keyword `text` mentions (in list order, English first), or null. */
export function deepKeyword(text: string): string | null {
  if (!text) return null;
  for (const { keyword, pattern } of patterns()) if (pattern.test(text)) return keyword;
  return null;
}

export type LevelBoard = Pick<Board, "tasks" | "links"> & { workpads?: Board["workpads"] };
/** The card as resolution reads it; the card editor passes its draft title, description and tags. */
export type LevelCard = Pick<Task, "id" | "title" | "description" | "reviewLevel"> & { tags?: readonly ({ tag: string } | string)[] };

const tagValue = (tag: { tag: string } | string) => (typeof tag === "string" ? tag : tag.tag).trim().toLocaleLowerCase("en").replace(/^#+/, "").replace(/[\s_]+/g, "-");
const deepTagOf = (tags: readonly string[]) => tags.find((tag) => (levelTags.deep as readonly string[]).includes(tag));
/** How far up the sub-card links resolution looks for a deep tag. */
const ancestorLimit = 20;

/**
 * The card's review level and why (§5.2.2): its own level; else Deep for a deep-review or foundation tag on it or an
 * ancestor, or a deep keyword in its title, description or workpad acceptance criteria; else Light for its own
 * light-review tag; else Standard. Deterministic: it reads only the board.
 */
export function resolveReviewLevel(board: LevelBoard, card: LevelCard): { level: ReviewLevel; reason: LevelReason } {
  if (card.reviewLevel) return { level: card.reviewLevel, reason: { kind: "card" } };
  const own = (card.tags ?? []).map(tagValue);
  const tag = deepTagOf(own);
  if (tag) return { level: "deep", reason: { kind: "tag", tag } };
  const seen = new Set([card.id]);
  for (let id = parentOf(board.links, card.id); id && !seen.has(id) && seen.size <= ancestorLimit; id = parentOf(board.links, id)) {
    seen.add(id);
    const parent = board.tasks.find((t) => t.id === id);
    if (!parent) break;
    const inherited = deepTagOf((parent.tags ?? []).map(tagValue));
    if (inherited) return { level: "deep", reason: { kind: "ancestor_tag", tag: inherited, cardId: parent.id, title: parent.title.slice(0, 200) } };
  }
  const acceptance = board.workpads?.find((w) => w.taskId === card.id)?.acceptance.map((item) => item.text).join("\n") ?? "";
  const fields = [["title", card.title], ["description", card.description], ["acceptance", acceptance]] as const;
  for (const [field, text] of fields) {
    const keyword = deepKeyword(text);
    if (keyword) return { level: "deep", reason: { kind: "keyword", keyword, field } };
  }
  if (own.includes(levelTags.light)) return { level: "light", reason: { kind: "light_tag" } };
  return { level: "standard", reason: { kind: "default" } };
}

/** Deep panels when the project never chose a size. */
export const deepDefaults = { size: 3 } as const;
/** A cycle's round cap at `level`: Light defaults to min(2, Review rounds), Deep to Review rounds. */
export function levelRounds(settings: AutomationSettings, level: ReviewLevel) {
  if (level === "light") return settings.levels?.light?.maxReviewRounds ?? Math.min(2, settings.maxReviewRounds);
  if (level === "deep") return settings.levels?.deep?.maxReviewRounds ?? settings.maxReviewRounds;
  return settings.maxReviewRounds;
}
export const deepPanelSize = (settings: AutomationSettings) => settings.levels?.deep?.panelSize ?? deepDefaults.size;

/** Review round `round` of the card: its level and why, the cycle's cap and how many reviewers check it (§5.2.3). */
export function reviewPlan(settings: AutomationSettings, board: LevelBoard, card: LevelCard, round: number): ReviewPlan {
  const { level, reason } = resolveReviewLevel(board, card);
  const size = level === "light" ? 1 : level === "deep" ? deepPanelSize(settings) : reviewersFor(settings, round);
  return { level, reason, max: levelRounds(settings, level), size };
}

/** Which configured model a reviewer session runs on: the panel model (§5.1) or a level's own (§5.2.3); none: the reviewer's. */
export type ReviewSeat = "panel" | "light" | "deep" | undefined;
export function roundSeat(settings: AutomationSettings, plan: Pick<ReviewPlan, "level" | "size">): ReviewSeat {
  if (plan.level === "light") return settings.levels?.light?.reviewer ? "light" : undefined;
  if (plan.level === "deep") return settings.levels?.deep?.panelReviewer ? "deep" : settings.panelReviewer ? "panel" : undefined;
  return plan.size > 1 && settings.panelReviewer ? "panel" : undefined;
}
export const seatOf = (job: Pick<AutomationJob, "seat" | "panel">): ReviewSeat => job.seat ?? (job.panel ? "panel" : undefined);
export function seatModel(settings: AutomationSettings, seat: ReviewSeat): AgentModel | undefined {
  switch (seat) {
    case "light":
      return settings.levels?.light?.reviewer ?? settings.reviewer;
    case "deep":
      return settings.levels?.deep?.panelReviewer ?? settings.panelReviewer ?? settings.reviewer;
    case "panel":
      return settings.panelReviewer ?? settings.reviewer;
    default:
      return settings.reviewer;
  }
}

/** Why a card has its level, for agent prompts and activity notes (daemon English). */
export function reasonText(reason: LevelReason): string {
  switch (reason.kind) {
    case "card":
      return "it is set on the card";
    case "tag":
      return `the card has the tag ${reason.tag}`;
    case "ancestor_tag":
      return `its ancestor card "${reason.title}" has the tag ${reason.tag}`;
    case "keyword":
      return reason.field === "acceptance" ? `its acceptance criteria mention "${reason.keyword}"` : `its ${reason.field} mentions "${reason.keyword}"`;
    case "light_tag":
      return `the card has the tag ${levelTags.light}`;
    case "default":
      return "no tag or keyword calls for a deep or light review";
  }
}

const levelNames: Record<ReviewLevel, string> = { light: "Light", standard: "Standard", deep: "Deep" };
/** The `review_level_set` note (daemon English): "Review level: Deep", or Auto when the card no longer has one. */
export const reviewLevelNote = (level: ReviewLevel | undefined) => `Review level: ${level ? levelNames[level] : "Auto"}`;
/**
 * The `automation_review_started` note: every round names its level and why (§5.2.5), "Deep review round 1 of 3
 * (panel of 3 reviewers); level deep: …", also a Standard round Auto chose because nothing called for another.
 */
export function reviewStartNote(round: number, plan: ReviewPlan) {
  const panel = plan.size > 1 ? ` (panel of ${plan.size} reviewers)` : "";
  return `${levelNames[plan.level]} review round ${round} of ${plan.max}${panel}; level ${plan.level}: ${reasonText(plan.reason)}`;
}

/**
 * Whether the job's risks were reported on an earlier delivery than its latest one (§5.2.4): the next round's reviewer
 * gave up, the rounds ran out, or a new run has not been reviewed yet. They stay until the next verdict, labelled.
 */
export const risksEarlier = (job: Pick<AutomationJob, "risks" | "risksFrom" | "latestDelivery" | "deliveryEvent">) =>
  !!job.risks?.length && !!job.risksFrom?.delivery && job.risksFrom.delivery !== (job.latestDelivery ?? job.deliveryEvent);
/** Where earlier risks came from, for the parent's wake-up line and get_task handoffs (agent English); else undefined. */
export const risksOrigin = (job: Pick<AutomationJob, "risks" | "risksFrom" | "latestDelivery" | "deliveryEvent">) =>
  risksEarlier(job) ? `reported in review round ${job.risksFrom!.round} on an earlier delivery; some may be fixed` : undefined;

type LevelKey = "reviewer" | "maxReviewRounds" | "panelReviewer" | "panelSize";
function levelDefault(settings: AutomationSettings, level: "light" | "deep", key: LevelKey): number | undefined {
  if (key === "maxReviewRounds") return level === "light" ? Math.min(2, settings.maxReviewRounds) : settings.maxReviewRounds;
  if (key === "panelSize") return deepDefaults.size;
  return undefined;
}
/**
 * The settings change for a review-level choice in Edit project, or null when it changes nothing (§5.2.6). Picking the
 * default (or no model) removes the key, and an empty level or `levels` goes with it, so boards stay readable by
 * builds without levels.
 */
export function levelChoice(
  settings: AutomationSettings,
  level: "light" | "deep",
  key: LevelKey,
  value: number | AgentModel | null,
): Pick<AutomationSettings, "levels"> | null {
  const current = { ...(settings.levels?.[level] ?? {}) } as Record<string, unknown>;
  const stored = current[key];
  const clear = value === null || value === levelDefault(settings, level, key);
  if (clear ? stored === undefined : JSON.stringify(stored) === JSON.stringify(value)) return null;
  if (clear) delete current[key];
  else current[key] = value;
  const levels: Record<string, unknown> = { ...(settings.levels ?? {}) };
  if (Object.keys(current).length) levels[level] = current;
  else delete levels[level];
  return { levels: Object.keys(levels).length ? (levels as LevelSettings) : undefined };
}
