import { describe, expect, test } from "vitest";
import { TIPS_SEEN_MAX, cardTreeTipDue, reviewRisksTipDue, firstRunOutside, loopAutoStep, memoryAutoStep, nextTip, outsidePatch, outsideShown, settingsHintDue, stepPage, tipIds, tourKey, welcomeDecision, welcomePageCount, withTipSeen, type TipFacts } from "./onboarding-logic";
import { buildCardTree } from "../shared/card-tree";
import { featureSettingsValues, nativeSessionSettingsValues, onboardingSettingsValues } from "../shared/settings";

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
  const none: TipFacts = { hasCard: false, needsYou: false, openIdea: false, movedToFinished: false, hasArtifact: false, hasAgentTag: false, agentQuestion: false, olderHidden: false, nextMove: false, hasTicket: false, noConnection: false, projectTabs: false, hasWorkpad: false, busyBoard: false, hasSubagent: false, workflowSuggestion: false, crowdedAttention: false, fullSidebar: false, cardOpen: false, cardWithSession: false, hasSummary: false, memoryCandidate: false, automationCandidate: false, hasSubCards: false, cardCommentable: false, skillDraft: false };
  test("nothing to show without a fact", () => {
    expect(nextTip({ tipsSeen: [], facts: none, blocked: false })).toBeNull();
  });
  test("one tip at a time, waiting-for-you first", () => {
    const facts = { hasCard: true, needsYou: true, openIdea: true, movedToFinished: false, hasArtifact: true, hasAgentTag: true, agentQuestion: false, olderHidden: false, nextMove: false, hasTicket: false, noConnection: false, projectTabs: false, hasWorkpad: false, busyBoard: false, hasSubagent: false, workflowSuggestion: false, crowdedAttention: false, fullSidebar: false, cardOpen: false, cardWithSession: false, hasSummary: false, memoryCandidate: false, automationCandidate: false, hasSubCards: false, cardCommentable: false, skillDraft: false };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("needs-you");
    expect(nextTip({ tipsSeen: ["needs-you"], facts, blocked: false })).toBe("first-idea");
    expect(nextTip({ tipsSeen: ["needs-you", "first-idea"], facts, blocked: false })).toBe("first-artifact");
    expect(nextTip({ tipsSeen: ["needs-you", "first-idea", "first-artifact"], facts, blocked: false })).toBe("first-tag");
    expect(nextTip({ tipsSeen: ["needs-you", "first-idea", "first-artifact", "first-tag"], facts, blocked: false })).toBe("first-card");
  });
  test("an agent question points to answering in the session before the generic needs-you tip", () => {
    const facts = { ...none, needsYou: true, agentQuestion: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("agent-question");
    expect(nextTip({ tipsSeen: ["agent-question"], facts, blocked: false })).toBe("needs-you");
  });
  test("a tip is shown once", () => {
    const facts = { ...none, movedToFinished: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("first-done");
    expect(nextTip({ tipsSeen: ["first-done"], facts, blocked: false })).toBeNull();
  });
  test("folded finished cards are announced after the wrap-up tip, before ideas", () => {
    const facts = { ...none, olderHidden: true, movedToFinished: true, openIdea: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("first-done");
    expect(nextTip({ tipsSeen: ["first-done"], facts, blocked: false })).toBe("older-finished");
    expect(nextTip({ tipsSeen: ["first-done", "older-finished"], facts, blocked: false })).toBe("first-idea");
  });
  test("suggested next steps are announced after waiting-for-you tips, before ideas", () => {
    const facts = { ...none, nextMove: true, openIdea: true, needsYou: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("needs-you");
    expect(nextTip({ tipsSeen: ["needs-you"], facts, blocked: false })).toBe("next-move");
    expect(nextTip({ tipsSeen: ["needs-you", "next-move"], facts, blocked: false })).toBe("first-idea");
  });
  test("a card's workpad is announced after suggested next steps, before ideas and artifacts", () => {
    const facts = { ...none, nextMove: true, hasWorkpad: true, openIdea: true, hasArtifact: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("next-move");
    expect(nextTip({ tipsSeen: ["next-move"], facts, blocked: false })).toBe("first-workpad");
    expect(nextTip({ tipsSeen: ["next-move", "first-workpad"], facts, blocked: false })).toBe("first-idea");
    expect(nextTip({ tipsSeen: ["first-workpad"], facts: { ...none, hasWorkpad: true }, blocked: false })).toBeNull();
  });
  test("a project-memory candidate is announced after ideas, before the workflow-insights tip", () => {
    const facts = { ...none, openIdea: true, memoryCandidate: true, workflowSuggestion: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("first-idea");
    expect(nextTip({ tipsSeen: ["first-idea"], facts, blocked: false })).toBe("first-memory-candidate");
    expect(nextTip({ tipsSeen: ["first-idea", "first-memory-candidate"], facts, blocked: false })).toBe("first-workflow-insight");
    expect(nextTip({ tipsSeen: ["first-memory-candidate"], facts: { ...none, memoryCandidate: true }, blocked: false })).toBeNull();
  });
  test("a workflow-insights suggestion is announced after ideas, before artifacts", () => {
    const facts = { ...none, openIdea: true, workflowSuggestion: true, hasArtifact: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("first-idea");
    expect(nextTip({ tipsSeen: ["first-idea"], facts, blocked: false })).toBe("first-workflow-insight");
    expect(nextTip({ tipsSeen: ["first-idea", "first-workflow-insight"], facts, blocked: false })).toBe("first-artifact");
    expect(nextTip({ tipsSeen: [], facts: { ...none, workflowSuggestion: false, hasArtifact: true }, blocked: false })).toBe("first-artifact");
  });
  test("the AI output language is announced once a card has an AI summary, after the workflow-insights tip, before artifacts", () => {
    const facts = { ...none, hasSummary: true, workflowSuggestion: true, hasArtifact: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("first-workflow-insight");
    expect(nextTip({ tipsSeen: ["first-workflow-insight"], facts, blocked: false })).toBe("ai-language");
    expect(nextTip({ tipsSeen: ["first-workflow-insight", "ai-language", "summary-models"], facts, blocked: false })).toBe("first-artifact");
    expect(nextTip({ tipsSeen: [], facts: { ...none, hasSummary: false }, blocked: false })).toBeNull();
  });
 test("summary model priority is announced after AI language and only once", () => {
  const facts = { ...none, hasSummary: true };
  expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("ai-language");
  expect(nextTip({ tipsSeen: ["ai-language"], facts, blocked: false })).toBe("summary-models");
  expect(nextTip({ tipsSeen: ["ai-language", "summary-models"], facts, blocked: false })).toBeNull();
  expect(nextTip({ tipsSeen: [], facts: none, blocked: false })).toBeNull();
 });

  test("a skill draft is announced before the other workflow suggestions and the AI-language tip", () => {
    const facts = { ...none, hasSummary: true, skillDraft: true, workflowSuggestion: true, hasArtifact: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("first-skill-draft");
    expect(nextTip({ tipsSeen: ["first-skill-draft"], facts, blocked: false })).toBe("first-workflow-insight");
    expect(nextTip({ tipsSeen: ["first-skill-draft", "first-workflow-insight", "ai-language", "summary-models"], facts, blocked: false })).toBe("first-artifact");
    expect(nextTip({ tipsSeen: [], facts: { ...none, skillDraft: false }, blocked: false })).toBeNull();
  });
  test("session history is announced in an open card with a session, after the connectors tip, before section order", () => {
    const facts = { ...none, cardOpen: true, cardWithSession: true, fullSidebar: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("connectors");
    expect(nextTip({ tipsSeen: ["connectors"], facts, blocked: false })).toBe("session-history");
    expect(nextTip({ tipsSeen: ["connectors", "session-history"], facts, blocked: false })).toBe("sidebar-order");
    expect(nextTip({ tipsSeen: ["connectors"], facts: { ...none, cardOpen: true }, blocked: false })).toBeNull();
  });
  test("subagents are announced after the workpad tip, before ideas", () => {
    const facts = { ...none, hasWorkpad: true, hasSubagent: true, openIdea: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("first-workpad");
    expect(nextTip({ tipsSeen: ["first-workpad"], facts, blocked: false })).toBe("subagents");
    expect(nextTip({ tipsSeen: ["first-workpad", "subagents"], facts, blocked: false })).toBe("first-idea");
  });
  test("a busy board points to card display after the first-card tip, before project tabs", () => {
    const facts = { ...none, hasCard: true, busyBoard: true, projectTabs: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("first-card");
    expect(nextTip({ tipsSeen: ["first-card"], facts, blocked: false })).toBe("card-display");
    expect(nextTip({ tipsSeen: ["first-card", "card-display"], facts, blocked: false })).toBe("project-menu");
    expect(nextTip({ tipsSeen: [], facts: { ...none, busyBoard: true }, blocked: false })).toBe("card-display");
    // An open card with several sections: point at the section order, after the card display tip.
    expect(nextTip({ tipsSeen: [], facts: { ...none, fullSidebar: true }, blocked: false })).toBe("sidebar-order");
    expect(nextTip({ tipsSeen: [], facts: { ...none, busyBoard: true, fullSidebar: true }, blocked: false })).toBe("card-display");
    expect(nextTip({ tipsSeen: ["card-display"], facts: { ...none, fullSidebar: true, projectTabs: true }, blocked: false })).toBe("sidebar-order");
  });
  test("Jira tickets: the attached-ticket tip follows artifacts; connecting Jira is announced last", () => {
    const facts = { ...none, hasCard: true, hasArtifact: true, hasTicket: true, noConnection: true };
    expect(nextTip({ tipsSeen: ["first-artifact"], facts, blocked: false })).toBe("first-ticket");
    expect(nextTip({ tipsSeen: ["first-artifact", "first-ticket"], facts, blocked: false })).toBe("first-card");
    expect(nextTip({ tipsSeen: ["first-artifact", "first-ticket", "first-card"], facts, blocked: false })).toBe("jira-connect");
    // With a connection configured there is nothing to announce.
    expect(nextTip({ tipsSeen: ["first-card"], facts: { ...none, hasCard: true }, blocked: false })).toBeNull();
  });
  test("connectors: the Artifacts + is announced once a card is open, before the section order (CONNECTORS-SPEC §8.5)", () => {
    expect(nextTip({ tipsSeen: [], facts: { ...none, cardOpen: true }, blocked: false })).toBe("connectors");
    expect(nextTip({ tipsSeen: [], facts: { ...none, cardOpen: true, fullSidebar: true }, blocked: false })).toBe("connectors");
    expect(nextTip({ tipsSeen: ["connectors"], facts: { ...none, cardOpen: true, fullSidebar: true }, blocked: false })).toBe("sidebar-order");
    // Users who saw the older Jira tips still get it once: it is a new id.
    expect(nextTip({ tipsSeen: ["first-ticket", "jira-connect"], facts: { ...none, cardOpen: true }, blocked: false })).toBe("connectors");
    expect(nextTip({ tipsSeen: [], facts: none, blocked: false })).toBeNull();
  });
  test("the project tab menu is announced after the first-card tip, before connecting Jira", () => {
    const facts = { ...none, hasCard: true, noConnection: true, projectTabs: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("first-card");
    expect(nextTip({ tipsSeen: ["first-card"], facts, blocked: false })).toBe("project-menu");
    expect(nextTip({ tipsSeen: ["first-card", "project-menu"], facts, blocked: false })).toBe("jira-connect");
    // A single project (or the compact switcher) has no tabs to point at.
    expect(nextTip({ tipsSeen: ["first-card"], facts: { ...none, hasCard: true }, blocked: false })).toBeNull();
  });
  test("a crowded Attention list points to Dismiss right after the waiting-for-you tips", () => {
    const facts = { ...none, needsYou: true, crowdedAttention: true, hasCard: true };
    expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("needs-you");
    expect(nextTip({ tipsSeen: ["needs-you"], facts, blocked: false })).toBe("attention-dismiss");
    expect(nextTip({ tipsSeen: ["needs-you", "attention-dismiss"], facts, blocked: false })).toBe("first-card");
    expect(nextTip({ tipsSeen: [], facts: { ...none, crowdedAttention: true }, blocked: false })).toBe("attention-dismiss");
  });
  test("no tip while the tour or another dialog is open", () => {
    expect(nextTip({ tipsSeen: [], facts: { ...none, hasCard: true }, blocked: true })).toBeNull();
  });
  test("recording a tip is idempotent and bounded", () => {
    expect(withTipSeen(["a"], "a")).toEqual(["a"]);
    expect(withTipSeen(["a"], "b")).toEqual(["a", "b"]);
    const many = Array.from({ length: TIPS_SEEN_MAX }, (_, i) => `t${i}`);
    expect(withTipSeen(many, "new")).toHaveLength(TIPS_SEEN_MAX);
    // Every tip id fits with room to spare, so recording a new one never evicts a known one.
    const all = tipIds.reduce<string[]>((seen, id) => withTipSeen(seen, id), []);
    expect(all).toEqual([...tipIds]);
    expect(tipIds.length * 2).toBeLessThan(TIPS_SEEN_MAX);
  });
});

test("stored onboarding settings tolerate missing or invalid fields", () => {
  expect(onboardingSettingsValues(undefined)).toEqual({ welcomeSeen: false, tipsSeen: [], whatsNewSeen: "" });
  expect(onboardingSettingsValues({ welcomeSeen: true })).toEqual({ welcomeSeen: true, tipsSeen: [], whatsNewSeen: "" });
  expect(onboardingSettingsValues({ welcomeSeen: "yes" }).welcomeSeen).toBe(false);
});

test("agent automation is introduced on a board with a card an agent could pick up, after the first-card tip", () => {
  const none: TipFacts = { hasCard: false, skillDraft: false, needsYou: false, openIdea: false, movedToFinished: false, hasArtifact: false, hasAgentTag: false, agentQuestion: false, olderHidden: false, nextMove: false, hasTicket: false, noConnection: false, projectTabs: false, hasWorkpad: false, busyBoard: false, hasSubagent: false, workflowSuggestion: false, crowdedAttention: false, fullSidebar: false, cardOpen: false, cardWithSession: false, hasSummary: false, memoryCandidate: false, automationCandidate: false, hasSubCards: false, cardCommentable: false };
  const facts = { ...none, hasCard: true, automationCandidate: true, busyBoard: true };
  expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("first-card");
  expect(nextTip({ tipsSeen: ["first-card"], facts, blocked: false })).toBe("agent-automation");
  expect(nextTip({ tipsSeen: ["first-card", "agent-automation"], facts, blocked: false })).toBe("card-display");
  expect(nextTip({ tipsSeen: [], facts: { ...none, automationCandidate: false }, blocked: false })).toBeNull();
});

test("the card tree is announced once the project nests or chains cards, right after sub-cards (CARD-TREE-SPEC §6)", () => {
  const none: TipFacts = { hasCard: false, skillDraft: false, needsYou: false, openIdea: false, movedToFinished: false, hasArtifact: false, hasAgentTag: false, agentQuestion: false, olderHidden: false, nextMove: false, hasTicket: false, noConnection: false, projectTabs: false, hasWorkpad: false, busyBoard: false, hasSubagent: false, workflowSuggestion: false, crowdedAttention: false, fullSidebar: false, cardOpen: false, cardWithSession: false, hasSummary: false, memoryCandidate: false, automationCandidate: false, hasSubCards: false, cardCommentable: false };
  expect(nextTip({ tipsSeen: [], facts: { ...none, hasSubCards: true, hasCardTree: true, hasSubagent: true }, blocked: false })).toBe("sub-cards");
  // Existing users saw sub-cards long ago: the new id still reaches them once.
  expect(nextTip({ tipsSeen: ["sub-cards"], facts: { ...none, hasSubCards: true, hasCardTree: true, hasSubagent: true }, blocked: false })).toBe("card-tree");
  expect(nextTip({ tipsSeen: ["sub-cards", "card-tree"], facts: { ...none, hasCardTree: true }, blocked: false })).toBeNull();
  expect(nextTip({ tipsSeen: [], facts: { ...none, hasCardTree: true }, blocked: true })).toBeNull();
  expect(nextTip({ tipsSeen: [], facts: none, blocked: false })).toBeNull();
});

test("the card tree tip waits for a sub-card's sub-card or a second blocks link (CARD-TREE-SPEC §6)", () => {
  const cards = ["a", "b", "c", "d"].map((id, i) => ({ id, createdAt: `2026-10-24T00:00:0${i}.000Z` }));
  const sub = (from: string, to: string) => ({ id: `${from}-sub-${to}`, kind: "subtask" as const, from, to });
  const blocks = (from: string, to: string) => ({ id: `${from}-blocks-${to}`, kind: "blocks" as const, from, to });
  expect(cardTreeTipDue(null)).toBe(false);
  expect(cardTreeTipDue(buildCardTree(cards, []))).toBe(false);
  // One level of sub-cards is the sub-cards tip's business; one blocks link is a plain card link.
  expect(cardTreeTipDue(buildCardTree(cards, [sub("b", "a"), sub("c", "a"), blocks("b", "c")]))).toBe(false);
  expect(cardTreeTipDue(buildCardTree(cards, [sub("b", "a"), sub("c", "b")]))).toBe(true);
  expect(cardTreeTipDue(buildCardTree(cards, [blocks("a", "b"), blocks("c", "d")]))).toBe(true);
});

test("reviewer risks are pointed out once, on a delivered card In review, before the person accepts it (AUTOMATION-SPEC §5.2.4)", () => {
  const none: TipFacts = { hasCard: false, skillDraft: false, needsYou: false, openIdea: false, movedToFinished: false, hasArtifact: false, hasAgentTag: false, agentQuestion: false, olderHidden: false, nextMove: false, hasTicket: false, noConnection: false, projectTabs: false, hasWorkpad: false, busyBoard: false, hasSubagent: false, workflowSuggestion: false, crowdedAttention: false, fullSidebar: false, cardOpen: false, cardWithSession: false, hasSummary: false, memoryCandidate: false, automationCandidate: false, hasSubCards: false, cardCommentable: false };
  // Waiting for the person comes first; it outranks the introductions, the done tip included.
  expect(nextTip({ tipsSeen: [], facts: { ...none, needsYou: true, reviewRisks: true, movedToFinished: true }, blocked: false })).toBe("needs-you");
  expect(nextTip({ tipsSeen: ["needs-you"], facts: { ...none, needsYou: true, reviewRisks: true, movedToFinished: true }, blocked: false })).toBe("review-risks");
  expect(nextTip({ tipsSeen: ["needs-you", "review-risks"], facts: { ...none, reviewRisks: true }, blocked: false })).toBeNull();
  const cards = [
    { id: "a", status: "in_review", archivedAt: null },
    { id: "b", status: "done", archivedAt: null },
    { id: "c", status: "in_review", archivedAt: "2026-10-24T00:00:00.000Z" },
  ];
  expect(reviewRisksTipDue(cards, [{ taskId: "a", state: "delivered", risks: ["It grows forever."] }])).toBe(true);
  expect(reviewRisksTipDue(cards, [{ taskId: "a", state: "delivered" }, { taskId: "a", state: "delivered", risks: [] }])).toBe(false);
  // Still under review, accepted already, or archived: nothing to point at.
  expect(reviewRisksTipDue(cards, [{ taskId: "a", state: "reviewing", risks: ["x"] }, { taskId: "b", state: "delivered", risks: ["x"] }, { taskId: "c", state: "delivered", risks: ["x"] }])).toBe(false);
});

test("Handoff is announced once for an available card record and waits behind a question", () => {
  const facts = { handoffAvailable: true } as TipFacts;
  expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("card-handoff");
  expect(nextTip({ tipsSeen: ["card-handoff"], facts, blocked: false })).toBeNull();
  expect(nextTip({ tipsSeen: [], facts: { ...facts, agentQuestion: true }, blocked: false })).toBe("agent-question");
  expect(nextTip({ tipsSeen: [], facts, blocked: true })).toBeNull();
});

test("sub-cards are explained once a card of the project has them, before Paseo subagents", () => {
  const none: TipFacts = { hasCard: false, skillDraft: false, needsYou: false, openIdea: false, movedToFinished: false, hasArtifact: false, hasAgentTag: false, agentQuestion: false, olderHidden: false, nextMove: false, hasTicket: false, noConnection: false, projectTabs: false, hasWorkpad: false, busyBoard: false, hasSubagent: false, workflowSuggestion: false, crowdedAttention: false, fullSidebar: false, cardOpen: false, cardWithSession: false, hasSummary: false, memoryCandidate: false, automationCandidate: false, hasSubCards: false, cardCommentable: false };
  expect(nextTip({ tipsSeen: [], facts: { ...none, hasSubCards: true, hasSubagent: true }, blocked: false })).toBe("sub-cards");
  expect(nextTip({ tipsSeen: ["sub-cards"], facts: { ...none, hasSubCards: true }, blocked: false })).toBeNull();
});

test("single-input guidance is shown once when the board is visible", () => {
  const facts = { taskIntake: true } as TipFacts;
  expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("task-intake");
  expect(nextTip({ tipsSeen: ["task-intake"], facts, blocked: false })).toBeNull();
});

test("card comments are announced once in an open card that has a session and takes comments, before the connectors tip (CARD-COMMENTS-SPEC §5)", () => {
  const none: TipFacts = { hasCard: false, skillDraft: false, needsYou: false, openIdea: false, movedToFinished: false, hasArtifact: false, hasAgentTag: false, agentQuestion: false, olderHidden: false, nextMove: false, hasTicket: false, noConnection: false, projectTabs: false, hasWorkpad: false, busyBoard: false, hasSubagent: false, workflowSuggestion: false, crowdedAttention: false, fullSidebar: false, cardOpen: false, cardWithSession: false, hasSummary: false, memoryCandidate: false, automationCandidate: false, hasSubCards: false, cardCommentable: false };
  const facts = { ...none, cardOpen: true, cardWithSession: true, cardCommentable: true };
  expect(nextTip({ tipsSeen: [], facts, blocked: false })).toBe("card-comments");
  expect(nextTip({ tipsSeen: ["card-comments"], facts, blocked: false })).toBe("connectors");
  expect(nextTip({ tipsSeen: ["card-comments", "connectors"], facts, blocked: false })).toBe("session-history");
  // Waiting-for-you tips still come first.
  expect(nextTip({ tipsSeen: [], facts: { ...facts, needsYou: true }, blocked: false })).toBe("needs-you");
  // An archived card (its composer is locked) or a card without a session: not yet.
  expect(nextTip({ tipsSeen: ["connectors", "session-history"], facts: { ...none, cardOpen: true, cardWithSession: true }, blocked: false })).toBeNull();
  // A new id, so users who saw every older tip get it once too.
  expect(nextTip({ tipsSeen: tipIds.filter((id) => id !== "card-comments"), facts, blocked: false })).toBe("card-comments");
  expect(nextTip({ tipsSeen: [...tipIds], facts, blocked: false })).toBeNull();
});

describe("tour setup (ONBOARDING-SETUP-SPEC)", () => {
  test("five pages: how it works, built in, memory, insights, ready", () => {
    expect(welcomePageCount).toBe(5);
    expect(stepPage(3, 1)).toBe(4);
  });
  test("an installed user who never finished the tour keeps sessions outside Flowly off", () => {
    expect(outsideShown(nativeSessionSettingsValues({}))).toEqual({ progress: false, nextMoves: false, ideas: false });
  });
  test("the first run stores all three parts on, with the master switch", () => {
    expect(outsidePatch(firstRunOutside)).toEqual({ outside: true, outsideProgress: true, outsideNextMoves: true, outsideIdeas: true });
  });
  test("all parts off turns the master switch off", () => {
    expect(outsidePatch({ progress: false, nextMoves: false, ideas: false }).outside).toBe(false);
  });
  test("turning one part on never wakes the parts that only looked off because the master was", () => {
    // Stored defaults: master off, every part on.
    const shown = outsideShown(nativeSessionSettingsValues({}));
    expect(outsidePatch({ ...shown, progress: true })).toEqual({ outside: true, outsideProgress: true, outsideNextMoves: false, outsideIdeas: false });
  });
  test("a part shows on only while the master switch is on", () => {
    expect(outsideShown({ outside: true, outsideProgress: true, outsideNextMoves: false, outsideIdeas: true })).toEqual({ progress: true, nextMoves: false, ideas: true });
  });
  test("the settings callout shows once, after the tour closed, when nothing else is open", () => {
    expect(settingsHintDue({ tipsSeen: [], tourClosed: false, blocked: false })).toBe(false);
    expect(settingsHintDue({ tipsSeen: [], tourClosed: true, blocked: false })).toBe(true);
    expect(settingsHintDue({ tipsSeen: [], tourClosed: true, blocked: true })).toBe(false);
    expect(settingsHintDue({ tipsSeen: ["settings-entry"], tourClosed: true, blocked: false })).toBe(false);
  });
  test("the settings callout is never a banner tip", () => {
    const facts: Array<keyof TipFacts> = ["hasCard", "needsYou", "openIdea", "movedToFinished", "hasArtifact", "hasAgentTag", "agentQuestion", "olderHidden", "nextMove", "hasTicket", "noConnection", "projectTabs", "hasWorkpad", "busyBoard", "hasSubagent", "workflowSuggestion", "crowdedAttention", "fullSidebar", "cardOpen", "cardWithSession", "hasSummary", "skillDraft", "memoryCandidate", "taskIntake", "automationCandidate", "hasSubCards", "hasCardTree", "cardCommentable", "reviewRisks", "handoffAvailable"];
    const all = Object.fromEntries(facts.map((k) => [k, true])) as unknown as TipFacts;
    const seen: string[] = [];
    for (let tip = nextTip({ tipsSeen: seen, facts: all, blocked: false }); tip; tip = nextTip({ tipsSeen: seen, facts: all, blocked: false })) seen.push(tip);
    expect(seen).not.toContain("settings-entry");
    expect(seen).toHaveLength(tipIds.length - 1);
  });
  test("memory and Insights are on until turned off", () => {
    expect(featureSettingsValues(undefined)).toEqual({ memory: true, insights: true });
    expect(featureSettingsValues({ insights: false })).toEqual({ memory: true, insights: false });
  });
});

describe("tour keyboard (ONBOARDING-SETUP-SPEC §3.2)", () => {
  test("Enter on the tour goes to the next page and finishes on the last", () => {
    expect(tourKey({ key: "Enter" }, { page: 0, onTour: true })).toBe("next");
    expect(tourKey({ key: "Enter" }, { page: welcomePageCount - 1, onTour: true })).toBe("finish");
  });
  test("Enter on a focused control keeps its own meaning", () => {
    expect(tourKey({ key: "Enter" }, { page: 1, onTour: false })).toBeNull();
  });
  test("arrows page within the tour and stop at its ends", () => {
    expect(tourKey({ key: "ArrowRight" }, { page: 0, onTour: false })).toBe("next");
    expect(tourKey({ key: "ArrowRight" }, { page: welcomePageCount - 1, onTour: true })).toBeNull();
    expect(tourKey({ key: "ArrowLeft" }, { page: 2, onTour: true })).toBe("back");
    expect(tourKey({ key: "ArrowLeft" }, { page: 0, onTour: true })).toBeNull();
  });
  test("modifiers, repeats, composition and other keys do nothing", () => {
    for (const mod of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }])
      expect(tourKey({ key: "Enter", ...mod }, { page: 0, onTour: true })).toBeNull();
    expect(tourKey({ key: "a" }, { page: 0, onTour: true })).toBeNull();
  });
});

describe("Built in demo autoplay (ONBOARDING-SETUP-SPEC §3)", () => {
  const at = { turn: 0, draft: false, working: false, updating: false, idea: "none" as const };
  test("plays the case in order: pick the step, send it, take the idea, then start over", () => {
    expect(loopAutoStep(at)?.cue).toBe("move");
    expect(loopAutoStep({ ...at, draft: true })?.cue).toBe("send");
    expect(loopAutoStep({ ...at, turn: 1, idea: "open" })?.cue).toBe("idea");
    expect(loopAutoStep({ ...at, turn: 1, idea: "task" })?.cue).toBe("restart");
  });
  test("waits while the agent works or Progress updates", () => {
    expect(loopAutoStep({ ...at, draft: false, working: true })).toBeNull();
    expect(loopAutoStep({ ...at, turn: 1, updating: true })).toBeNull();
  });
  test("a turn without an idea has nothing more to play", () => {
    expect(loopAutoStep({ ...at, turn: 2 })).toBeNull();
  });
});

describe("Project memory demo autoplay (ONBOARDING-SETUP-SPEC §3)", () => {
  test("confirms the suggestion, waits for the new card's session, then starts over", () => {
    expect(memoryAutoStep("suggested")?.cue).toBe("confirm");
    expect(memoryAutoStep("confirmed")).toBeNull();
    expect(memoryAutoStep("working")).toBeNull();
    expect(memoryAutoStep("used")?.cue).toBe("restart");
    expect(memoryAutoStep("dismissed")?.cue).toBe("restart");
  });
});
