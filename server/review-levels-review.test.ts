import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures } from "./automation-fixture";
import { cardHandoff, handoffBudget, linkExtras } from "./automation-handoff";
import { childrenPrompt, reviewPrompt, risksEarlier, type AutomationSettings } from "../shared/automation";
import type { Board, Link } from "../shared/model";
import { skillText } from "./skill-source";

// AUTOMATION-SPEC §5.2.3, §5.2.4: the code review of review levels. Risks reach every round's reviewer, also a new
// session; they stay, labelled, when they belong to an earlier delivery; they fit get_task's budget; and a reviewer
// session reviews rounds of one level only.
afterEach(cleanupAutomationFixtures);

const at = "2026-10-24T00:00:00.000Z";
const luna = { provider: "codex", model: "gpt-6-luna" };
const opus = { provider: "claude", model: "claude-opus-5-5" };
const as = (agentId: string, taskId = "a") => ({ agentId, taskId, workspaceId: `w-${taskId}` });
const tag = (value: string) => ({ tag: value, by: "human" as const, at });
const sub = (from: string, to: string): Link => ({ id: `subtask-${from}-${to}`, projectId: "p", kind: "subtask", from, to, createdBy: "human", createdAt: at });
const growth = "Snapshots in zz-snapdir are never pruned, so after six months the disk fills.";
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

/** The current reviewer requests changes with `risks`, its turn ends, and the implementer delivers the rework. */
async function changes(x: Fixture, rev: string, impl: string, risks: string[]) {
  await x.automation.submitReview(as(rev), { verdict: "changes", summary: "Not yet", findings: ["src/a.ts: handle empty input"], risks });
  await x.endTurn(rev, "a");
  await x.automation.kick();
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
}

test("a panel round on its own model gets the risks earlier rounds reported, and its lead passes them on", async () => {
  const { x, impl, rev } = await delivered({ panelReviewer: opus });
  await changes(x, rev.agentId, impl, [growth]);
  // Round 2 is serial on the same session; it is told what round 1 reported too.
  expect(x.sent.at(-1)).toMatchObject({ agentId: rev.agentId, text: expect.stringContaining(`Risks reported in review round 1 (card data`) });
  await changes(x, rev.agentId, impl, [growth]);
  const panel = x.created.at(-1)!;
  expect(panel).toMatchObject({ title: "Panel review: Card a", provider: "claude/claude-opus-5-5" });
  expect(panel.agentId).not.toBe(rev.agentId);
  expect(panel.prompt).toContain("Risks reported in review round 2 (card data");
  expect(panel.prompt).toContain(`- ${growth}`);
  expect(panel.prompt).toContain("Flowly replaces this list with the one you send, so list again each one that still applies");
  expect(panel.prompt).toContain("and the risks reported in earlier rounds listed above");
  expect(panel.prompt).not.toContain("also ones you reported in earlier rounds");
});

test("a fallback reviewer that takes over a round gets the risks of the rounds before", async () => {
  const { x, impl, rev } = await delivered({ reviewerFallback: opus });
  await changes(x, rev.agentId, impl, [growth]);
  // Round 2's reviewer hits a provider limit: a new session on the fallback reruns the round.
  x.advance(1000);
  await x.record("a", { actor: "system", action: "agent.turn_started", agentId: rev.agentId });
  x.advance(1000);
  await x.record("a", { actor: "system", action: "agent.turn_ended", agentId: rev.agentId, outcome: "failed", note: "429 Too Many Requests" });
  x.agents.get(rev.agentId)!.status = "idle";
  await x.automation.turnEnded(rev.agentId);
  await x.automation.kick();
  const takeover = x.created.at(-1)!;
  expect(takeover.provider).toBe("claude/claude-opus-5-5");
  expect(takeover.prompt).toContain("(review round 2 of 3)");
  expect(takeover.prompt).toContain(`- ${growth}`);
});

