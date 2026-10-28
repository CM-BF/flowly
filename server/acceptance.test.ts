import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { AcceptanceService, authorPrompt } from "./acceptance";
import { automationFixture, cleanupAutomationFixtures } from "./automation-fixture";
import { acceptanceDecision, reviewPrompt, startPrompt, acceptanceImplementerNote, acceptanceReviewerNote } from "../shared/automation";
import { automationSettingsSchema, reviewInputSchema } from "../shared/automation-schema";
import { emptyBoard, type Board } from "../shared/model";

// Acceptance-test review (AUTOMATION-SPEC §5.4). Fake SDK and temp directories only: nothing reaches a daemon.
const dirs: string[] = [];
afterEach(async () => {
  await cleanupAutomationFixtures();
  // Ready suites are read-only by design; make them writable before removing the temp folders.
  const { execFileSync } = await import("node:child_process");
  await Promise.all(dirs.splice(0).map((d) => { execFileSync("chmod", ["-R", "u+w", d]); return rm(d, { recursive: true, force: true }); }));
});
const temp = async () => { const d = await mkdtemp(join(tmpdir(), "flowly-acceptance-")); dirs.push(d); return d; };
const exists = (p: string) => stat(p).then(() => true, () => false);
const at = "2026-10-27T10:00:00.000Z";

test("the revert rule: more failures or fewer passes regress; a change request without fewer failures does not improve", () => {
  expect(acceptanceDecision(undefined, { passed: 1, failed: 5 }, "changes")).toBe("keep");
  expect(acceptanceDecision({ passed: 5, failed: 3 }, undefined, "changes")).toBe("keep");
  expect(acceptanceDecision({ passed: 5, failed: 3 }, { passed: 6, failed: 2 }, "changes")).toBe("keep");
  expect(acceptanceDecision({ passed: 5, failed: 3 }, { passed: 5, failed: 3 }, "changes")).toBe("revert");
  expect(acceptanceDecision({ passed: 5, failed: 3 }, { passed: 4, failed: 2 }, "changes")).toBe("revert");
  expect(acceptanceDecision({ passed: 5, failed: 3 }, { passed: 8, failed: 0 }, "approve")).toBe("keep");
  expect(acceptanceDecision({ passed: 8, failed: 0 }, { passed: 8, failed: 0 }, "approve")).toBe("keep");
  expect(acceptanceDecision({ passed: 8, failed: 0 }, { passed: 7, failed: 1 }, "approve")).toBe("revert");
});

test("prompts carry the acceptance rules only in acceptance projects; settings and verdicts accept the new fields", () => {
  expect(startPrompt({ review: true, again: false, acceptance: true })).toContain(acceptanceImplementerNote);
  expect(startPrompt({ review: true, again: false })).not.toContain("independent acceptance tests");
  for (const text of [reviewPrompt(1, 3, 1, "standard", { acceptance: true }), reviewPrompt(2, 3, 3, "deep", { acceptance: true })]) {
    expect(text).toContain(acceptanceReviewerNote);
    expect(text).toContain("verdict=changes only for a failing acceptance check");
    expect(text).toContain("never ask anyone to change the tests");
    expect(text).toContain("Never put the holdout suite's path, file names or contents in your summary or findings");
  }
  expect(reviewPrompt(1, 3)).not.toContain("Acceptance tests (§5.4)");
  expect(acceptanceImplementerNote).toContain("never edit, copy or game them");
  expect(automationSettingsSchema.parse({ enabled: true, acceptance: {} }).acceptance).toEqual({});
  expect(automationSettingsSchema.parse({ enabled: true })).not.toHaveProperty("acceptance");
  expect(reviewInputSchema.parse({ verdict: "approve", summary: "ok", acceptance: { visible: { passed: 3, failed: 0 }, holdout: { passed: 2, failed: 0 } } }).acceptance?.holdout.passed).toBe(2);
});

