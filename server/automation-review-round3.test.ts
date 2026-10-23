import { afterEach, expect, test, vi } from "vitest";
import { cleanupAutomationFixtures, underReview } from "./automation-fixture";

// AUTOMATION-SPEC §4.2, §5: a casual implementer turn during a review neither refuses the reviewer's verdict on
// the delivery it is checking nor makes it review that delivery again.
afterEach(cleanupAutomationFixtures);

const as = (agentId: string) => ({ agentId, taskId: "a", workspaceId: "w-a" });
type Fixture = Awaited<ReturnType<typeof underReview>>["x"];
const toReviewer = (x: Fixture, rev: string) => x.sent.filter((s) => s.agentId === rev).map((s) => s.text);

test("an approval given during a casual implementer turn counts, and the reviewer is not asked to review again", async () => {
  const { x, impl, rev } = await underReview();
  await x.startTurn(impl, "a");
  await expect(x.automation.submitReview(as(rev), { verdict: "approve", summary: "Checked" })).resolves.toMatchObject({ accepted: true, verdict: "approve" });
  await x.endTurn(rev, "a");
  await x.endTurn(impl, "a");
  await x.automation.kick();
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved", reviewRounds: 1 });
  expect((await x.task("a")).status).toBe("in_review");
  expect(toReviewer(x, rev)).toEqual([]);
  // A repeated call after a lost response is acknowledged.
  await expect(x.automation.submitReview(as(rev), { verdict: "approve", summary: "Checked" })).resolves.toMatchObject({ replayed: true });
});

test("requested changes given during a casual implementer turn reach the implementer after it, and the rework is the next round", async () => {
  const { x, impl, rev } = await underReview();
  await x.startTurn(impl, "a");
  await expect(x.automation.submitReview(as(rev), { verdict: "changes", summary: "Tests missing", findings: ["no test"] })).resolves.toMatchObject({ accepted: true });
  await x.endTurn(rev, "a");
  await x.endTurn(impl, "a");
  await vi.waitFor(() => expect(x.sent.at(-1)).toMatchObject({ agentId: impl, text: expect.stringMatching(/requested changes \(review round 1 of 3\)[\s\S]*no test/) }));
  expect(await x.job("a")).toMatchObject({ state: "working", role: "implementer", verdict: "changes" });
  await x.startTurn(impl, "a");
  await x.deliver(impl, "a");
  await x.endTurn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 2 });
  await vi.waitFor(() => expect(toReviewer(x, rev).at(-1)).toMatch(/review round 2 of 3/));
  expect(toReviewer(x, rev).filter((text) => /review round 1 of/.test(text))).toEqual([]);
});

test("a reviewer that ended its turn without a verdict during a casual implementer turn is reminded, not sent the round again", async () => {
  const { x, impl, rev } = await underReview();
  await x.startTurn(impl, "a");
  await x.endTurn(rev, "a");
  await x.endTurn(impl, "a");
  await vi.waitFor(() => expect(toReviewer(x, rev)).toEqual([expect.stringMatching(/Your review ended without a verdict \(reminder 1 of 2\)/)]));
  expect(await x.job("a")).toMatchObject({ state: "reviewing", role: "reviewer", reviewRounds: 1, nudges: 1 });
});

test("a round prompt held back while the implementer was busy goes out once after its casual turn, with its own round number", async () => {
  const { x, impl, rev } = await underReview();
  await x.automation.submitReview(as(rev), { verdict: "changes", summary: "Tests missing" });
  await x.endTurn(rev, "a");
  await vi.waitFor(() => expect(x.sent.at(-1)).toMatchObject({ agentId: impl, text: expect.stringMatching(/requested changes/) }));
  await x.startTurn(impl, "a");
  await x.deliver(impl, "a");
  // The rework is delivered, but the person writes to the implementer before its turn has fully ended: round 2 waits.
  await x.endTurn(impl, "a", "completed", { idle: false });
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 2 });
  await x.automation.kick();
  expect(toReviewer(x, rev)).toEqual([]);
  await x.startTurn(impl, "a");
  await x.endTurn(impl, "a");
  await vi.waitFor(() => expect(toReviewer(x, rev)).toEqual([expect.stringMatching(/review round 2 of 3/)]));
  expect(await x.job("a")).toMatchObject({ state: "reviewing", role: "reviewer", reviewRounds: 2 });
});

test("a verdict on the old delivery is refused once the casual turn delivered new work, and the new work is reviewed", async () => {
  const { x, impl, rev } = await underReview();
  await x.startTurn(impl, "a");
  await x.deliver(impl, "a");
  await expect(x.automation.submitReview(as(rev), { verdict: "approve", summary: "Checked" })).rejects.toMatchObject({ code: "REVIEW_CLOSED" });
  await x.endTurn(rev, "a");
  await x.endTurn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", role: "reviewer", reviewRounds: 1 });
  expect((await x.job("a")).verdict).toBeUndefined();
  await vi.waitFor(() => expect(toReviewer(x, rev)).toEqual([expect.stringMatching(/review round 1 of 3/)]));
});
