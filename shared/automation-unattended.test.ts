import { expect, test } from "vitest";
import { deepCriteria, nudgePrompt, reviewPrompt, startPrompt, unattendedNote } from "./automation";
import { reviewerChecklist } from "./turn-checklist";
import { automationSettingsSchema } from "./automation-schema";

// Requirement-driven review, best-effort delivery and unattended projects (AUTOMATION-SPEC §5.3).
const rounds = [
  ["standard serial round 1", reviewPrompt(1, 3)],
  ["standard serial round 2", reviewPrompt(2, 3)],
  ["standard serial round 3", reviewPrompt(3, 3)],
  ["standard panel round", reviewPrompt(3, 3, 3)],
  ["light round", reviewPrompt(1, 2, 1, "light")],
  ["deep panel round", reviewPrompt(1, 3, 3, "deep", { why: "its description mentions \"database\"" })],
] as const;

test("every review round audits the card's own requirements and prohibitions, the changed files and regressions", () => {
  for (const [name, text] of rounds) {
    expect(text, name).toContain("list each explicit requirement and prohibition in the card's description and the people's comments");
    expect(text, name).toContain("the workpad's acceptance criteria were written by the implementer and may leave some out");
    expect(text, name).toContain("tests, test data, fixtures and generated files included, for forbidden content (binary or encoded payloads");
    expect(text, name).toContain("Compare with the state before the card: nothing that worked may break");
    expect(text, name).toContain("A violated requirement or prohibition, a gamed check, a regression or a delivery that only works in this session is a finding requiring changes, never a risk");
    expect(text, name).toContain("as another unprivileged user, with its own source and install directories read-only, and without this session's caches, build products or environment variables");
    expect(text, name).toContain("Code that writes into its own directories at import or run time, builds itself on first use, or needs files only this session created is a finding unless the card asks for it");
    expect(text, name).toContain("Without Git history there is no diff: find the changed files yourself");
    expect(text, name).toContain("verdict=approve only when the card's requirements and prohibitions and the acceptance criteria are met");
  }
});

test("a claim that the task cannot be done is tested by the reviewer, and the verdict is never handed to a person", () => {
  for (const [name, text] of rounds) {
    expect(text, name).toContain("treat that as a claim to test, not a fact");
    expect(text, name).toContain("neither refuted nor confirmed, request changes with your doubt and what to try next");
    expect(text, name).toContain("Whether the delivery meets the card is yours to decide, not a person's");
    expect(text, name).toContain("only for what only they can give (credentials, access, an authorization, or a preference the card and comments leave open)");
    expect(text, name).not.toContain("If only a person can decide something");
  }
});

test("reviews converge: edge cases the card does not ask for are risks, and later rounds verify earlier findings first", () => {
  for (const [name, text] of rounds) {
    expect(text, name).toContain("rare edge cases the card does not ask for (extreme sizes or depths, resource limits, signals, contrived timing races) go in risks");
    expect(text, name).toContain("Send every confirmed finding at once, not one per round");
  }
  expect(reviewPrompt(1, 3)).not.toContain("This is round");
  expect(reviewPrompt(2, 3)).toContain("This is round 2: first check each finding of the earlier rounds against the new delivery and look for regressions");
  expect(reviewPrompt(3, 3, 3, "deep")).toContain("do not hold the card for newly found minor edge cases (put them in risks)");
});

test("panel and contract reviewers get the card's description with its requirements and prohibitions", () => {
  const panel = reviewPrompt(3, 3, 3);
  expect(panel).toContain("the card's description word for word (its requirements and prohibitions)");
  expect(panel).toContain("the contract: every requirement and prohibition in the card's description and comments");
  expect(reviewPrompt(1, 3, 3, "deep")).toContain("1. contract and correctness: every requirement and prohibition in the card's description and comments");
  expect(reviewPrompt(3, 3)).toContain("audit the delivery strictly against every requirement and prohibition in them");
});