function board(): Board {
  const b = emptyBoard();
  b.projects.push({ id: "p", paseoProjectId: "native", title: "P", description: "", primaryPath: "/repo", repos: ["/repo"], revision: 1, createdAt: at, updatedAt: at, archivedAt: null,
    automation: { enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2, reviewer: { provider: "codex", model: "gpt-6-luna" }, acceptance: {} } });
  b.tasks.push({ id: "t1", projectId: "p", workspaceId: "w1", sourcePath: "/repo", repoPaths: [], title: "Parse the log", description: "Output must be JSON. Do not write to /app.", status: "development", priority: "normal", position: 0, revision: 1, operationId: "op", createdAt: at, updatedAt: at, archivedAt: null });
  b.events.push({ id: "c1", at, taskId: "t1", actor: "human", action: "commented", note: "Keep the field order." });
  return b;
}

test("the author writes in a copy of the workspace from the card alone, and the suites decide when it is ready", async () => {
  const data = await temp(), workspace = await temp();
  await writeFile(join(workspace, "app.py"), "print('start')\n");
  let finish!: (r: { status: string }) => void;
  const created: Record<string, unknown>[] = [], spaces: Record<string, unknown>[] = [];
  const archived = vi.fn(async () => {});
  const paseo = {
    workspaces: {
      ref: () => ({ refresh: async () => ({ workspaceDirectory: workspace }) }),
      create: async (options: Record<string, unknown>) => {
        spaces.push(options);
        return { id: "author-ws", agents: { create: async (options: Record<string, unknown>) => { created.push(options); return { id: "author-1", waitForFinish: () => new Promise((r) => { finish = r; }), archive: vi.fn() }; } } };
      },
      archive: archived,
    },
    agents: { ref: () => ({}) },
  } as unknown as PaseoApi;
  const service = new AcceptanceService(data, { copy: async (from, to) => { await mkdir(to, { recursive: true }); for (const f of await readdir(from)) await writeFile(join(to, f), await readFile(join(from, f))); } });
  const b = board();
  b.automation.push({ taskId: "t1", projectId: "p", role: "implementer", state: "working", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: at, updatedAt: at });
  await service.tick(b, paseo);
  await vi.waitFor(() => expect(created).toHaveLength(1));
  const p = service.paths("t1");
  const options = created[0]!;
  // The copy is a workspace of the card's own Paseo project, not a project of its own.
  expect(spaces[0]).toMatchObject({ source: { kind: "directory", path: p.env, projectId: "native" } });
  expect(options).not.toHaveProperty("cwd");
  expect(await readFile(join(p.env, "app.py"), "utf8")).toBe("print('start')\n");
  expect(options.labels).toMatchObject({ "flowly-task": "t1", "flowly-acceptance": "author" });
  expect(options.config).toMatchObject({ provider: "codex/gpt-6-luna", modeId: "full-access" });
  const prompt = String(options.prompt);
  expect(prompt).toContain("Output must be JSON. Do not write to /app.");
  expect(prompt).toContain("Keep the field order.");
  expect(prompt).toContain("ACCEPTANCE passed=<n> failed=<m>");
  expect(prompt).not.toContain(workspace);
  expect(await service.context("t1", false)).toMatchObject({ state: "writing", suite: p.suite });
  // The same generation never starts a second author.
  await service.tick(b, paseo);
  expect(created).toHaveLength(1);

  await writeFile(join(p.suite, "run.sh"), "echo ACCEPTANCE passed=0 failed=1\n");
  await writeFile(join(p.holdout, "run.sh"), "echo ACCEPTANCE passed=0 failed=1\n");
  await writeFile(p.requirements, "- Output is JSON: test_json\n");
  finish({ status: "idle" });
  await vi.waitFor(async () => expect((await service.state("t1"))?.status).toBe("ready"));
  expect(await exists(p.env)).toBe(false);
  await vi.waitFor(() => expect(archived).toHaveBeenCalledWith("author-ws"));
  const implementer = await service.context("t1", false), reviewer = await service.context("t1", true);
  expect(implementer).not.toHaveProperty("holdout");
  expect(implementer).not.toHaveProperty("requirements");
  expect(reviewer).toMatchObject({ holdout: p.holdout, requirements: p.requirements });
  // Whole commands to copy, the workspace filled in; the holdout command only for the reviewer.
  const named = await service.context("t1", true, "/work/it's here");
  expect(named?.run).toBe(`bash ${join(p.suite, "run.sh")} '/work/it'\\''s here'`);
  expect(named?.holdoutRun).toBe(`bash ${join(p.holdout, "run.sh")} '/work/it'\\''s here'`);
  expect(await service.context("t1", false, "/work")).not.toHaveProperty("holdoutRun");
});

