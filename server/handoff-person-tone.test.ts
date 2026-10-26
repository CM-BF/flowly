import { afterEach, expect, test, vi } from "vitest";
import { rm } from "node:fs/promises";
import type { AutomationJob } from "../shared/automation";
import { continuationPending, handoffSignal } from "../client/handoff-signal";
import { agentFixture } from "./agent-fixture";
import { HandoffService } from "./handoff-service";

vi.mock("./provider-history", () => ({ historyBytes: async () => 0 }));
vi.mock("./handoff-git", () => ({ handoffGitDirectories: async () => ({ directories: [], unchecked: [] }), handoffGitSnapshot: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const flowly = { by: { kind: "flowly" as const } };
const at = () => new Date().toISOString();
const job = (extra: Partial<AutomationJob>): AutomationJob => ({ taskId: "t", projectId: "p", role: "implementer", state: "delivered", generation: 1, nudges: 0, failures: 0, reviewRounds: 1, queuedAt: at(), updatedAt: at(), ...extra });
async function fixture(auto = false) {
  const x = await agentFixture(); roots.push(x.root);
  const h = new HandoffService(x.store); h.attach(x.paseo);
  if (auto) await x.store.mutate((board) => { board.projects[0].automation = { enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 }; });
  const index = async () => (await x.store.read()).handoffIndex.find((entry) => entry.taskId === "t")!;
  return { ...x, h, index };
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

test("an approved card whose successor never acknowledged reads as recorded to a person, on the card face and in the drawer alike", async () => {
  const x = await fixture(true);
  await x.store.mutate((board) => { board.tasks[0].status = "in_review"; });
  await x.h.records.setSession("t", "p", { agentId: "actor", n: 2, role: "implementer", provider: "codex", reason: "history", startedAt: at(), finalized: false, turns: [], background: [], live: [] }, flowly);
  await x.h.update(x.identity, { handoffRevision: 1, state: "Delivered and approved", set: [{ section: "next", text: "Nothing left" }] });
  await x.store.mutate((board) => { board.automation.push(job({ verdict: "approved", implementerId: "actor" })); });
  await x.h.syncIndex("t");
  const context = await x.h.context("t", undefined, { person: true }), index = await x.index(), board = await x.store.read();
  // The next agent still sees the missing acknowledgement as due.
  expect(context).toMatchObject({ fresh: false, ackRequired: true, behind: "ack", changes: [] });
  expect(context.due).toEqual(["The successor must read the full pending record, verify the workspace and acknowledge it."]);
  expect(index).toMatchObject({ fresh: false, open: 0, behind: "ack" });
  const pending = continuationPending(board.automation[0], board.tasks[0]);
  expect(pending).toBe(false); expect(handoffSignal(index, board.automation[0], board.tasks[0])?.tone).toBe("recorded");
  // While the successor works, the same record is a warning.
  expect(handoffSignal(index, job({ state: "working", implementerId: "actor" }), board.tasks[0])?.tone).toBe("check");
});

test("a manual card whose agent never wrote a handoff says so, instead of calling it a record behind later activity", async () => {
  const x = await fixture();
  await x.h.launch("t", "actor", { messageId: "m1", text: "Fix the login bug" });
  const brief = (await x.h.records.read("t", "p")).inputs[0];
  await x.h.markInput({ taskId: "t", id: brief.id, operationId: "done-1", handoffRevision: (await x.h.records.read("t", "p")).revision, status: "done" });
  await x.store.mutate((board) => { board.tasks[0].status = "done"; });
  await x.h.syncIndex("t");
  const context = await x.h.context("t", undefined, { person: true }), index = await x.index(), board = await x.store.read();
  expect(context).toMatchObject({ fresh: false, behind: "unwritten", changes: [] });
  expect(context.due).toEqual(["Write the current state and next step.", "There is no agent checkpoint yet."]);
  expect(index).toMatchObject({ fresh: false, open: 0, behind: "unwritten" });
  expect(handoffSignal(index, undefined, board.tasks[0])?.tone).toBe("unwritten");
});

test("only changes after an agent checkpoint make a neutral record behind later activity; a check that could not be made stays a warning", async () => {
  const x = await fixture();
  await x.h.update(x.identity, { handoffRevision: (await x.h.records.read("t", "p")).revision, state: "Ready for review", set: [{ section: "next", text: "Review the diff" }] });
  await pause(); await x.h.note({ taskId: "t", operationId: "n1", kind: "incident", text: "The staging database was restored from last night's backup." });
  const changed = await x.h.context("t", undefined, { person: true });
  expect(changed).toMatchObject({ behind: "activity", changes: ["New incident or hazard information needs to be checked."] });
  expect(await x.index()).toMatchObject({ behind: "activity", open: 0 });
  // An unverifiable repository state is not a change after the checkpoint.
  await x.h.records.capture("t", "p", { git: [{ repo: "/repo", sha: null, dirty: false, at: at(), error: "git is unavailable" }] }, flowly);
  await x.h.syncIndex("t");
  const unverified = await x.h.context("t", undefined, { person: true });
  expect(unverified.behind).toBe("unverified"); expect(unverified.due).toContain("Some repository state could not be verified.");
  expect(unverified.changes).toEqual(["New incident or hazard information needs to be checked.", "Repository state changed after the checkpoint."]);
  expect(handoffSignal(await x.index(), undefined, { status: "done" })?.tone).toBe("check");
  // The agent-facing context carries no person-only fields.
  const agent = await x.h.context("t", "actor", { recordAccess: false });
  expect(agent).not.toHaveProperty("behind"); expect(agent).not.toHaveProperty("changes");
});
