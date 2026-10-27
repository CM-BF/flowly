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
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
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
  const created: Record<string, unknown>[] = [];
  const archived = vi.fn(async () => {});
  const paseo = {
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: workspace }) }) },
    agents: { create: async (options: Record<string, unknown>) => { created.push(options); return { id: "author-1", waitForFinish: () => new Promise((r) => { finish = r; }), archive: archived }; }, ref: () => ({}) },
  } as unknown as PaseoApi;
  const service = new AcceptanceService(data, { copy: async (from, to) => { await mkdir(to, { recursive: true }); for (const f of await readdir(from)) await writeFile(join(to, f), await readFile(join(from, f))); } });
  const b = board();
  b.automation.push({ taskId: "t1", projectId: "p", role: "implementer", state: "working", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: at, updatedAt: at });
  await service.tick(b, paseo);
  await vi.waitFor(() => expect(created).toHaveLength(1));
  const p = service.paths("t1");
  const options = created[0]!;
  expect(options.cwd).toBe(p.env);
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
  await vi.waitFor(() => expect(archived).toHaveBeenCalled());
  const implementer = await service.context("t1", false), reviewer = await service.context("t1", true);
  expect(implementer).not.toHaveProperty("holdout");
  expect(implementer).not.toHaveProperty("requirements");
  expect(reviewer).toMatchObject({ holdout: p.holdout, requirements: p.requirements });
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
  const acceptance = { tick: async () => {}, snapshot, restore, workspaceDirectory: async () => "/fixture/ws" };
  const x = await automationFixture({ enabled: true, reviewer: luna, acceptance: {} }, undefined, { acceptance });
  await x.automation.queue("a");
  await x.automation.kick();
  const impl = x.created[0]!.agentId;
  await x.deliver(impl, "a");
  await x.turn(impl, "a");
  const rev = x.created[1]!.agentId;
  const as = { agentId: rev, taskId: "a", workspaceId: "w-a" };
  const count = (failed: number) => ({ visible: { passed: 4, failed }, holdout: { passed: 2, failed: 0 } });
  await x.automation.submitReview(as, { verdict: "changes", summary: "Two checks fail", findings: ["test_order fails"], acceptance: count(failedFirst) });
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