test("an author that leaves a suite out fails, and the card is reviewed without acceptance tests", async () => {
  const data = await temp();
  const service = new AcceptanceService(data);
  const p = service.paths("t2");
  await mkdir(p.suite, { recursive: true });
  await writeFile(p.state, JSON.stringify({ version: 1, taskId: "t2", generation: 1, status: "writing", startedAt: at, snapshots: [] }));
  await writeFile(join(p.suite, "run.sh"), "true\n");
  await service.finish("t2");
  expect(await service.state("t2")).toMatchObject({ status: "failed", detail: "The author did not write holdout/run.sh, requirements.md." });
  expect(authorPrompt({ title: "x", description: "y" }, [], p)).toContain("Do not ask questions");
});

test("a snapshot restores the exact workspace it copied, and never a moved, root or home folder", async () => {
  const data = await temp(), workspace = join(await temp(), "ws");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "a.txt"), "delivered\n");
  const service = new AcceptanceService(data);
  const p = service.paths("t3");
  await mkdir(p.root, { recursive: true });
  await writeFile(p.state, JSON.stringify({ version: 1, taskId: "t3", generation: 1, status: "ready", startedAt: at, snapshots: [] }));
  await service.snapshot("t3", workspace, 1, 1);
  await writeFile(join(workspace, "src", "a.txt"), "worse rework\n");
  await writeFile(join(workspace, "extra.txt"), "scratch\n");
  await service.restore("t3", workspace, 1, 1);
  expect(await readFile(join(workspace, "src", "a.txt"), "utf8")).toBe("delivered\n");
  expect(await exists(join(workspace, "extra.txt"))).toBe(false);
  await expect(service.restore("t3", join(workspace, ".."), 1, 1)).rejects.toThrow(/path changed/);
  await expect(service.restore("t3", workspace, 1, 2)).rejects.toThrow(/No snapshot/);
});

const luna = { provider: "codex", model: "gpt-6-luna" };
async function reviewed(failedFirst: number, failedSecond: number) {
  const snapshot = vi.fn(async () => {}), restore = vi.fn(async () => {});
  const acceptance = { tick: async () => {}, snapshot, restore, workspaceDirectory: async () => "/fixture/ws", guard: async () => false, paths: (id: string) => new AcceptanceService("/fixture/data").paths(id), state: async () => ({ version: 1 as const, taskId: "a", generation: 1, status: "ready" as const, startedAt: at, snapshots: [] }) };
  const x = await automationFixture({ enabled: true, reviewer: luna, acceptance: {} }, undefined, { acceptance });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0]!.agentId;
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  const rev = x.created[1]!.agentId;
  const as = { agentId: rev, taskId: "a", workspaceId: "w-a" };
  const count = (failed: number) => ({ visible: { passed: 4, failed }, holdout: { passed: 2, failed: 0 } });
  // With the tests ready, a verdict without counts is refused and nothing is recorded.
  await expect(x.automation.submitReview(as, { verdict: "approve", summary: "Looks fine" })).rejects.toMatchObject({ code: "ACCEPTANCE_REQUIRED" });
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 1 });
  await x.automation.submitReview(as, { verdict: "changes", summary: "Two checks fail", findings: ["test_order fails in /fixture/data/acceptance/a/holdout/run.sh"], acceptance: count(failedFirst) });
  // The implementer never learns where the reviewer-only tests are.
  expect((await x.job("a")).changes).toContain("test_order fails in [reviewer-only tests]/run.sh");
  expect((await x.job("a")).changes).not.toContain("/fixture/data/acceptance/a/holdout");
  expect(snapshot).toHaveBeenCalledWith("a", "/fixture/ws", 1, 1);
  await x.endTurn(rev, "a");
  await x.automation.kick();
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 2 });
  const answer = await x.automation.submitReview(as, { verdict: "changes", summary: "Still failing", findings: ["test_order fails"], acceptance: count(failedSecond) });
  return { x, restore, answer };
}