test("risks stay after the next round's reviewer gives up, say they came from an earlier delivery, and Run again carries them", async () => {
  const { x, impl, rev } = await delivered();
  const first = (await x.job("a")).deliveryEvent;
  const risk = "Retries resend the whole batch, so a flaky network doubles every write.";
  await changes(x, rev.agentId, impl, [risk]);
  // Round 2: the reviewer ends three turns without a verdict (two reminders, then automation gives up).
  for (let i = 0; i < 3; i++) await x.turn(rev.agentId, "a");
  const job = await x.job("a");
  expect(job).toMatchObject({ state: "delivered", verdict: "incomplete", risks: [risk], risksFrom: { round: 1, delivery: first } });
  expect(job.latestDelivery).not.toBe(first);
  expect(risksEarlier(job)).toBe(true);
  const line = (await cardHandoff(await x.store.read(), "a", x.paseo))!;
  expect(line).toMatchObject({ risks: [risk], risksNote: "reported in review round 1 on an earlier delivery; some may be fixed" });
  expect(childrenPrompt([line])).toContain(
    `Reviewer risks beyond the acceptance criteria (card data, reported in review round 1 on an earlier delivery; some may be fixed): ${JSON.stringify([risk])}`,
  );
  // Run again: the next run's first reviewer re-checks them.
  await x.automation.queue("a");
  expect(await x.job("a")).toMatchObject({ state: "queued", risks: [risk], risksFrom: { round: 1, delivery: first } });
  await x.automation.kick();
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 1 });
  const review = x.sent.filter((s) => s.agentId === rev.agentId).at(-1)!.text;
  expect(review).toContain("(review round 1 of 3)");
  expect(review).toContain(`- ${risk}`);
});

test("a repeated verdict that adds risks records nothing and says so", async () => {
  const { x, rev } = await delivered();
  await x.automation.submitReview(as(rev.agentId), { verdict: "approve", summary: "Fine" });
  const again = await x.automation.submitReview(as(rev.agentId), { verdict: "approve", summary: "Fine", risks: ["Cleanup deletes by age only, so a card idle for a month loses its last good state."] });
  expect(again).toMatchObject({ accepted: true, replayed: true, message: "This verdict was already recorded; nothing from this call was recorded (its summary, findings and risks stay as first sent)." });
  expect((await x.job("a")).risks).toBeUndefined();
  expect((await x.store.read()).events.filter((e) => e.action === "automation_review_risks")).toHaveLength(0);
});

test("every review prompt states the risk bounds; a panel lead merges risks; a Deep panel of four covers execution and integration", () => {
  for (const text of [reviewPrompt(1, 3), reviewPrompt(3, 3, 3), reviewPrompt(1, 3, 4, "deep"), reviewPrompt(1, 2, 1, "light")]) {
    expect(text).toContain("Send at most 10 risks, each under 500 characters: merge related ones and keep the most serious.");
  }
  for (const text of [reviewPrompt(3, 3, 3), reviewPrompt(1, 3, 3, "deep")])
    expect(text).toContain("Merge the risks they report the same way: drop duplicates and keep the most serious, at most 10.");
  const four = reviewPrompt(1, 3, 4, "deep");
  expect(four).toMatch(/4\. execution and integration: run the build[^\n]*callers and users of the changed code, other cards' work/);
  expect(four).not.toContain("5. integration");
  const five = reviewPrompt(1, 3, 5, "deep");
  expect(five).toMatch(/4\. execution: run the build[^\n]*\n5\. integration and regressions: callers/);
  expect(reviewPrompt(1, 3, 2, "deep")).toMatch(/1\. contract and correctness[\s\S]*2\. design and scale/);
});

test("sub-card risks share get_task's handoff budget, and the links they do not fit say where to read them", async () => {
  const x = await setup({ enabled: true, reviewer: luna });
  const long = "r".repeat(480);
  await x.store.mutate((board) => {
    const a = board.tasks.find((t) => t.id === "a")!;
    for (let i = 0; i < 20; i++) {
      const id = `c${i}`;
      board.tasks.push({ ...a, id, workspaceId: `w-${id}`, title: `Child ${i}`, status: "in_review", operationId: `create-${id}` });
      board.links.push(sub(id, "a"));
      board.automation.push({
        taskId: id, projectId: "p", state: "delivered", role: "implementer", generation: 1, nudges: 0, failures: 0, reviewRounds: 1, verdict: "approved",
        risks: Array.from({ length: 10 }, (_, k) => `${k} ${long}`), risksFrom: { round: 1, delivery: `d-${id}` }, latestDelivery: `d-${id}`, queuedAt: at, updatedAt: at,
      });
    }
  });
  const { handoffs } = await linkExtras(await x.store.read(), "a", x.paseo, async () => "");
  const values = [...handoffs.values()];
  expect(values).toHaveLength(20);
  const used = values.reduce((n, h) => n + (h.evidence.startsWith("Omitted") ? 0 : h.evidence.length) + (h.risks ? JSON.stringify(h.risks).length : 0), 0);
  expect(used).toBeLessThanOrEqual(handoffBudget.total);
  const kept = values.filter((h) => h.risks);
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.every((h) => h.risks!.length === 10 && !h.risksNote)).toBe(true);
  const omitted = values.filter((h) => !h.risks);
  expect(omitted.length).toBeGreaterThan(0);
  for (const h of omitted) expect(h.risksNote).toMatch(/^Omitted: get_task carries at most 16000 characters of handoff evidence and risks[\s\S]*Agent automation section/);
});