test("in an unattended project no instruction tells an agent to ask a person", () => {
  const unattended = [
    reviewPrompt(1, 3, 1, "standard", { unattended: true }),
    reviewPrompt(3, 3, 3, "standard", { unattended: true }),
    reviewPrompt(1, 3, 3, "deep", { unattended: true }),
    nudgePrompt(1, 2, "reviewer", true),
  ];
  for (const text of unattended) {
    expect(text).toContain("nobody answers questions in this project: decide the verdict yourself");
    expect(text).not.toContain("kind=question");
    expect(text).not.toMatch(/ask a person/i);
  }
  expect(reviewPrompt(3, 3, 3, "standard", { unattended: true })).toContain("do not end your turn before you call flowly_submit_review: a turn that ends without it counts as an unfinished review");

  const implementer = nudgePrompt(1, 2, "implementer", true);
  expect(implementer).toContain("Your turn ended without a delivery (reminder 1 of 2)");
  expect(implementer).toContain("Nobody answers questions in this project: do not ask or report a blocker.");
  expect(implementer).toContain("Without a delivery after the last reminder, automation stops.");
  expect(implementer).not.toContain("kind=question");

  const start = startPrompt({ review: true, again: false, unattended: true });
  expect(start.endsWith(unattendedNote)).toBe(true);
  expect(unattendedNote).toContain("Never ask or report a blocker (flowly_report_progress kind=question or blocker, status=blocked, or your own question tool)");
  expect(startPrompt({ review: true, again: false })).not.toContain(unattendedNote);
});

test("the implementer delivers on the most reasonable reading and asks only for what only a person can give", () => {
  const start = startPrompt({ review: true, again: false });
  expect(start).toContain("Doubt is not a reason to stop: if the task looks impossible, contradictory or wrong, test that conclusion first");
  expect(start).toContain("deliver every required output, and state your doubts and the assumptions you chose in the delivery note");
  expect(start).toContain("only when only a person can unblock you (credentials, access, a decision only they can make) or going on would cause irreversible harm");
  expect(start).toContain("never add forbidden content, hard-code expected outputs, or edit tests or inputs to make checks pass");
  expect(start).toContain("in a workspace without Git history, list every file you created, changed or deleted");
  expect(start).toContain("Make the delivery work where it will be used, not only in this session: for another unprivileged user, with its own directories read-only");
  expect(start).not.toContain("do not guess");

  const nudge = nudgePrompt(1, 2);
  expect(nudge).toContain("doubt is not a reason to stop: deliver on the most reasonable reading and state your assumptions in the note");
  expect(nudge).toContain("Ask with flowly_report_progress kind=question or set status=blocked with the reason only when only a person can unblock you.");
  expect(nudgePrompt(1, 2, "reviewer")).toContain("Whether the delivery meets the card is yours to decide, not a person's");
});

test("sub-cards: deep only for foundation work, and directory workspaces run them one at a time", () => {
  const start = startPrompt({ review: true, again: false });
  expect(start).toContain(`Give review_level=deep only to ${deepCriteria}`);
  expect(deepCriteria).toContain("A self-contained program verified by tests (a clone of a reference CLI, a parser, an emulator or hardware block, a benchmark task) is standard");
  expect(start).toContain("In a directory workspace automated sub-cards share the project root and run one at a time, so split there only when a part needs its own session, not for speed.");
  expect(reviewPrompt(1, 3, 3, "deep")).toContain("Deep review is for foundation work that later cards or stored data depend on");
});

test("the reviewer checklist checks the card's requirements and keeps the verdict with the reviewer", () => {
  expect(reviewerChecklist[2]).toContain("Check every requirement and prohibition in the card's description and comments, not only the workpad");
  expect(reviewerChecklist[2]).toContain("ask a person with flowly_report_progress kind=question only for what only they can give, never in an unattended project");
});

test("unattended is an optional project setting, absent unless a person turns it on", () => {
  expect(automationSettingsSchema.parse({ enabled: true })).not.toHaveProperty("unattended");
  expect(automationSettingsSchema.parse({ enabled: true, unattended: true }).unattended).toBe(true);
  expect(() => automationSettingsSchema.parse({ enabled: true, unattended: "yes" })).toThrow();
});