test("a rework that does not improve the acceptance tests is undone and the card waits for a person", async () => {
  const { x, restore, answer } = await reviewed(2, 3);
  expect(answer.message).toContain("restores that delivery");
  expect(restore).toHaveBeenCalledWith("a", "/fixture/ws", 1, 1);
  expect(await x.job("a")).toMatchObject({ state: "delivered", code: "acceptance_reverted", acceptanceRuns: [{ round: 1, passed: 6, failed: 2 }, { round: 2, passed: 6, failed: 3 }] });
  const notes = (await x.store.read()).events.filter((e) => e.action === "automation_acceptance_reverted").map((e) => e.note);
  expect(notes[0]).toContain("2 → 3 failing");
  expect(notes[1]).toBe("The workspace is back at review round 1's delivery.");
});

test("a rework with fewer failures goes on to the next round as usual", async () => {
  const { x, restore } = await reviewed(2, 1);
  expect(restore).not.toHaveBeenCalled();
  expect(await x.job("a")).toMatchObject({ state: "working", verdict: "changes" });
});

test("tests a session changed go back to the author's version, read-only", async () => {
  const data = await temp();
  const service = new AcceptanceService(data);
  const p = service.paths("t4");
  await mkdir(p.suite, { recursive: true }); await mkdir(p.holdout, { recursive: true });
  await writeFile(p.state, JSON.stringify({ version: 1, taskId: "t4", generation: 1, status: "writing", startedAt: at, snapshots: [] }));
  await writeFile(join(p.suite, "run.sh"), "echo ACCEPTANCE passed=1 failed=0\n");
  await writeFile(join(p.holdout, "run.sh"), "strict check\n");
  await writeFile(p.requirements, "- r: check\n");
  await service.finish("t4");
  expect(await service.guard("t4")).toBe(false);
  await expect(writeFile(join(p.holdout, "run.sh"), "loosened\n")).rejects.toThrow();
  const { chmod } = await import("node:fs/promises");
  await chmod(p.holdout, 0o700); await chmod(join(p.holdout, "run.sh"), 0o600);
  await writeFile(join(p.holdout, "run.sh"), "loosened\n");
  expect(await service.guard("t4")).toBe(true);
  expect(await readFile(join(p.holdout, "run.sh"), "utf8")).toBe("strict check\n");
  await expect(writeFile(join(p.holdout, "run.sh"), "again\n")).rejects.toThrow();
});

async function heldReview(first: "writing" | "failed") {
  const state = { version: 1 as const, taskId: "a", generation: 1, status: first as "writing" | "ready" | "failed", startedAt: at, snapshots: [], ...(first === "failed" ? { detail: "The author did not write holdout/run.sh." } : {}) };
  const acceptance = { tick: async () => {}, snapshot: vi.fn(async () => {}), restore: vi.fn(async () => {}), workspaceDirectory: async () => "/fixture/ws", guard: async () => false, paths: (id: string) => new AcceptanceService("/fixture/data").paths(id), state: async () => ({ ...state }) };
  const x = await automationFixture({ enabled: true, reviewer: luna, acceptance: {} }, undefined, { acceptance });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0]!.agentId;
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  await x.automation.kick();
  const events = async (action: string) => (await x.store.read()).events.filter((e) => e.taskId === "a" && e.action === action);
  return { x, state, events };
}

