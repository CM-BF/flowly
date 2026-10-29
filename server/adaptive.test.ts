import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { AdaptiveService } from "./adaptive";
import { automationFixture, cleanupAutomationFixtures } from "./automation-fixture";
import { adaptiveLimits, parseProgress, thinPrompt } from "../shared/adaptive";
import { automationSettingsSchema, type AutomationSettings } from "../shared/automation-schema";
import { emptyBoard, type Board } from "../shared/model";

// Adaptive mode (AUTOMATION-SPEC §5.6). Fake SDK and temp directories only: nothing reaches a daemon.
const dirs: string[] = [];
afterEach(async () => {
  await cleanupAutomationFixtures();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const temp = async () => { const d = await mkdtemp(join(tmpdir(), "flowly-adaptive-")); dirs.push(d); return d; };
const at = "2026-10-29T10:00:00.000Z";
const card = { title: "Write the library", description: "Implement every module of the spec.", comments: ["Keep the public names."] };
const settings = automationSettingsSchema.parse({ enabled: true, mode: "adaptive" }) as AutomationSettings;

test("limits: a share of the window, capped; the hard limit a third higher, at most 80% of the window", () => {
  expect(adaptiveLimits(settings, 475_000)).toEqual({ soft: 285_000, hard: 380_000 });
  // A 1M window would allow 600k; the cap keeps it where quality still holds.
  expect(adaptiveLimits(settings, 1_000_000)).toEqual({ soft: 300_000, hard: 400_000 });
  expect(adaptiveLimits({ adaptive: { threshold: 0.01 } }, 475_000).soft).toBe(4_750);
  // Terminal-Bench's largest native context (231k of 475k) stays below the soft limit.
  expect(231_000 < adaptiveLimits(settings, 475_000).soft).toBe(true);
});

test("the first instruction is the card itself, and progress.md parses into at most maxItems items", () => {
  const prompt = thinPrompt(card);
  expect(prompt.startsWith("Write the library\n\nImplement every module of the spec.")).toBe(true);
  expect(prompt).toContain("- Keep the public names.");
  expect(prompt).not.toMatch(/flowly_|workpad|handoff|review/i);
  const text = "## Done\nparser.py\n## Decisions\nTokens are tuples.\n## How to test\npytest\n" + [1, 2, 3, 4].map((n) => `## Item ${n}: part ${n}\nFiles: m${n}.py\nDo ${n}.`).join("\n");
  const progress = parseProgress(text, 3);
  expect(progress).toMatchObject({ done: "parser.py", decisions: "Tokens are tuples.", howToTest: "pytest" });
  expect(progress.items.map((i) => i.title)).toEqual(["part 1", "part 2", "part 3 (and 1 more)"]);
  expect(progress.items[2]!.body).toContain("### part 4");
  expect(parseProgress("## Done\neverything").items).toEqual([]);
});

function fakePaseo(state: { used: number; max: number; compactions: number; busy: boolean }) {
  const steered: { agentId: string; text: string }[] = [];
  const paseo = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: state.busy ? "running" : "idle", lastUsage: { contextWindowUsedTokens: state.used, contextWindowMaxTokens: state.max } } }),
        timeline: { refetch: async () => ({ entries: Array.from({ length: state.compactions }, () => ({ item: { type: "compaction", status: "completed", trigger: "auto" } })) }) },
      }),
    },
  } as unknown as PaseoApi;
  return { paseo, steered, steer: async (agentId: string, text: string) => { steered.push({ agentId, text }); } };
}
function board(threshold?: number): Board {
  const b = emptyBoard();
  b.projects.push({ id: "p", paseoProjectId: "native", title: "P", description: "", primaryPath: "/repo", repos: ["/repo"], revision: 1, createdAt: at, updatedAt: at, archivedAt: null,
    automation: { enabled: true, mode: "adaptive", maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2, ...(threshold ? { adaptive: { threshold } } : {}) } });
  b.tasks.push({ id: "t1", projectId: "p", workspaceId: "w1", sourcePath: "/repo", repoPaths: [], title: card.title, description: card.description, status: "development", priority: "normal", position: 0, revision: 1, operationId: "op", createdAt: at, updatedAt: at, archivedAt: null });
  b.automation.push({ taskId: "t1", projectId: "p", role: "implementer", state: "working", generation: 1, implementerId: "s1", nudges: 0, failures: 0, reviewRounds: 0, queuedAt: at, updatedAt: at });
  return b;
}

