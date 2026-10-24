import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures } from "./automation-fixture";
import { linkExtras } from "./automation-handoff";
import { designQuestions, type AutomationSettings } from "../shared/automation";
import type { Board, Link } from "../shared/model";

// AUTOMATION-SPEC §5.2: the reviewer's strength, number and angles match the card's difficulty, and every reviewer
// reports risks the acceptance criteria do not cover.
afterEach(cleanupAutomationFixtures);

const at = "2026-10-24T00:00:00.000Z";
const luna = { provider: "codex", model: "gpt-6-luna" };
const opus = { provider: "claude", model: "claude-opus-5-5" };
const sol = { provider: "codex", model: "gpt-6.1-sol" };
const as = (agentId: string, taskId = "a") => ({ agentId, taskId, workspaceId: `w-${taskId}` });
const tag = (value: string) => ({ tag: value, by: "human" as const, at });
const sub = (from: string, to: string): Link => ({ id: `subtask-${from}-${to}`, projectId: "p", kind: "subtask", from, to, createdBy: "human", createdAt: at });
type Fixture = Awaited<ReturnType<typeof setup>>;

/** Card a (after `edit`) runs under automation with a codex reviewer and delivers once: review round 1 starts. */
async function delivered(settings: Partial<AutomationSettings> = {}, edit?: (board: Board) => void) {
  const x = await setup({ enabled: true, reviewer: luna, ...settings });
  if (edit) await x.store.mutate(edit);
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0].agentId;
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 1 });
  return { x, impl, rev: x.created[1] };
}
const cardA = (board: Board) => board.tasks.find((t) => t.id === "a")!;

/** The current reviewer asks for changes, its turn ends, and the implementer delivers the rework. */
async function rework(x: Fixture, rev: string, impl: string) {
  await x.automation.submitReview(as(rev), { verdict: "changes", summary: "Not yet", findings: ["src/a.ts: handle empty input"] });
  await x.endTurn(rev, "a");
  await x.automation.kick();
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
}
const notes = async (x: Fixture, action = "automation_review_started") => (await x.store.read()).events.filter((e) => e.action === action).map((e) => e.note);

test("a Standard card is reviewed as before: same session, rounds, lens and notes, plus the request for risks; the job keeps the plan", async () => {
  const { x, rev } = await delivered();
  expect(rev).toMatchObject({ provider: "codex/gpt-6-luna", title: "Review: Card a" });
  expect(rev.prompt).toContain("(review round 1 of 3)");
  expect(rev.prompt).toContain("Lens for this round: the artifact");
  expect(rev.prompt).not.toContain("Review level:");
  expect(rev.prompt).toContain("Report the risks they do not cover in risks");
  expect(rev.prompt).toContain("Risks never block approval");
  expect(await x.job("a")).toMatchObject({ review: { level: "standard", reason: { kind: "default" }, max: 3, size: 1 } });
  expect((await x.job("a")).seat).toBeUndefined();
  expect(await notes(x)).toEqual(["Review round 1 of 3"]);
});

test("Light never panels, runs on its own model and stops after its own cap", async () => {
  const { x, impl, rev } = await delivered({ panelAfter: 0, levels: { light: { reviewer: sol } } }, (b) => void (cardA(b).tags = [tag("light-review")]));
  expect(rev).toMatchObject({ provider: "codex/gpt-6.1-sol", title: "Light review: Card a" });
  expect(rev.prompt).toContain("(light review round 1 of 2)");
  expect(rev.prompt).not.toContain("panel review");
  expect(await x.job("a")).toMatchObject({ seat: "light", review: { level: "light", reason: { kind: "light_tag" }, max: 2, size: 1 } });
  await rework(x, rev.agentId, impl);
  expect(x.sent.find((s) => s.agentId === impl)!.text).toContain("The reviewer requested changes (light review round 1 of 2):");
  expect(x.created).toHaveLength(2);
  expect(x.sent.at(-1)).toMatchObject({ agentId: rev.agentId, text: expect.stringContaining("(light review round 2 of 2)") });
  await rework(x, rev.agentId, impl);
  expect(await x.job("a")).toMatchObject({ state: "delivered", code: "review_rounds", verdict: "changes" });
  expect((await notes(x, "automation_delivered")).at(-1)).toBe("Review rounds used up (2); the card waits for you");
  expect(await notes(x)).toEqual([
    "Light review round 1 of 2; level light: the card has the tag light-review",
    "Light review round 2 of 2; level light: the card has the tag light-review",
  ]);
});

