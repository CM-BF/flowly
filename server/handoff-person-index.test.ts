import { afterEach, expect, test, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AutomationJob } from "../shared/automation";
import { continuationPending, handoffSignal } from "../client/handoff-signal";
import { agentFixture } from "./agent-fixture";
import { HandoffService } from "./handoff-service";

// What the card face and the folded summary read (the board's handoff index) agrees with what the record says
// (SESSION-HANDOFF-SPEC §12, §21.15): the agent's own delivery note is not a review that arrived after its checkpoint,
// and a record the drawer finds missing or unreadable reaches the index even on a quiet card nobody writes to.
vi.mock("./provider-history", () => ({ historyBytes: async () => 0 }));
vi.mock("./handoff-git", () => ({ handoffGitDirectories: async () => ({ directories: [], unchecked: [] }), handoffGitSnapshot: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const at = () => new Date().toISOString();
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
const job = (extra: Partial<AutomationJob>): AutomationJob => ({ taskId: "t", projectId: "p", role: "implementer", state: "working", generation: 1, nudges: 0, failures: 0, reviewRounds: 1, queuedAt: at(), updatedAt: at(), ...extra });
async function setup(auto: boolean) {
  const x = await agentFixture(); roots.push(x.root);
  const h = new HandoffService(x.store); h.attach(x.paseo); x.service.handoffs = h;
  if (auto) await x.store.mutate((board) => { board.projects[0].automation = { enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 }; board.automation.push(job({ implementerId: "actor" })); });
  const index = async () => (await x.store.read()).handoffIndex.find((entry) => entry.taskId === "t")!;
  /** The agent writes its handoff, then delivers to In review (the turn checklist's order). */
  const deliver = async () => {
    const first = await x.service.get(x.identity);
    await x.service.updateHandoff(x.identity, { handoffRevision: first.handoff!.revision, operationId: "cp", state: "Implemented; all tests pass", set: [{ section: "next", text: "Review the diff" }] });
    expect((await h.context("t", undefined, { person: true })).fresh).toBe(true);
    await pause();
    const current = await x.service.get(x.identity);
    await x.service.write(x.identity, "status", { expectedRevision: current.revision, request: current.request, status: "in_review", note: "Delivered: all tests pass", outputs: [], nextMoves: [] });
    if (auto) await x.store.mutate((board) => { board.automation[0].state = "reviewing"; board.automation[0].reviewerId = "reviewer-1"; });
    await h.syncIndex("t");
  };
  return { ...x, h, index, deliver };
}

for (const auto of [false, true]) test(`delivering right after the handoff leaves it recorded, during the review and on a manual card (automation ${auto})`, async () => {
  const x = await setup(auto);
  await x.deliver();
  const record = await x.h.records.read("t", "p"), context = await x.h.context("t", undefined, { person: true }), board = await x.store.read();
  // The delivery note stays in the record for the next agent; it is not a review that arrived.
  expect(record.reviews.map((review) => [review.reviewerId, review.verdict])).toEqual([["actor", "incomplete"]]);
  expect(context).toMatchObject({ fresh: true, due: [] });
  expect(await x.index()).toMatchObject({ fresh: true, open: 0 });
  expect(handoffSignal(await x.index(), board.automation[0], board.tasks[0])?.tone).toBe("recorded");
});

test("a reviewer's verdict after the delivery is a change after the checkpoint: neutral on the approved card, a warning while the agent continues", async () => {
  const x = await setup(true);
  await x.deliver(); await pause();
  await x.h.prepareReview({ ...x.identity, agentId: "reviewer-1" }, "review-1", { verdict: "approve", summary: "Approved at HEAD." });
  await x.h.confirmSource("t", "review-1");
  await x.store.mutate((board) => { Object.assign(board.automation[0], { state: "delivered", verdict: "approved" }); });
  const context = await x.h.context("t", undefined, { person: true }), board = await x.store.read();
  expect(context).toMatchObject({ fresh: false, behind: "activity", due: ["A review arrived after the last checkpoint."], changes: ["A review arrived after the last checkpoint."] });
  expect(await x.index()).toMatchObject({ fresh: false, open: 0, behind: "activity" });
  expect(handoffSignal(await x.index(), board.automation[0], board.tasks[0])?.tone).toBe("settled");
  expect(handoffSignal(await x.index(), job({ state: "working", implementerId: "actor" }), { status: "development" })?.tone).toBe("check");
});

test("another session's delivery after the checkpoint is named as such, not as a review", async () => {
  const x = await setup(false);
  await x.deliver(); await pause();
  await x.h.prepareDelivery({ ...x.identity, agentId: "other-session" }, "delivery-2", "Delivered a follow-up fix");
  await x.h.confirmSource("t", "delivery-2");
  const context = await x.h.context("t", undefined, { person: true });
  expect(context).toMatchObject({ behind: "activity", due: ["Another session delivered after the last checkpoint."] });
});

for (const loss of ["missing", "unreadable"] as const) test(`the card face warns once the drawer finds a quiet card's record ${loss}`, async () => {
  const x = await setup(false);
  await x.h.update(x.identity, { handoffRevision: (await x.h.records.read("t", "p")).revision, state: "Ready for review", set: [{ section: "next", text: "Review the diff" }] });
  await pause(); await x.h.note({ taskId: "t", operationId: "n1", kind: "incident", text: "The staging database was restored." });
  await x.store.mutate((board) => { board.tasks[0].status = "done"; });
  expect(await x.index()).toMatchObject({ behind: "activity" });
  const file = join(x.h.records.root, "t.json");
  if (loss === "missing") await rm(file); else await writeFile(file, "{ not json");
  // What a person can do on the card refuses before any index sync.
  await expect(x.h.note({ taskId: "t", operationId: "n2", kind: "other", text: "a person adds a note" })).rejects.toThrow();
  const context = await x.h.context("t", undefined, { person: true }), board = await x.store.read();
  expect(context.unavailable).toBeTruthy();
  expect(await x.index()).toMatchObject({ fresh: false, behind: "unverified" });
  expect(continuationPending(undefined, board.tasks[0])).toBe(false);
  expect(handoffSignal(await x.index(), undefined, board.tasks[0])?.tone).toBe("check");
});

test("an index sync over an unreadable record records it as unverified instead of failing", async () => {
  const x = await setup(false);
  await x.h.update(x.identity, { handoffRevision: (await x.h.records.read("t", "p")).revision, state: "Ready for review", set: [{ section: "next", text: "Review the diff" }] });
  expect(await x.index()).toMatchObject({ fresh: true });
  await writeFile(join(x.h.records.root, "t.json"), "{ not json");
  await x.h.syncIndex("t");
  expect(await x.index()).toMatchObject({ fresh: false, behind: "unverified", staleSince: expect.any(String) });
});

test("a drawer read brings an older index entry up to date, and plugin start syncs entries written before `behind` existed", async () => {
  const x = await setup(false);
  await x.h.update(x.identity, { handoffRevision: (await x.h.records.read("t", "p")).revision, state: "Ready for review", set: [{ section: "next", text: "Review the diff" }] });
  await pause(); await x.h.note({ taskId: "t", operationId: "n1", kind: "incident", text: "The staging database was restored." });
  const legacy = async () => x.store.mutate((board) => { const entry = board.handoffIndex.find((item) => item.taskId === "t")!; delete entry.behind; entry.open = 3; });
  await legacy();
  await x.h.context("t", undefined, { person: true });
  expect(await x.index()).toMatchObject({ fresh: false, open: 0, behind: "activity" });
  // An agent's read leaves the index alone; plugin start syncs what no read reached.
  await legacy();
  await x.h.context("t", "actor", { recordAccess: false });
  expect((await x.index()).behind).toBeUndefined();
  await x.h.sweepBodies({ delayMs: 0, pauseMs: 0 });
  expect(await x.index()).toMatchObject({ open: 0, behind: "activity" });
});