test("a running session is asked for an optional checkpoint past the soft limit and a required one at a compaction; never twice", async () => {
  const service = new AdaptiveService(await temp());
  const live = { used: 100_000, max: 475_000, compactions: 0, busy: true };
  const f = fakePaseo(live);
  await service.begin("t1", 1);
  await service.started("t1", "s1");
  expect(service.isSession("s1")).toBe(true);
  const watch = async () => { (service as unknown as { watchedAt: Map<string, number> }).watchedAt.clear(); await service.watch(board(), f.paseo, f.steer); };
  await watch();
  expect(f.steered).toHaveLength(0);
  live.used = 290_000;
  await watch();
  expect(f.steered).toHaveLength(1);
  expect(f.steered[0]!.text).toContain("If little work is left, finish the task in this session");
  await watch();
  expect(f.steered).toHaveLength(1);
  live.compactions = 1;
  await watch();
  expect(f.steered).toHaveLength(2);
  expect(f.steered[1]!.text).toContain("was compacted");
  expect(f.steered[1]!.text).not.toContain("If little work is left");
  expect(f.steered[1]!.text).toContain(service.paths("t1").progress);
  await watch();
  expect(f.steered).toHaveLength(2);
  const record = (await service.record("t1"))!;
  expect(record.sessions[0]).toMatchObject({ agentId: "s1", role: "implementer", depth: 0, peakUsed: 290_000, max: 475_000, compactions: 1, escalation: { level: "hard", reason: "compaction" } });
});

test("a checkpoint splits the rest over fresh sessions, each with the shared decisions in full, then a fresh integrator", async () => {
  const service = new AdaptiveService(await temp());
  const f = fakePaseo({ used: 300_000, max: 475_000, compactions: 0, busy: false });
  const p = service.paths("t1");
  await service.begin("t1", 1);
  await service.started("t1", "s1");
  expect(await service.requestSplit("t1", "s1")).toMatchObject({ message: expect.stringContaining("## Item 1: <short title>") });
  await writeFile(p.progress, "## Done\nparser.py\n## Decisions\nTokens are tuples.\n## How to test\npytest -q\n## Item 1: lexer\nFiles: lexer.py\nWrite the lexer.\n## Item 2: printer\nFiles: printer.py\nWrite the printer.\n");
  const first = await service.afterTurn("t1", "s1", settings, card, f.paseo);
  expect(first).toMatchObject({ kind: "fresh", reason: "Item 1 of 2: lexer" });
  const prompt1 = (first as { prompt: string }).prompt;
  for (const text of ["Write the library", "Tokens are tuples.", "Write the lexer.", "pytest -q", "item 1 of 2"]) expect(prompt1).toContain(text);
  expect(prompt1).not.toContain("Write the printer.");
  await service.started("t1", "s2");
  // The item session adds a decision; the next session gets it.
  await writeFile(p.progress, (await readFile(p.progress, "utf8")).replace("Tokens are tuples.", "Tokens are tuples.\nThe lexer yields (kind, text)."));
  const second = await service.afterTurn("t1", "s2", settings, card, f.paseo);
  expect(second).toMatchObject({ kind: "fresh", reason: "Item 2 of 2: printer" });
  expect((second as { prompt: string }).prompt).toContain("The lexer yields (kind, text).");
  await service.started("t1", "s3");
  const third = await service.afterTurn("t1", "s3", settings, card, f.paseo);
  expect(third).toMatchObject({ kind: "fresh", reason: "Integration of the split items" });
  expect((third as { prompt: string }).prompt).toContain("run the full tests");
  await service.started("t1", "s4");
  expect(await service.afterTurn("t1", "s4", settings, card, f.paseo)).toEqual({ kind: "deliver", note: "" });
  const record = (await service.record("t1"))!;
  expect(record.sessions.map((s) => [s.agentId, s.role, s.item ?? null, s.depth])).toEqual([["s1", "implementer", null, 0], ["s2", "item", 1, 1], ["s3", "item", 2, 1], ["s4", "integrator", null, 1]]);
  expect(record.splits).toEqual([expect.objectContaining({ by: "s1", depth: 1, reason: "requested", items: ["lexer", "printer"] })]);
});