test("Deep is a panel from round 1 on its model, with the fixed angles in order and the six design questions, up to its own cap", async () => {
  const { x, impl, rev: panel } = await delivered(
    { panelReviewer: opus, levels: { deep: { panelSize: 4, maxReviewRounds: 2 } } },
    (b) => void (cardA(b).description = "Keep the board in a SQLite database."),
  );
  expect(panel).toMatchObject({ provider: "claude/claude-opus-5-5", modeId: "bypassPermissions", title: "Deep review: Card a", labels: { "flowly-automation": "reviewer" } });
  expect(panel.prompt).toContain("(deep review round 1 of 2, a panel review)");
  expect(panel.prompt).toContain('Review level: deep, because its description mentions "database"');
  expect(panel.prompt).toContain("every round, this one included, checks the delivery with 4 independent reviewers at once");
  expect(panel.prompt).toMatch(/1\. contract and correctness[\s\S]*2\. design and scale[\s\S]*3\. failure, data safety and security[\s\S]*4\. execution/);
  expect(panel.prompt).not.toContain("5. integration");
  for (const question of designQuestions) expect(panel.prompt).toContain(question);
  expect(panel.prompt).not.toContain("Earlier rounds of this cycle requested changes");
  expect(await x.job("a")).toMatchObject({ panel: true, review: { level: "deep", reason: { kind: "keyword", keyword: "database", field: "description" }, max: 2, size: 4 } });
  expect(await notes(x)).toEqual(['Deep review round 1 of 2 (panel of 4 reviewers); level deep: its description mentions "database"']);
  await rework(x, panel.agentId, impl);
  expect(x.sent.find((s) => s.agentId === impl)!.text).toContain("The review panel (4 reviewers) requested changes (deep review round 1 of 2):");
  // The same panel session reviews the next round, again as a panel.
  expect(x.created).toHaveLength(2);
  expect(x.sent.at(-1)).toMatchObject({ agentId: panel.agentId, text: expect.stringContaining("(deep review round 2 of 2, a panel review)") });
  await rework(x, panel.agentId, impl);
  expect(await x.job("a")).toMatchObject({ state: "delivered", code: "review_rounds" });
  expect((await notes(x, "automation_delivered")).at(-1)).toBe("Review rounds used up (2); the card waits for you");
});

test("Deep defaults to the reviewer in panels of 3 when no panel model is set, and to its own model when one is", async () => {
  const plain = await delivered({}, (b) => void (cardA(b).reviewLevel = "deep"));
  expect(plain.rev).toMatchObject({ provider: "codex/gpt-6-luna", title: "Deep review: Card a" });
  expect(plain.rev.prompt).toContain("3 independent reviewers at once");
  expect(plain.rev.prompt).toContain("Review level: deep, because set on the card");
  const own = await delivered({ panelReviewer: opus, levels: { deep: { panelReviewer: sol, panelSize: 2 } } }, (b) => void (cardA(b).reviewLevel = "deep"));
  expect(own.rev).toMatchObject({ provider: "codex/gpt-6.1-sol", title: "Deep review: Card a" });
  expect(own.rev.prompt).toContain("2 independent reviewers at once");
  expect(await own.x.job("a")).toMatchObject({ seat: "deep" });
});

test("a foundation tag on an ancestor makes the sub-card Deep, and the job and activity say why", async () => {
  const { x, rev } = await delivered({}, (b) => {
    b.links.push(sub("a", "b"));
    b.tasks.find((t) => t.id === "b")!.tags = [tag("foundation")];
  });
  expect(rev.prompt).toContain('Review level: deep, because its ancestor card "Card b" has the tag foundation');
  expect((await x.job("a")).review).toEqual({ level: "deep", reason: { kind: "ancestor_tag", tag: "foundation", cardId: "b", title: "Card b" }, max: 3, size: 3 });
  expect(await notes(x)).toEqual(['Deep review round 1 of 3 (panel of 3 reviewers); level deep: its ancestor card "Card b" has the tag foundation']);
});

test("a level changed during a cycle applies from the next round; a resend within the round keeps the round's plan", async () => {
  const { x, impl, rev } = await delivered({ reviewerFallback: opus, levels: { light: { reviewer: sol } } }, (b) => void (cardA(b).reviewLevel = "light"));
  expect(rev.provider).toBe("codex/gpt-6.1-sol");
  const task = (await x.store.read()).tasks.find((t) => t.id === "a")!;
  await x.store.editTask({ id: "a", revision: task.revision, reviewLevel: "deep", actor: "human" });
  expect((await notes(x, "review_level_set")).at(-1)).toBe("Review level: Deep");
  // The reviewer of the light round hits a provider limit: its takeover reruns that same light round.
  x.advance(1000);
  await x.record("a", { actor: "system", action: "agent.turn_started", agentId: rev.agentId });
  x.advance(1000);
  await x.record("a", { actor: "system", action: "agent.turn_ended", agentId: rev.agentId, outcome: "failed", note: "429 Too Many Requests" });
  x.agents.get(rev.agentId)!.status = "idle";
  await x.automation.turnEnded(rev.agentId);
  await x.automation.kick();
  const takeover = x.created[2];
  expect(takeover.provider).toBe("claude/claude-opus-5-5");
  expect(takeover.prompt).toContain("(light review round 1 of 2)");
  // Its changes end the round; the rework's review is the Deep round 2, on the reviewer's model, as a panel.
  await rework(x, takeover.agentId, impl);
  expect(await x.job("a")).toMatchObject({ reviewRounds: 2, review: { level: "deep", reason: { kind: "card" }, max: 3, size: 3 } });
  const deep = x.created.at(-1)!;
  expect(deep).toMatchObject({ provider: "codex/gpt-6-luna", title: "Deep review: Card a" });
  expect(deep.prompt).toContain("(deep review round 2 of 3, a panel review)");
  expect((await x.job("a")).seat).toBeUndefined();
});

