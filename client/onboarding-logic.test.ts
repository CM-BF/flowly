import { describe, expect, test } from "vitest";
import { nextTip, stepPage, welcomeDecision, welcomePageCount, withTipSeen, type TipFacts } from "./onboarding-logic";
import { onboardingSettingsValues } from "../shared/settings";

const base = { settingsStatus: "ready", welcomeSeen: false, boardLoaded: true, projectCount: 0, blocked: false };

describe("welcome tour decision", () => {
  test("a new user with an empty board sees it", () => {
    expect(welcomeDecision(base)).toBe("show");
  });
  test("unknown settings or board never show it", () => {
    for (const settingsStatus of ["loading", "error", "invalid"]) expect(welcomeDecision({ ...base, settingsStatus })).toBe("wait");
    expect(welcomeDecision({ ...base, boardLoaded: false })).toBe("wait");
  });
  test("an existing user is marked seen without being interrupted", () => {
    expect(welcomeDecision({ ...base, projectCount: 2 })).toBe("mark-seen");
    expect(welcomeDecision({ ...base, projectCount: 2, blocked: true })).toBe("mark-seen");
  });
  test("a seen tour is never shown again", () => {
    expect(welcomeDecision({ ...base, welcomeSeen: true })).toBe("none");
    expect(welcomeDecision({ ...base, welcomeSeen: true, projectCount: 3 })).toBe("none");
  });
  test("waits while another dialog is open", () => {
    expect(welcomeDecision({ ...base, blocked: true })).toBe("wait");
  });
});

test("tour paging stays inside the pages", () => {
  expect(stepPage(0, -1)).toBe(0);
  expect(stepPage(0, 1)).toBe(1);
  expect(stepPage(welcomePageCount - 1, 1)).toBe(welcomePageCount - 1);
});

describe("tips", () => {
  const none: TipFacts = { hasCard: false, needsYou: false, openIdea: false, movedToFinished: false };
  test("nothing to show without a fact", () => {
    expect(nextTip({ tipsSeen: [], facts: none, blocked: false })).toBeNull();
  });
  test("one tip at a time, waiting-for-you first", () => {
    const facts = { hasCard: true, needsYou: true, openIdea: true, movedToFinished: false };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("needs-you");
    expect(nextTip({ tipsSeen: ["needs-you"], facts, blocked: false })).toBe("first-idea");
    expect(nextTip({ tipsSeen: ["needs-you", "first-idea"], facts, blocked: false })).toBe("first-card");
  });
  test("a tip is shown once", () => {
    const facts = { ...none, movedToFinished: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("first-done");
    expect(nextTip({ tipsSeen: ["first-done"], facts, blocked: false })).toBeNull();
  });
  test("no tip while the tour or another dialog is open", () => {
    expect(nextTip({ tipsSeen: [], facts: { ...none, hasCard: true }, blocked: true })).toBeNull();
  });
  test("recording a tip is idempotent and bounded", () => {
    expect(withTipSeen(["a"], "a")).toEqual(["a"]);
    expect(withTipSeen(["a"], "b")).toEqual(["a", "b"]);
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(withTipSeen(many, "new")).toHaveLength(20);
  });
});

test("stored onboarding settings tolerate missing or invalid fields", () => {
  expect(onboardingSettingsValues(undefined)).toEqual({ welcomeSeen: false, tipsSeen: [] });
  expect(onboardingSettingsValues({ welcomeSeen: true })).toEqual({ welcomeSeen: true, tipsSeen: [] });
  expect(onboardingSettingsValues({ welcomeSeen: "yes" }).welcomeSeen).toBe(false);
});
