import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures, underReview } from "./automation-fixture";
import { automationSettingsSchema, reviewPrompt, reviewersFor } from "../shared/automation";

// AUTOMATION-SPEC §5.1: serial review rounds that keep requesting changes escalate to a panel review.
afterEach(cleanupAutomationFixtures);

const opus = { provider: "claude", model: "claude-opus-5-5" };
const luna = { provider: "codex", model: "gpt-6-luna" };
const sol = { provider: "codex", model: "gpt-6.1-sol" };
const as = (agentId: string) => ({ agentId, taskId: "a", workspaceId: "w-a" });
type Fixture = Awaited<ReturnType<typeof setup>>;

/** The current reviewer asks for changes, its turn ends, and the implementer delivers the rework. */
async function rework(x: Fixture, rev: string, impl: string, finding = "src/a.ts: handle empty input") {
  await x.automation.submitReview(as(rev), { verdict: "changes", summary: "Not yet", findings: [finding] });
  await x.endTurn(rev, "a");
  await x.automation.kick();
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
}
const reviewNotes = async (x: Fixture) => (await x.store.read()).events.filter((e) => e.action === "automation_review_started").map((e) => e.note);

test("by default the third round of a cycle is a panel review by the same reviewer session; its changes reach the implementer as one list", async () => {
  const { x, impl, rev } = await underReview({ maxReviewRounds: 4 });
  expect(x.created[1].prompt).not.toContain("panel review");
  await rework(x, rev, impl);
  expect(x.sent.at(-1)).toMatchObject({ agentId: rev, text: expect.stringContaining("review round 2 of 4)") });
  await rework(x, rev, impl);
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 3, reviewerId: rev });
  expect(x.created).toHaveLength(2);
  const panel = x.sent.at(-1)!;
  expect(panel).toMatchObject({ agentId: rev });
  expect(panel.text).toContain("review round 3 of 4, a panel review");
  expect(panel.text).toContain("3 independent reviewers at once");
  expect(panel.text).toMatch(/1\. the artifact[\s\S]*2\. execution[\s\S]*3\. the contract/);
  expect(panel.text).not.toContain("4. integration");
  expect(await reviewNotes(x)).toEqual(["Review round 1 of 4", "Review round 2 of 4", "Review round 3 of 4 (panel of 3 reviewers)"]);
  await x.automation.submitReview(as(rev), { verdict: "changes", summary: "Three problems", findings: ["a.ts: one", "b.ts: two", "c.ts: three"] });
  await x.endTurn(rev, "a");
  await x.automation.kick();
  const changes = x.sent.at(-1)!;
  expect(changes).toMatchObject({ agentId: impl });
  expect(changes.text).toMatch(/review panel \(3 reviewers\) requested changes[\s\S]*a\.ts: one[\s\S]*c\.ts: three[\s\S]*fix all of them/);
});

test("with a panel reviewer model, panel rounds get their own session on it; a new cycle reviews on the reviewer's model again", async () => {
  const { x, impl, rev } = await underReview({ reviewer: luna, panelReviewer: opus, panelAfter: 1, panelSize: 4 });
  await rework(x, rev, impl);
  expect(x.created).toHaveLength(3);
  const panel = x.created[2];
  expect(panel).toMatchObject({ provider: "claude/claude-opus-5-5", modeId: "bypassPermissions", title: "Panel review: Card a", labels: { "flowly-automation": "reviewer", "paseo-rate-fallback": "off" } });
  expect(panel.prompt).toContain("4 independent reviewers at once");
  expect(panel.prompt).toContain("4. integration and regressions");
  expect(await x.job("a")).toMatchObject({ reviewerId: panel.agentId, panel: true, reviewRounds: 2 });
  // Only the panel session judges this round.
  await expect(x.automation.submitReview(as(rev), { verdict: "approve", summary: "Late" })).rejects.toMatchObject({ code: "NOT_REVIEWER" });
  await x.automation.submitReview(as(panel.agentId), { verdict: "approve", summary: "All four checked" });
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved" });
  // Run again: the panel session is not carried, and round 1 of the new run is serial on the reviewer's model.
  await x.endTurn(panel.agentId, "a");
  await x.automation.queue("a");
  expect(await x.job("a")).not.toHaveProperty("reviewerId");
  await x.automation.kick();
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  expect(x.created.at(-1)).toMatchObject({ provider: "codex/gpt-6-luna", title: "Review: Card a" });
  expect(x.created.at(-1)!.prompt).not.toContain("panel review");
  expect((await x.job("a")).panel).toBeUndefined();
});

test("a panel model that hits a provider limit continues the panel round on the reviewer fallback", async () => {
  const { x, impl, rev } = await underReview({ reviewer: luna, panelReviewer: opus, reviewerFallback: sol, panelAfter: 1 });
  await rework(x, rev, impl);
  const panel = x.created[2].agentId;
  x.advance(1000);
  await x.record("a", { actor: "system", action: "agent.turn_started", agentId: panel });
  x.advance(1000);
  await x.record("a", { actor: "system", action: "agent.turn_ended", agentId: panel, outcome: "failed", note: "You've hit your session limit · resets 2pm" });
  x.agents.get(panel)!.status = "idle";
  await x.automation.turnEnded(panel);
  await x.automation.kick();
  const next = x.created[3];
  expect(next.provider).toBe("codex/gpt-6.1-sol");
  expect(next.prompt).toContain("a panel review");
  expect(await x.job("a")).toMatchObject({ providerLimit: { model: "claude/claude-opus-5-5" }, fallback: { reviewer: true }, reviewerId: next.agentId });
});

test("panel review can be off or on from the first round", async () => {
  const off = await underReview({ panelAfter: null, maxReviewRounds: 5 });
  for (let i = 0; i < 3; i++) await rework(off.x, off.rev, off.impl);
  expect((await off.x.job("a")).reviewRounds).toBe(4);
  expect(off.x.sent.at(-1)!.text).not.toContain("panel review");
  const always = await underReview({ panelAfter: 0, panelSize: 2 });
  expect(always.x.created[1].prompt).toContain("review round 1 of 3, a panel review");
  expect(always.x.created[1].prompt).toContain("2 independent reviewers at once");
});

test("projects saved before panels parse without panel keys and get the default panel", () => {
  const saved = automationSettingsSchema.parse({ enabled: true, maxRunning: 2, reviewer: luna, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 });
  expect(Object.keys(saved).filter((k) => k.startsWith("panel"))).toEqual([]);
  expect([1, 2, 3].map((round) => reviewersFor(saved, round))).toEqual([1, 1, 3]);
  expect(reviewPrompt(1, 3)).toContain("Lens for this round: the artifact");
});