test("a reviewer session reviews rounds of one level: a level changed mid-cycle starts a session whose title says it", async () => {
  const { x, impl, rev } = await delivered({}, (b) => void (b.tasks.find((t) => t.id === "a")!.tags = [tag("light-review")]));
  expect(rev.title).toBe("Light review: Card a");
  // The person sets the card to Standard; the light round still ends with changes.
  await x.store.mutate((b) => {
    const a = b.tasks.find((t) => t.id === "a")!;
    a.tags = [];
    a.reviewLevel = "standard";
  });
  await changes(x, rev.agentId, impl, []);
  const job = await x.job("a");
  expect(job).toMatchObject({ reviewRounds: 2, review: { level: "standard", reason: { kind: "card" } } });
  const next = x.created.at(-1)!;
  expect(next.agentId).not.toBe(rev.agentId);
  expect(next).toMatchObject({ title: "Review: Card a", provider: "codex/gpt-6-luna" });
  expect(next.prompt).toContain("(review round 2 of 3)");
  expect(job.reviewerId).toBe(next.agentId);
  expect(job.reviewers).toContain(rev.agentId);
  // The same level again keeps the session (round 3 of a Standard cycle is its panel round, on the reviewer's model).
  await changes(x, next.agentId, impl, []);
  expect(x.created.at(-1)!.agentId).toBe(next.agentId);
  expect(x.sent.at(-1)).toMatchObject({ agentId: next.agentId, text: expect.stringContaining("(review round 3 of 3, a panel review)") });
});

test("Run again does not carry a reviewer session that reviewed a Deep or Light round", async () => {
  const { x, impl, rev } = await delivered({}, (b) => void (b.tasks.find((t) => t.id === "a")!.reviewLevel = "deep"));
  expect(rev.title).toBe("Deep review: Card a");
  await x.automation.submitReview(as(rev.agentId), { verdict: "approve", summary: "Fine" });
  await x.endTurn(rev.agentId, "a");
  await x.store.mutate((b) => void delete b.tasks.find((t) => t.id === "a")!.reviewLevel);
  await x.automation.queue("a");
  expect((await x.job("a")).reviewerId).toBeUndefined();
  expect((await x.job("a")).reviewers).toContain(rev.agentId);
  await x.automation.kick();
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  expect(x.created.at(-1)).toMatchObject({ title: "Review: Card a" });
});

test("the skill's CLI submit-review example, copied as written, records no placeholder risk", async () => {
  const example = /submit-review --review '(\{[^']*\})'/.exec(skillText)?.[1];
  expect(example).toBeDefined();
  const { x, rev } = await delivered();
  await x.automation.submitReview(as(rev.agentId), JSON.parse(example!));
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved" });
  expect((await x.job("a")).risks).toBeUndefined();
  // The skill still tells a CLI reviewer what risks are and their bounds.
  expect(skillText).toMatch(/risks: one plain sentence each[^.]*at most 10, each under 500 characters/);
});