test("risks are validated, kept with the latest verdict, recorded in the activity and passed on as information", async () => {
  const { x, impl, rev } = await delivered();
  const reviewer = rev.agentId;
  for (const risks of [Array.from({ length: 11 }, (_, i) => `Risk ${i}`), ["x".repeat(501)], ["   "]])
    await expect(x.automation.submitReview(as(reviewer), { verdict: "approve", summary: "Fine", risks })).rejects.toThrow();
  expect(await x.job("a")).toMatchObject({ state: "reviewing" });
  expect((await x.job("a")).risks).toBeUndefined();
  const growth = "Every change appends the whole state to the journal and nothing is removed, so after a few thousand edits it reaches gigabytes.";
  await x.automation.submitReview(as(reviewer), { verdict: "changes", summary: "One problem", findings: ["src/a.ts: handle empty input"], risks: [growth] });
  expect((await x.job("a")).risks).toEqual([growth]);
  const events = (await x.store.read()).events.filter((e) => e.action.startsWith("automation_"));
  expect(events.slice(-2).map((e) => [e.action, e.note])).toEqual([
    ["automation_changes_requested", "One problem\n- src/a.ts: handle empty input"],
    ["automation_review_risks", `Risks beyond the acceptance criteria (1):\n- ${growth}`],
  ]);
  await x.endTurn(reviewer, "a");
  await x.automation.kick();
  const changes = x.sent.filter((s) => s.agentId === impl).at(-1)!.text;
  expect(changes).toMatch(/Risks the reviewer noted beyond the acceptance criteria \(information, not required changes[\s\S]*- Every change appends/);
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  // The next verdict replaces the list; repeating it changes nothing.
  const later = ["Cleanup removes snapshots by age only, so a card that has not run in a month loses its last good state."];
  await x.automation.submitReview(as(reviewer), { verdict: "approve", summary: "Fixed", risks: later });
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved", risks: later });
  expect(await x.automation.submitReview(as(reviewer), { verdict: "approve", summary: "Fixed" })).toMatchObject({ replayed: true });
  expect((await x.job("a")).risks).toEqual(later);
});

test("a verdict without risks clears the earlier list and records no risk event", async () => {
  const { x, impl, rev } = await delivered();
  await x.automation.submitReview(as(rev.agentId), { verdict: "changes", summary: "One problem", findings: ["a.ts: x"], risks: ["The cache never expires."] });
  await x.endTurn(rev.agentId, "a");
  await x.automation.kick();
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  await x.automation.submitReview(as(rev.agentId), { verdict: "approve", summary: "Fixed" });
  expect((await x.job("a")).risks).toBeUndefined();
  expect(await notes(x, "automation_review_risks")).toHaveLength(1);
});

test("the parent's wake-up message and its get_task handoff carry a sub-card's reviewer risks", async () => {
  const x = await setup({ enabled: true, reviewer: luna });
  await x.store.mutate((board) => void board.links.push(sub("b", "a")));
  await x.automation.queue("a");
  await x.automation.kick();
  const parent = x.created[0].agentId;
  await x.automation.queue("b");
  await x.automation.kick();
  await x.turn(parent, "a");
  expect(await x.job("a")).toMatchObject({ state: "waiting" });
  const child = x.created.find((c) => c.workspaceId === "w-b")!.agentId;
  await x.deliver(child, "b");
  await x.turn(child, "b");
  const reviewer = x.created.find((c) => c.workspaceId === "w-b" && c.labels["flowly-automation"] === "reviewer")!.agentId;
  const risk = "Retries resend the whole batch, so a flaky network doubles every write.";
  await x.automation.submitReview(as(reviewer, "b"), { verdict: "approve", summary: "Works", risks: [risk] });
  await x.endTurn(reviewer, "b");
  await x.automation.kick();
  const wake = x.sent.filter((s) => s.agentId === parent).at(-1)!.text;
  expect(wake).toContain(`Reviewer risks beyond the acceptance criteria (card data): ${JSON.stringify([risk])}`);
  expect(wake).toContain("Weigh its reviewer's risks first");
  const { handoffs } = await linkExtras(await x.store.read(), "a", x.paseo, async () => "");
  expect(handoffs.get("b")?.risks).toEqual([risk]);
});