test("the review waits for acceptance tests still being written, without using up the round", async () => {
  const { x, state, events } = await heldReview("writing");
  // The delivery opened round 1, but no reviewer started: it would have approved without any tests.
  expect(await x.job("a")).toMatchObject({ role: "reviewer", state: "reviewing", reviewRounds: 1 });
  expect(x.created).toHaveLength(1);
  await x.automation.kick();
  expect(x.created).toHaveLength(1);
  expect(await events("automation_acceptance_waiting")).toHaveLength(1);
  state.status = "ready";
  await x.automation.kick();
  expect(x.created).toHaveLength(2);
  expect(x.created[1]!.labels).toMatchObject({ "flowly-automation": "reviewer" });
  expect(await x.job("a")).toMatchObject({ state: "reviewing", reviewRounds: 1 });
  // A verdict sent while the tests were still being written would have been refused.
  state.status = "writing";
  await expect(x.automation.submitReview({ agentId: x.created[1]!.agentId, taskId: "a", workspaceId: "w-a" }, { verdict: "approve", summary: "Fine" })).rejects.toMatchObject({ code: "ACCEPTANCE_PENDING" });
});

test("a failed author lets the review go on without tests, told once on the card", async () => {
  const { x, events } = await heldReview("failed");
  expect(x.created).toHaveLength(2);
  await x.automation.kick();
  const failed = await events("automation_acceptance_failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]!.note).toContain("The author did not write holdout/run.sh.");
  expect(await events("automation_acceptance_waiting")).toHaveLength(0);
  await x.automation.submitReview({ agentId: x.created[1]!.agentId, taskId: "a", workspaceId: "w-a" }, { verdict: "approve", summary: "Fine" });
  expect(await x.job("a")).toMatchObject({ verdict: "approved" });
});

test("an approval names every failing acceptance check it judges wrong, or it is refused", async () => {
  const { x, state } = await heldReview("writing");
  state.status = "ready";
  await x.automation.kick();
  const as = { agentId: x.created[1]!.agentId, taskId: "a", workspaceId: "w-a" };
  const counts = { visible: { passed: 20, failed: 1 }, holdout: { passed: 20, failed: 1 } };
  await expect(x.automation.submitReview(as, { verdict: "approve", summary: "Only test defects remain", acceptance: counts })).rejects.toMatchObject({ code: "ACCEPTANCE_FAILING" });
  await expect(x.automation.submitReview(as, { verdict: "approve", summary: "Only test defects remain", acceptance: { ...counts, disputed: [{ check: "test_api_name", reason: "calls nx.vf2pp_all_graph_isomorphisms; the card says compare with NetworkX 3.4.2, which has no such name" }] } })).rejects.toMatchObject({ code: "ACCEPTANCE_FAILING" });
  expect(await x.job("a")).toMatchObject({ state: "reviewing" });
  await x.automation.submitReview(as, { verdict: "approve", summary: "Only test defects remain", acceptance: { ...counts, disputed: [{ check: "test_api_name", reason: "calls a NetworkX name 3.4.2 does not have" }, { check: "reviewer-only test_api_name", reason: "the same call" }] } });
  expect(await x.job("a")).toMatchObject({ verdict: "approved", acceptanceRuns: [{ round: 1, passed: 40, failed: 2 }] });
  const note = (await x.store.read()).events.find((e) => e.action === "automation_review_approved")!.note!;
  expect(note).toContain("Failing acceptance checks judged wrong (2):\n- test_api_name: calls a NetworkX name 3.4.2 does not have");
});

test("the author is asked for checks as strict as a grader that knows the answer", () => {
  const prompt = authorPrompt({ title: "T", description: "D" }, [], { env: "/e", suite: "/s", holdout: "/h", requirements: "/r" });
  for (const rule of ["obviously correct reference", "chunked, reordered or batched", "every constraint on the whole output", "every form the forbidden thing can take", "as another unprivileged user", "'property only' (format or plausibility) is the last resort"])
    expect(prompt).toContain(rule);
});
