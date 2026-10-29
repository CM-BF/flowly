import { afterEach, expect, test, vi } from "vitest";
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { TournamentService, type TournamentHooks } from "./tournament";
import { replaceableFolder } from "./acceptance";
import { homedir } from "node:os";
import { automationFixture, cleanupAutomationFixtures } from "./automation-fixture";
import { automationSettingsSchema } from "../shared/automation-schema";
import { emptyBoard, type Board } from "../shared/model";

// Tournament mode (AUTOMATION-SPEC §5.5). Fake SDK and temp directories only: nothing reaches a daemon.
const dirs: string[] = [];
afterEach(async () => {
  await cleanupAutomationFixtures();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const temp = async () => { const d = await mkdtemp(join(tmpdir(), "flowly-tournament-")); dirs.push(d); return d; };
const exists = (p: string) => stat(p).then(() => true, () => false);
const at = "2026-10-28T10:00:00.000Z";
const copy = (from: string, to: string) => cp(from, to, { recursive: true });
const luna = { provider: "codex", model: "gpt-6-luna" };

function board(): Board {
  const b = emptyBoard();
  b.projects.push({ id: "p", paseoProjectId: "native", title: "P", description: "", primaryPath: "/repo", repos: ["/repo"], revision: 1, createdAt: at, updatedAt: at, archivedAt: null,
    automation: { enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2, implementer: luna, reviewer: { provider: "codex", model: "gpt-6.1-sol" }, acceptance: {}, tournament: { size: 2, plans: "approaches" } } });
  b.tasks.push({ id: "t1", projectId: "p", workspaceId: "w1", sourcePath: "/repo", repoPaths: [], title: "Count words", description: "Write count.py. Ambiguous: are digits words?", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "op", createdAt: at, updatedAt: at, archivedAt: null });
  b.automation.push({ taskId: "t1", projectId: "p", role: "implementer", state: "starting", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: at, updatedAt: at });
  return b;
}

/** A fake daemon: every session's turn ends when the test says so. */
function fakeDaemon(workspace: string) {
  const sessions: { role: string; cwd: string; prompt: string; config: Record<string, unknown>; end: (r: { status: string; lastMessage?: string }) => void }[] = [];
  const archived: string[] = [];
  let n = 0;
  const paseo = {
    workspaces: {
      ref: () => ({ refresh: async () => ({ workspaceDirectory: workspace }) }),
      create: async (o: { source: { path: string; projectId?: string } }) => {
        const id = `ws-${++n}`;
        return {
          id,
          agents: {
            create: async (a: { labels: Record<string, string>; prompt: string; config: Record<string, unknown> }) => {
              let end!: (r: { status: string; lastMessage?: string }) => void;
              const done = new Promise<{ status: string; lastMessage?: string }>((r) => { end = r; });
              sessions.push({ role: a.labels["flowly-tournament"]!, cwd: o.source.path, prompt: a.prompt, config: a.config, end });
              expect(o.source.projectId).toBe("native");
              return { id: `agent-${n}`, waitForFinish: () => done, archive: vi.fn() };
            },
          },
        };
      },
      archive: async (id: string) => { archived.push(id); },
    },
    // The judge (created by the dispatcher) is watched by id; its turn never ends in these tests.
    agents: { ref: () => ({ waitForFinish: () => new Promise(() => {}) }) },
  } as unknown as PaseoApi;
  return { paseo, sessions, archived };
}

async function setup(acceptance: "ready" | "none" = "ready", plans: "approaches" | "none" = "approaches") {
  const data = await temp(), workspace = await temp();
  await writeFile(join(workspace, "data.txt"), "original\n");
  const b = board();
  if (plans === "none") b.projects[0]!.automation!.tournament = { size: 2 };
  const daemon = fakeDaemon(workspace);
  const judgePrompts: string[] = [];
  const hooks: TournamentHooks & { decided: ReturnType<typeof vi.fn>; fallback: ReturnType<typeof vi.fn> } = {
    decided: vi.fn(async () => {}),
    fallback: vi.fn(async () => {}),
    createJudge: async (_taskId, _generation, prompt, _model, prepared) => { prepared("judge-1"); judgePrompts.push(prompt); return "judge-1"; },
  };
  const tests = acceptance === "ready" ? {
    state: async () => ({ version: 1 as const, taskId: "t1", generation: 1, status: "ready" as const, startedAt: at, snapshots: [] }),
    context: async () => ({ state: "ready" as const, suite: "/a/suite", run: `bash /a/suite/run.sh ${workspace}`, holdout: "/a/holdout", holdoutRun: `bash /a/holdout/run.sh ${workspace}`, requirements: "/a/requirements.md" }),
  } : null;
  const service = new TournamentService(data, tests, { copy });
  const tick = () => service.tick(b, daemon.paseo, hooks, async () => b);
  return { data, workspace, b, ...daemon, hooks, judgePrompts, service, tick, p: service.paths("t1") };
}

const counts = (failed: number) => ({ visible: { passed: 5, failed }, holdout: { passed: 4, failed: 0 } });

test("planner, isolated candidates and a judge: failing checks eliminate, only the active winner is delivered, every tree is kept", async () => {
  const x = await setup();
  expect(await x.service.holds("t1", 1)).toBe(true);
  await x.tick();
  await vi.waitFor(() => expect(x.sessions).toHaveLength(1));
  // The planner reads a copy of the workspace and must write distinct plans.
  expect(x.sessions[0]).toMatchObject({ role: "planner", cwd: x.p.env });
  expect(x.sessions[0]!.prompt).toContain("## Plan 2");
  expect(x.sessions[0]!.prompt).toContain("TOURNAMENT: skip");
  expect(x.sessions[0]!.config).toMatchObject({ provider: "codex/gpt-6.1-sol", modeId: "full-access" });
  expect(x.sessions[0]!.prompt).toContain("never spread different readings over the plans");
  await writeFile(x.p.plans, "## Readings\nDigits are not words: the card says letters.\n\n## Plan 1\nA regex tokenizer.\nDiffers from the others: regex\n\n## Plan 2\nA character loop.\nDiffers from the others: loop\n");
  x.sessions[0]!.end({ status: "idle" });

  await vi.waitFor(() => expect(x.sessions).toHaveLength(3));
  const [c1, c2] = [x.sessions[1]!, x.sessions[2]!];
  expect(c1).toMatchObject({ role: "candidate-c1", cwd: x.p.candidate("c1") });
  // Every candidate gets the same readings, and its own approach.
  for (const c of [c1, c2]) expect(c.prompt).toContain("Digits are not words: the card says letters.");
  expect(c1.prompt).toContain("A regex tokenizer.");
  expect(c2.prompt).toContain("A character loop.");
  expect(c1.prompt).toContain(`do not write into ${x.workspace}`);
  expect(c1.config).toMatchObject({ provider: "codex/gpt-6-luna" });
  expect(await readFile(join(x.p.candidate("c2"), "data.txt"), "utf8")).toBe("original\n");
  expect(x.archived).toContain("ws-1");
  // Each candidate works only in its own copy.
  await writeFile(join(x.p.candidate("c1"), "count.py"), "print('c1')\n");
  await writeFile(join(x.p.candidate("c2"), "count.py"), "print('c2')\n");
  c1.end({ status: "idle", lastMessage: "c1: digits ignored" });
  expect(x.judgePrompts).toHaveLength(0);
  c2.end({ status: "idle", lastMessage: "c2: digits counted" });
  await vi.waitFor(() => expect(x.judgePrompts).toHaveLength(1));
  expect(await exists(join(x.workspace, "count.py"))).toBe(false);
  const prompt = x.judgePrompts[0]!;
  for (const text of [x.p.candidate("c1"), x.p.candidate("c2"), "c2: digits counted", "bash /a/holdout/run.sh", "flowly_submit_judgement"]) expect(prompt).toContain(text);
  expect(x.service.isJudge("judge-1")).toBe(true);

  const judgement = (winner: string, c1Failed: number, c2Failed: number, disputed = 0) => ({
    candidates: [
      { id: "c1", ...counts(c1Failed), probes: [{ command: "python count.py <<< 'a 1'", exit: 0, output: "1" }] },
      { id: "c2", ...counts(c2Failed), ...(disputed ? { disputed: [{ check: "test_digits", reason: "The card leaves digits open" }] } : {}), probes: [] },
    ],
    disagreements: [{ input: "a 1", outputs: { c1: "1", c2: "2" }, ruling: "c1", reason: "\"Ambiguous: are digits words?\": both readings allowed; c1 matches common usage" }],
    winner, summary: `${winner} wins`, final: counts(winner === "c1" ? c1Failed : c2Failed),
  });
  await expect(x.service.activate("t1", "someone-else", "c1")).rejects.toMatchObject({ code: "NOT_JUDGE" });
  await expect(x.service.submit("t1", "judge-1", { ...judgement("c1", 0, 1), candidates: [{ id: "c1", probes: [] }] })).rejects.toMatchObject({ code: "ACCEPTANCE_REQUIRED" });
  await x.service.activate("t1", "judge-1", "c2");
  expect(await readFile(join(x.workspace, "count.py"), "utf8")).toBe("print('c2')\n");
  expect(await exists(join(x.workspace, "data.txt"))).toBe(true);
  // c2 has an undisputed failing check: it cannot win over c1.
  await expect(x.service.submit("t1", "judge-1", judgement("c2", 0, 1))).rejects.toMatchObject({ code: "TOURNAMENT_ELIMINATED" });
  // Disputed with the card text, the failure no longer counts; the winner must still be the active candidate.
  await expect(x.service.submit("t1", "judge-1", judgement("c1", 0, 1, 1))).rejects.toMatchObject({ code: "WINNER_NOT_ACTIVE" });
  await x.service.activate("t1", "judge-1", "c1");
  const answer = await x.service.submit("t1", "judge-1", judgement("c1", 0, 1));
  expect(answer).toMatchObject({ accepted: true, winner: "c1" });
  expect(await readFile(join(x.workspace, "count.py"), "utf8")).toBe("print('c1')\n");
  expect(x.hooks.decided).toHaveBeenCalledWith("t1", 1, expect.stringContaining("c1 delivered (acceptance passed/failed: c1 9/0, c2 9/1)"));
  expect(x.service.isJudge("judge-1")).toBe(false);
  // The evidence: every candidate's tree and manifest, the plans, the judgement.
  const state = JSON.parse(await readFile(x.p.state, "utf8"));
  expect(state).toMatchObject({ phase: "decided", winner: "c1", active: "c1", final: counts(0), judgement: { disagreements: [{ ruling: "c1" }] } });
  expect(state).toMatchObject({ readings: "Digits are not words: the card says letters." });
  expect(state.candidates[1]).toMatchObject({ id: "c2", status: "delivered", note: "c2: digits counted", plan: expect.stringContaining("A character loop.") });
  expect(state.candidates[1].files).toContainEqual({ path: "count.py", size: 12, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(state.activations.map((a: { candidate: string }) => a.candidate)).toEqual(["c2", "c1"]);
  expect(await readFile(join(x.p.candidate("c2"), "count.py"), "utf8")).toBe("print('c2')\n");
  await expect(x.service.submit("t1", "judge-1", judgement("c1", 0, 1))).rejects.toMatchObject({ code: "TOURNAMENT_CLOSED" });
});

test("a planner that finds the work mostly outside the workspace skips the tournament: one implementer works as usual", async () => {
  const x = await setup();
  await x.tick();
  await vi.waitFor(() => expect(x.sessions).toHaveLength(1));
  await writeFile(x.p.plans, "TOURNAMENT: skip configures a system service under /etc\n");
  x.sessions[0]!.end({ status: "idle" });
  await vi.waitFor(() => expect(x.hooks.fallback).toHaveBeenCalledWith("t1", 1, expect.stringContaining("configures a system service under /etc")));
  expect(await x.service.holds("t1", 1)).toBe(false);
  expect(x.sessions).toHaveLength(1);
});

test("when no candidate delivers, the card falls back to one implementer", async () => {
  const x = await setup("none");
  await x.tick();
  await vi.waitFor(() => expect(x.sessions).toHaveLength(1));
  x.sessions[0]!.end({ status: "error" });
  // A failed planner still gives the candidates their own approaches.
  await vi.waitFor(() => expect(x.sessions).toHaveLength(3));
  expect(x.sessions[1]!.prompt).not.toContain("Suggested approach");
  x.sessions[1]!.end({ status: "error" });
  x.sessions[2]!.end({ status: "error" });
  await vi.waitFor(() => expect(x.hooks.fallback).toHaveBeenCalledWith("t1", 1, "No candidate delivered; one implementer works on the card as usual."));
  expect(await x.service.holds("t1", 1)).toBe(false);
  expect(x.judgePrompts).toHaveLength(0);
});

test("the dispatcher holds a tournament card's implementer and delivers the decided card to In review", async () => {
  let held = true;
  let hooks!: TournamentHooks;
  const tournament = { tick: async (_b: Board, _p: unknown, h: TournamentHooks) => { hooks = h; }, holds: async () => held };
  const x = await automationFixture({ enabled: true, implementer: luna, reviewer: luna, acceptance: {}, tournament: { size: 2 } }, undefined, { tournament });
  await x.automation.queue("a");
  await x.automation.kick();
  expect(x.created).toHaveLength(0);
  expect(await x.job("a")).toMatchObject({ role: "implementer", state: "starting" });
  // The judge is a prepared session in the card's workspace, recorded as the job's reviewer.
  const registered: string[] = [];
  const judge = await hooks.createJudge("a", 1, "judge these", luna, (id) => registered.push(id));
  expect(registered).toEqual([judge]);
  expect(x.created).toHaveLength(1);
  expect(x.created[0]).toMatchObject({ agentId: judge, workspaceId: "w-a", prompt: "judge these", labels: { "flowly-tournament": "judge" } });
  expect(await x.job("a")).toMatchObject({ reviewerId: judge, state: "starting" });
  await hooks.decided("a", 1, "Tournament of 2: c1 delivered.");
  const board = await x.store.read();
  expect(board.tasks.find((t) => t.id === "a")!.status).toBe("in_review");
  expect(await x.job("a")).toMatchObject({ state: "delivered", verdict: "approved" });
  expect(board.events.find((e) => e.action === "automation_tournament_decided")!.note).toBe("Tournament of 2: c1 delivered.");
  // Another card that falls back gets its implementer as usual.
  await x.automation.queue("b");
  await x.automation.kick();
  expect(x.created).toHaveLength(1);
  held = false;
  await hooks.fallback("b", 1, "No candidate delivered; one implementer works on the card as usual.");
  await x.automation.kick();
  await vi.waitFor(() => expect(x.created).toHaveLength(2));
  expect(x.created[1]).toMatchObject({ workspaceId: "w-b", labels: { "flowly-automation": "implementer" } });
});

test("settings accept a tournament of 2 or 3", () => {
  expect(automationSettingsSchema.parse({ enabled: true, tournament: { size: 2 } }).tournament).toEqual({ size: 2 });
  expect(() => automationSettingsSchema.parse({ enabled: true, tournament: { size: 4 } })).toThrow();
  expect(automationSettingsSchema.parse({ enabled: true })).not.toHaveProperty("tournament");
});

test("one-level workspaces such as /app can be replaced; the root, home and system folders never", () => {
  for (const dir of ["/app", "/workspace", "/app/", "/srv/app", "/Users/me/project"]) expect(replaceableFolder(dir)).toBe(true);
  for (const dir of ["/", "/etc", "/usr", "/root", "/var", "/tmp", "/home", "/Users", homedir()]) expect(replaceableFolder(dir)).toBe(false);
});

test("a judge that never submits and a candidate that cannot be activated fail the tournament without ending the plugin", async () => {
  const x = await setup();
  const ends: Array<(r: { status: string }) => void> = [];
  const sent: string[] = [];
  (x.paseo as unknown as { agents: unknown }).agents = { ref: () => ({
    waitForFinish: () => new Promise((r) => ends.push(r)),
    send: async (text: string) => { sent.push(text); },
  }) };
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    await x.tick();
    await vi.waitFor(() => expect(x.sessions).toHaveLength(1));
    await writeFile(x.p.plans, "## Plan 1\nA\n\n## Plan 2\nB\n");
    x.sessions[0]!.end({ status: "idle" });
    await vi.waitFor(() => expect(x.sessions).toHaveLength(3));
    x.sessions[1]!.end({ status: "idle", lastMessage: "c1" });
    x.sessions[2]!.end({ status: "idle", lastMessage: "c2" });
    await vi.waitFor(() => expect(ends).toHaveLength(1));
    ends[0]!({ status: "idle" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // The workspace disappears: the automatic pick cannot activate anything.
    await rm(x.workspace, { recursive: true, force: true });
    await vi.waitFor(() => expect(ends).toHaveLength(2));
    ends[1]!({ status: "idle" });
    await vi.waitFor(() => expect(x.hooks.fallback).toHaveBeenCalledWith("t1", 1, expect.stringContaining("could not be activated")));
    expect(await x.service.holds("t1", 1)).toBe(false);
    expect(JSON.parse(await readFile(x.p.state, "utf8")).phase).toBe("failed");
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).not.toHaveBeenCalled();
  } finally { process.off("unhandledRejection", unhandled); }
});

test("by default there is no planner: each candidate gets the card as its task, like a single implementer", async () => {
  const x = await setup("ready", "none");
  await x.tick();
  await vi.waitFor(() => expect(x.sessions).toHaveLength(2));
  expect(x.sessions.map((c) => c.role)).toEqual(["candidate-c1", "candidate-c2"]);
  for (const c of x.sessions) {
    expect(c.prompt.startsWith("Count words\n\nWrite count.py. Ambiguous: are digits words?")).toBe(true);
    expect(c.prompt).not.toContain("readings");
    expect(c.prompt).not.toContain("as data");
  }
  expect(await exists(x.p.env)).toBe(false);
  expect(JSON.parse(await readFile(x.p.state, "utf8")).phase).toBe("implementing");
});
