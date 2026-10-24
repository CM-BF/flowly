import { classificationHash } from "../shared/review-levels";
import { resolveReviewLevel } from "../server/review-levels";
import { expect, test } from "vitest";
import type { AutomationJob } from "../shared/automation";
import { autoLevelHint, autoLevelStatus, automationSignal, deepPanelNone, levelEdit, levelLines, levelReasonText, panelFields, reviewLevelLabels, reviewRoundText, risksHeading } from "./automation-view";
import { automationSettingsSchema } from "../shared/automation";
import { setLocale, withLocale } from "../shared/i18n";
import "../shared/i18n-all";

// AUTOMATION-SPEC §5.2.4, §5.2.5: the card and the drawer say the review level and the reviewer's risks.
const at = "2026-10-24T00:00:00.000Z";
const job = (extra: Partial<AutomationJob>): AutomationJob => ({
  taskId: "a", projectId: "p", state: "reviewing", role: "reviewer", generation: 1, nudges: 0, failures: 0, reviewRounds: 1, queuedAt: at, updatedAt: at, ...extra,
});
const inReview = { status: "in_review" as const };

test("a review round says its level, its cap and its panel", () => {
  setLocale("en");
  const signal = (review: AutomationJob["review"], round = 1) => automationSignal(job({ review, reviewRounds: round }), inReview)?.text;
  expect(signal({ level: "deep", reason: { kind: "card" }, max: 3, size: 3 })).toBe("Deep review round 1 of 3 (panel of 3 reviewers)");
  expect(signal({ level: "light", reason: { kind: "light_tag" }, max: 2, size: 1 }, 2)).toBe("Light review round 2 of 2");
  expect(signal({ level: "standard", reason: { kind: "default" }, max: 3, size: 1 })).toBe("Standard review round 1 of 3");
  expect(signal({ level: "standard", reason: { kind: "default" }, max: 4, size: 3 }, 3)).toBe("Standard review round 3 of 4 (panel of 3 reviewers)");
  // A job recorded before review levels reads as it always did.
  expect(signal(undefined)).toBe("Agent reviewing");
  expect(reviewRoundText(2, { level: "deep", max: 2, size: 4 })).toBe("Deep review round 2 of 2 (panel of 4 reviewers)");
});

test("a delivered card with reviewer risks says how many, also when the review passed", () => {
  setLocale("en");
  const delivered = (extra: Partial<AutomationJob>) => automationSignal(job({ state: "delivered", role: "implementer", ...extra }), inReview);
  expect(delivered({ verdict: "approved" })).toMatchObject({ text: "Agent review passed", icon: "BadgeCheck", tone: "success" });
  expect(delivered({ verdict: "approved", risks: ["One", "Two"] })).toMatchObject({ text: "Agent review passed · 2 risks", icon: "ShieldAlert", tone: "warning" });
  expect(delivered({ verdict: "approved", risks: ["One"] })?.text).toBe("Agent review passed · 1 risk");
  expect(delivered({ verdict: "changes", risks: ["One"] })).toMatchObject({ text: "Review needs you · 1 risk", tone: "warning" });
  // Accepted (Done): the lane says it, and the drawer keeps the risks.
  expect(automationSignal(job({ state: "delivered", verdict: "approved", risks: ["One"] }), { status: "done" })).toBeNull();
  withLocale("ru", () => expect(delivered({ verdict: "approved", risks: ["1", "2", "3", "4", "5"] })?.text).toBe("Проверка агентом пройдена · 5 рисков"));
});