test("a session that finishes without a checkpoint is delivered; the check command runs in the workspace", async () => {
  const exec = vi.fn(async () => ({ exit: 1, output: "FAILED test_x\n" }));
  const service = new AdaptiveService(await temp(), { exec });
  const f = fakePaseo({ used: 50_000, max: 475_000, compactions: 0, busy: false });
  await service.begin("t1", 1);
  await service.started("t1", "s1");
  expect(await service.afterTurn("t1", "s1", settings, card, f.paseo)).toEqual({ kind: "deliver", note: "" });
  const result = await service.check("t1", { ...settings, check: { command: "pytest" } }, "/work");
  expect(exec).toHaveBeenCalledWith("pytest", "/work", 600_000);
  expect(result).toMatchObject({ ok: false, exit: 1, tail: "FAILED test_x\n" });
});

test("the dispatcher starts an adaptive card like a native agent and delivers it without review when the turn ends", async () => {
  const data = await temp();
  const adaptive = new AdaptiveService(data);
  const x = await automationFixture({ enabled: true, mode: "adaptive", implementer: { provider: "codex", model: "gpt-6-luna" }, reviewer: { provider: "codex", model: "gpt-6-luna" } }, undefined, { adaptive });
  await x.automation.queue("a");
  await x.automation.kick();
  expect(x.created).toHaveLength(1);
  const s1 = x.created[0]!;
  expect(s1.prompt.startsWith("Card a")).toBe(true);
  expect(s1.prompt).not.toMatch(/flowly_|workpad/i);
  expect(adaptive.isSession(s1.agentId)).toBe(true);
  await x.endTurn(s1.agentId, "a");
  const board = await x.store.read();
  expect(board.tasks.find((t) => t.id === "a")!.status).toBe("in_review");
  expect(await x.job("a")).toMatchObject({ state: "delivered" });
  expect(await x.job("a")).not.toHaveProperty("verdict");
  expect(x.created).toHaveLength(1);
  expect((await adaptive.record("a"))!.deliveredAt).toBeTruthy();
});

test("after a checkpoint the dispatcher retires the session and starts the next item in a fresh one", async () => {
  const data = await temp();
  const adaptive = new AdaptiveService(data);
  const x = await automationFixture({ enabled: true, mode: "adaptive", implementer: { provider: "codex", model: "gpt-6-luna" } }, undefined, { adaptive });
  await x.automation.queue("a");
  await x.automation.kick();
  const s1 = x.created[0]!.agentId;
  await adaptive.requestSplit("a", s1);
  await writeFile(adaptive.paths("a").progress, "## Decisions\nUse UTF-8.\n## Item 1: rest\nFinish it.\n");
  await x.endTurn(s1, "a");
  await vi.waitFor(() => expect(x.created).toHaveLength(2));
  const s2 = x.created[1]!;
  expect(s2.prompt).toContain("Use UTF-8.");
  expect(s2.prompt).toContain("Finish it.");
  const job = await x.job("a");
  expect(job).toMatchObject({ implementerId: s2.agentId, state: "working" });
  expect(job.retired).toContainEqual(expect.objectContaining({ agentId: s1, reason: "adaptive_split" }));
  expect((await x.store.read()).events.some((e) => e.action === "automation_adaptive_continued")).toBe(true);
  // The item's session finishes: the integrator comes next.
  await x.endTurn(s2.agentId, "a");
  await vi.waitFor(() => expect(x.created).toHaveLength(3));
  expect(x.created[2]!.prompt).toContain("run the full tests");
});
