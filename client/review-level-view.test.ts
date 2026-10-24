import { expect, test } from "vitest";
import type { AutomationJob } from "../shared/automation";
import { automationSignal, levelReasonText, reviewLevelLabels, reviewRoundText } from "./automation-view";
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