test("why a card has its level reads as a phrase for the editor and the drawer", () => {
  setLocale("en");
  expect(levelReasonText({ kind: "keyword", keyword: "database", field: "description" })).toBe("its description mentions database");
  expect(levelReasonText({ kind: "keyword", keyword: "schema", field: "acceptance" })).toBe("its acceptance criteria mention schema");
  expect(levelReasonText({ kind: "ancestor_tag", tag: "foundation", cardId: "b", title: "Storage" })).toBe("the card above it, Storage, has the tag foundation");
  expect(levelReasonText({ kind: "light_tag" })).toBe("the card has the tag light-review");
  expect(Object.values(reviewLevelLabels)).toEqual(["Auto", "Light", "Standard", "Deep"]);
  // Every language gives each level its own word.
  for (const code of ["de", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN", "zh-TW"] as const)
    withLocale(code, () => expect(new Set(Object.values(reviewLevelLabels)).size, code).toBe(4));
});

test("the card editor sends the level only when it changed, Auto as null, and says what Auto picks with the draft", () => {
  setLocale("en");
  expect(levelEdit(undefined, "auto")).toEqual({});
  expect(levelEdit("deep", "deep")).toEqual({});
  expect(levelEdit(undefined, "deep")).toEqual({ reviewLevel: "deep" });
  expect(levelEdit("light", "auto")).toEqual({ reviewLevel: null });
  const board = { tasks: [], links: [], workpads: [] };
  const draft = { id: "a", title: "Save drafts", description: "Write them to a SQLite database", tags: [] };
  expect(autoLevelHint(resolveReviewLevel(board, draft))).toBe("Auto: Deep (keyword fallback), because its description mentions database.");
  expect(autoLevelHint(resolveReviewLevel(board, { ...draft, description: "" }))).toBe("Auto: Standard (keyword fallback), because nothing calls for a deeper or lighter review.");
});

test("the drawer's level lines say which round they describe, and the next round's level when the card changed since", () => {
  setLocale("en");
  const review = { level: "deep" as const, reason: { kind: "keyword" as const, keyword: "database", field: "description" as const }, max: 3, size: 3 };
  const deep = { level: "deep" as const, reason: review.reason };
  expect(levelLines(job({ review }), deep)).toEqual(["This review round: Deep (its description mentions database)"]);
  // A person set the card to Standard after the round: the drawer no longer reads as if the card were Deep.
  const working = job({ state: "working", role: "implementer", review });
  expect(levelLines(working, { level: "standard", reason: { kind: "card" } })).toEqual([
    "Last review round: Deep (its description mentions database)",
    "Next review round: Standard (set on the card)",
  ]);
  expect(levelLines(working, null)).toEqual(["Last review round: Deep (its description mentions database)"]);
  expect(levelLines(job({}), deep)).toEqual([]);
});

test("risks from an earlier delivery say so on the card and in the drawer", () => {
  setLocale("en");
  const earlier = { risks: ["One"], risksFrom: { round: 1, delivery: "d1" }, latestDelivery: "d2" };
  const card = automationSignal(job({ state: "delivered", role: "implementer", verdict: "incomplete", ...earlier }), inReview);
  expect(card).toMatchObject({ text: "Review needs you · 1 earlier risk", tone: "warning" });
  expect(automationSignal(job({ state: "delivered", role: "implementer", verdict: "changes", ...earlier, risks: ["One", "Two"] }), inReview)?.text).toBe("Review needs you · 2 earlier risks");
  expect(risksHeading(job({ state: "delivered", ...earlier }))).toBe("Risks noted beyond the acceptance criteria in review round 1, on an earlier delivery");
  // Risks of the latest delivery read as before.
  const current = { risks: ["One"], risksFrom: { round: 2, delivery: "d2" }, latestDelivery: "d2" };
  expect(automationSignal(job({ state: "delivered", role: "implementer", verdict: "changes", ...current }), inReview)?.text).toBe("Review needs you · 1 risk");
  expect(risksHeading(job(current))).toBe("Risks the reviewer noted beyond the acceptance criteria");
  withLocale("ru", () => expect(automationSignal(job({ state: "delivered", role: "implementer", verdict: "incomplete", ...earlier, risks: ["1", "2", "3", "4", "5"] }), inReview)?.text).toBe("Проверка требует вас · 5 более ранних рисков"));
});

test("Edit project keeps the panel model visible, since Deep cards use it, and Deep's none says which model that is", () => {
  setLocale("en");
  const luna = { provider: "codex", model: "gpt-6-luna" };
  const opus = { provider: "claude", model: "claude-opus-5-5" };
  const settings = (extra: object) => automationSettingsSchema.parse({ enabled: true, reviewer: luna, ...extra });
  // Panel review off, or out of reach: Standard cards never panel, Deep cards still do, on the panel model.
  expect(panelFields(settings({ panelReviewer: opus, panelAfter: null }))).toEqual({ panelReviewer: true, panelSize: false, outOfReach: false });
  expect(panelFields(settings({ panelReviewer: opus, maxReviewRounds: 2 }))).toEqual({ panelReviewer: true, panelSize: false, outOfReach: true });
  expect(panelFields(settings({}))).toEqual({ panelReviewer: true, panelSize: true, outOfReach: false });
  expect(deepPanelNone(settings({ panelReviewer: opus, panelAfter: null }))).toBe("Same as panel reviewer");
  expect(deepPanelNone(settings({}))).toBe("Same as reviewer");
});


test("the Auto hint distinguishes model output, pending, stale drafts and keyword fallback", () => {
  setLocale("en");
  const board = { tasks: [], links: [], workpads: [] };
  const task = { id: "a", title: "UI", description: "", reviewClassification: { inputHash: "", status: "pending" as const, at: "", fallback: { level: "standard" as const, reason: { kind: "default" as const } } } };
  task.reviewClassification.inputHash = classificationHash(board, task);
  expect(autoLevelStatus(board, task, task.reviewClassification.fallback)).toBe("Classifying…");
  expect(autoLevelStatus(board, { ...task, title: "new draft" }, task.reviewClassification.fallback)).toBe("Save changes to classify this card.");
  expect(autoLevelHint({ level: "light", reason: { kind: "classifier", model: "one/a", text: "The card changes a label." } })).toBe("Auto: Light — The card changes a label. (one/a)");
  for (const state of ["needs_human", "retry_wait"] as const) {
    expect(levelLines(job({ state, role: "reviewer", review: { level: "light", reason: { kind: "card" }, max: 2, size: 1 } }), null)[0]).toBe("This review round: Light (set on the card)");
  }
});
