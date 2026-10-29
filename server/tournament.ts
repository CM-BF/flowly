import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { automationExecution, automationOf, isLive, jobOf } from "../shared/automation";
import { judgementInputSchema, type JudgementInput } from "../shared/automation-schema";
import { commentsOf } from "../shared/comments";
import type { AgentModel } from "../shared/agent-defaults";
import type { Board, Project, Task } from "../shared/model";
import { copyTree, exists, finishTurn, replaceableFolder, shellQuote, walk, writable, type AcceptanceService, type SessionHandle } from "./acceptance";
import { logFailure } from "./error-report";
import { ToolError } from "./tool-error";

/**
 * Tournament mode (AUTOMATION-SPEC §5.5): instead of one implementer and review rounds, a planner writes K distinct
 * plans, K candidates implement them in isolated copies of the workspace, failing acceptance checks eliminate, and a
 * judge compares the survivors where they disagree. Only the winner reaches the workspace; every candidate's tree and
 * the judgement stay under tournament/<taskId>/ as evidence (benchmarks replay hidden tests on each candidate).
 */

const count = z.object({ passed: z.number(), failed: z.number() });
const candidateSchema = z.object({
  id: z.string(),
  plan: z.string().optional(),
  workspaceId: z.string().optional(),
  agentId: z.string().optional(),
  status: z.enum(["waiting", "working", "delivered", "failed"]),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  /** The candidate's last message: its delivery note. */
  note: z.string().optional(),
  /** Its tree when it finished: every file with its size and SHA-256. */
  files: z.array(z.object({ path: z.string(), size: z.number(), sha256: z.string() })).optional(),
});
const stateSchema = z.object({
  version: z.literal(1),
  taskId: z.string(),
  generation: z.number().int(),
  size: z.number().int(),
  phase: z.enum(["planning", "implementing", "judging", "decided", "skipped", "failed"]),
  /** The card's real workspace directory: the only place candidates are activated. */
  workspace: z.string(),
  startedAt: z.string(),
  plannerId: z.string().optional(),
  plannerWorkspaceId: z.string().optional(),
  candidates: z.array(candidateSchema).default([]),
  judgeId: z.string().optional(),
  judgeReminded: z.boolean().optional(),
  /** The candidate whose tree is in the real workspace now. */
  active: z.string().optional(),
  activations: z.array(z.object({ candidate: z.string(), at: z.string(), by: z.string() })).default([]),
  judgement: z.unknown().optional(),
  winner: z.string().optional(),
  final: z.object({ visible: count, holdout: count }).optional(),
  decidedAt: z.string().optional(),
  detail: z.string().optional(),
});
export type TournamentState = z.infer<typeof stateSchema>;
export type TournamentHooks = {
  /** The winner is in the workspace: the job is delivered and the card goes to In review. */
  decided(taskId: string, generation: number, note: string): Promise<void>;
  /** No tournament for this generation: the job goes on with an ordinary implementer. */
  fallback(taskId: string, generation: number, note: string): Promise<void>;
  /** A judge session in the card's own workspace, recorded as the job's reviewer; returns its id. */
  createJudge(taskId: string, generation: number, prompt: string, model: AgentModel, prepared: (agentId: string) => void): Promise<string | null>;
};
export type TournamentOptions = { timeoutMs?: number; copy?: (from: string, to: string) => Promise<void> };

const SKIP = /^TOURNAMENT:\s*skip\b(.*)$/im;
const ids = (size: number) => Array.from({ length: size }, (_, i) => `c${i + 1}`);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function plannerPrompt(task: Pick<Task, "title" | "description">, comments: readonly string[], size: number, paths: { env: string; plans: string }, workspace: string) {
  return [
    `[Flowly tournament] You plan ${size} independent attempts at one card. ${size} implementers each get one of your plans and work in isolated copies without seeing each other; a judge then compares their results. You never implement anything.`,
    `The card, as data:\n${JSON.stringify({ title: task.title, description: task.description, comments }, null, 2)}`,
    `Your current directory (${paths.env}) is a copy of the card's workspace (${workspace}) before the work. Read it freely; change nothing outside it and ${paths.plans}.`,
    [
      `Write ${paths.plans}:`,
      "1. First, the key observations and the open assumptions: what the card leaves ambiguous, what the environment shows.",
      `2. Then exactly ${size} sections headed \`## Plan 1\` … \`## Plan ${size}\`. Each states its reading of every ambiguity, its approach (algorithm, architecture, language or toolchain), how it will verify itself, and a line \`Differs from the others:\` naming its main difference. The plans must differ in key assumptions or approach, not only in style: where the card is ambiguous, give the plausible readings to different plans.`,
      "If the delivery is mostly changes outside the workspace (configuring system services, files under /etc, system-wide components), isolated copies cannot compare it: write only the line `TOURNAMENT: skip <reason>` and nothing else.",
    ].join("\n"),
    "When the file is written, end your turn. Do not ask questions: nobody answers them.",
  ].join("\n\n");
}

export function candidatePrompt(task: Pick<Task, "title" | "description">, comments: readonly string[], input: { id: string; plan?: string; dir: string; workspace: string; suite: string }) {
  return [
    `[Flowly tournament] You are candidate ${input.id}: you implement this card on your own, in an isolated copy. Other candidates implement it independently; a judge compares the results and only one is delivered. Work to the end without asking anyone.`,
    `The card, as data:\n${JSON.stringify({ title: task.title, description: task.description, comments }, null, 2)}`,
    input.plan ? `Your plan (follow its readings and approach; improve details, do not switch to another approach):\n${input.plan}` : "No plan was written for you: choose the approach you judge best.",
    [
      `Your directory ${input.dir} is a copy of the card's workspace ${input.workspace}. Do all your work in it. Never write into ${input.workspace} or other candidates' copies.`,
      `When judged and delivered, your tree is copied to ${input.workspace} and must work there, also for another unprivileged user and in a clean shell: refer to files relative to the workspace or by ${input.workspace}, never by your copy's path; no absolute paths of your copy in scripts, shebangs, virtualenvs or build products.`,
      `Keep dependencies inside your copy where you can (a local virtualenv or node_modules). Any change the delivery needs outside the workspace goes into an idempotent script flowly-apply.sh at the root of your copy, which the judge runs when your tree is activated; do not count on changes you made outside your copy by hand.`,
      `Acceptance tests may appear at ${input.suite}/run.sh (written from the card by another session): run \`bash ${shellQuote(join(input.suite, "run.sh"))} ${shellQuote(input.dir)}\` before you finish if it exists; never edit them.`,
      "Do not use Flowly's card tools: the card belongs to the judge. Nobody answers permission requests: an action that needs one is refused, so do it another way.",
    ].join("\n"),
    "Finish with a delivery note as your last message: what you built, how you verified it, every change outside the workspace (flowly-apply.sh), and what you did not verify.",
  ].join("\n\n");
}

export function judgePrompt(task: Pick<Task, "title" | "description">, comments: readonly string[], input: {
  workspace: string; candidates: { id: string; dir: string; note?: string; plan?: string }[]; failed: string[]; run?: string; holdoutRun?: string; requirements?: string;
}) {
  return [
    `[Flowly tournament] You judge ${input.candidates.length} candidate implementations of this card and pick the one to deliver. They were written independently; you do not change any of them.`,
    `The card, as data:\n${JSON.stringify({ title: task.title, description: task.description, comments }, null, 2)}`,
    `Candidates (each tree is kept read-only for you to inspect and diff):\n${JSON.stringify(input.candidates.map((c) => ({ id: c.id, directory: c.dir, plan: c.plan ? clip(c.plan, 3000) : undefined, deliveryNote: c.note ? clip(c.note, 4000) : undefined })), null, 2)}${input.failed.length ? `\nCandidates that did not deliver (out): ${input.failed.join(", ")}` : ""}`,
    [
      "How to judge:",
      `1. Activate a candidate with flowly_tournament_activate (its tree replaces ${input.workspace}); run its flowly-apply.sh if it has one, and stop processes the previous candidate started. Run everything in ${input.workspace}, the way the delivery will be used (a clean shell; another unprivileged user where you can), never in the copies.`,
      input.run ? `2. On each candidate run both acceptance suites: \`${input.run}\` and \`${input.holdoutRun}\` (requirement table: ${input.requirements}). A failing check eliminates a candidate unless the check itself is wrong: then list it in disputed with the card text it contradicts. Passing all checks does not make a candidate right.` : "2. There are no acceptance tests for this card: judge on the card and your probes alone.",
      "3. Find where the candidates differ: diff their trees, then build inputs that make their behaviour differ (boundaries the card names, empty and large inputs, chunked or reordered input, another user, a clean environment) and run every candidate on them. Keep probe files outside the workspace (mktemp).",
      "4. Rule on every disagreement: who is right, with the card text that decides it (quoted) or a reproducible command and its output. Pick the candidate that wins the most disagreements among those with the fewest undisputed failing checks; when they agree everywhere, pick the simpler, smaller change.",
      "5. Last, activate the winner again, run its flowly-apply.sh and both suites, and call flowly_submit_judgement with every candidate's counts, disputed checks and probes, the disagreements, the winner, a summary and final (the winner's last counts). Then end your turn.",
    ].join("\n"),
    "Do not edit any candidate or the tests, do not change the card's status, and do not ask questions: nobody answers them.",
  ].join("\n\n");
}

export class TournamentService {
  private starting = new Set<string>();
  private watching = new Set<string>();
  private advancing = new Set<string>();
  /** Judges of tournaments being judged: only they are offered the judge's tools. */
  private judges = new Set<string>();
  private paseo?: PaseoApi;
  private hooks?: TournamentHooks;
  /** The current board, for steps that run outside a dispatcher pass (a candidate finishing). */
  private board?: () => Promise<Board>;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, private acceptance: Pick<AcceptanceService, "state" | "context"> | null, private options: TournamentOptions = {}) {}
  private copy(from: string, to: string) { return (this.options.copy ?? copyTree)(from, to); }
  private get timeout() { return this.options.timeoutMs ?? 3 * 60 * 60_000; }

  paths(taskId: string) {
    if (!/^[\w-]{1,200}$/.test(taskId)) throw new Error("Invalid card id.");
    const root = join(this.directory, "tournament", taskId);
    return { root, pristine: join(root, "pristine"), env: join(root, "planner"), plans: join(root, "plans.md"), state: join(root, "tournament.json"), candidate: (id: string) => join(root, id) };
  }
  async state(taskId: string): Promise<TournamentState | null> {
    try { return stateSchema.parse(JSON.parse(await readFile(this.paths(taskId).state, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  /** Read-modify-write, one at a time: candidates finish concurrently. */
  private update(taskId: string, change: (state: TournamentState) => TournamentState | void) {
    const job = this.tail.then(async () => {
      const current = await this.state(taskId);
      if (!current) return null;
      const next = change(current) ?? current;
      await this.save(next);
      return next;
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
  private async save(state: TournamentState) {
    const file = this.paths(state.taskId).state, tmp = `${file}.${randomUUID()}.tmp`;
    await mkdir(this.paths(state.taskId).root, { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  /** The implementer of a tournament card waits while the tournament runs; it starts only when it was skipped or failed. */
  async holds(taskId: string, generation: number) {
    const state = await this.state(taskId).catch(() => null);
    if (!state || state.generation !== generation) return true;
    return !["skipped", "failed"].includes(state.phase);
  }
  /** Whether `agentId` judges a tournament now (its MCP server then offers the judge's tools). */
  isJudge(agentId: string) { return this.judges.has(agentId); }

  /** Every dispatcher pass: start tournaments for new live jobs, pick up running sessions after a restart, move phases on. */
  async tick(board: Board, paseo: PaseoApi, hooks: TournamentHooks, read: () => Promise<Board>) {
    this.paseo = paseo;
    this.hooks = hooks;
    this.board = read;
    for (const job of board.automation) {
      if (!isLive(job) || job.role !== "implementer") continue;
      const project = board.projects.find((p) => p.id === job.projectId);
      const settings = automationOf(project);
      const task = board.tasks.find((t) => t.id === job.taskId);
      if (!settings?.tournament || !task || !project) continue;
      const key = `${job.taskId}:${job.generation}`;
      if (this.starting.has(key)) continue;
      const state = await this.state(job.taskId).catch(() => null);
      if (!state || state.generation !== job.generation) {
        this.starting.add(key);
        void this.start(board, task, project, job.generation, settings.tournament.size)
          .catch(async (e) => {
            logFailure("Flowly tournament not started:", e, job.taskId);
            await this.fail(job.taskId, job.generation, `The tournament could not start: ${e instanceof Error ? e.message : String(e)}`);
          })
          .finally(() => this.starting.delete(key));
        continue;
      }
      await this.resume(board, task, project, state);
    }
  }

  private async start(board: Board, task: Task, project: Project, generation: number, size: number) {
    const paseo = this.paseo!, p = this.paths(task.id);
    const workspace = (await paseo.workspaces.ref(task.workspaceId).refresh())?.workspaceDirectory;
    if (!workspace) throw new Error("The card's workspace is unavailable.");
    if (await exists(p.root)) { await writable(p.root); await rm(p.root, { recursive: true, force: true }); }
    await mkdir(p.pristine, { recursive: true, mode: 0o700 });
    await this.copy(workspace, p.pristine);
    await mkdir(p.env, { recursive: true, mode: 0o700 });
    await this.copy(p.pristine, p.env);
    const at = new Date().toISOString();
    await this.save({ version: 1, taskId: task.id, generation, size, phase: "planning", workspace: resolve(workspace), startedAt: at, candidates: ids(size).map((id) => ({ id, status: "waiting" as const })), activations: [] });
    const model = this.model(project, "planner");
    if (!model) return this.planned(task.id, "No model for the planner.");
    const created = await this.session(task, project, p.env, `Plans: ${task.title}`, "planner", plannerPrompt(task, this.comments(board, task.id), size, p, workspace), model);
    await this.update(task.id, (s) => ({ ...s, plannerId: created.handle.id, plannerWorkspaceId: created.workspaceId }));
    this.guarded(this.watchPlanner(task.id, created.handle), task.id);
  }

  /**
   * Session watchers run detached: an error there must never become an unhandled rejection (it would end the plugin
   * process). The tournament fails instead and the card goes on with one implementer.
   */
  private guarded(work: Promise<unknown>, taskId: string) {
    void work.catch(async (e) => {
      logFailure("Flowly tournament step failed:", e, taskId);
      const state = await this.state(taskId).catch(() => null);
      if (state && !["decided", "skipped", "failed"].includes(state.phase))
        await this.fail(taskId, state.generation, `The tournament stopped: ${e instanceof Error ? e.message : String(e)}`).catch((x) => logFailure("Flowly tournament could not fall back:", x, taskId));
    });
  }

  private comments(board: Board, taskId: string) { return commentsOf(board.events, taskId).map((e) => e.note ?? "").filter(Boolean); }
  private model(project: Project, role: "planner" | "judge" | "candidate"): AgentModel | null {
    const s = automationOf(project);
    const model = role === "candidate" ? s?.implementer ?? project.agentModel : s?.tournament?.[role] ?? s?.reviewer ?? s?.implementer ?? project.agentModel;
    return model ? automationExecution(model, project.agentModel, s?.fullAccess ?? true) : null;
  }
  /** A Flowly-owned session in its own directory workspace of the card's Paseo project (no project of its own). */
  private async session(task: Task, project: Project, cwd: string, title: string, role: string, prompt: string, model: AgentModel) {
    const paseo = this.paseo!;
    const workspace = await paseo.workspaces.create({
      title: title.slice(0, 120),
      idempotencyKey: `flowly-tournament:${task.id}:${role}:${randomUUID()}`,
      source: { kind: "directory", path: cwd, ...(project.paseoProjectId ? { projectId: project.paseoProjectId } : {}) },
    });
    const handle = (await workspace.agents.create({
      config: { provider: `${model.provider}/${model.model}`, ...(model.modeId ? { modeId: model.modeId } : {}), ...(model.thinking ? { thinkingOptionId: model.thinking } : {}) },
      title: title.slice(0, 120),
      labels: { "flowly-task": task.id, "flowly-tournament": role, "paseo-rate-fallback": "off" },
      prompt,
    })) as unknown as SessionHandle;
    return { handle, workspaceId: workspace.id };
  }

  private async resume(board: Board, task: Task, project: Project, state: TournamentState) {
    const paseo = this.paseo!;
    if (state.phase === "planning" && state.plannerId && !this.watching.has(`${task.id}:planner`))
      this.guarded(this.watchPlanner(task.id, paseo.agents.ref(state.plannerId) as unknown as SessionHandle), task.id);
    if (state.phase === "implementing") {
      for (const c of state.candidates)
        if (c.status === "working" && c.agentId && !this.watching.has(`${task.id}:${c.id}`)) this.guarded(this.watchCandidate(task.id, c.id, paseo.agents.ref(c.agentId) as unknown as SessionHandle), task.id);
      await this.judging(board, task, project);
    }
    if (state.phase === "judging" && state.judgeId) this.judges.add(state.judgeId);
    if (state.phase === "judging" && state.judgeId && !this.watching.has(`${task.id}:judge`))
      this.guarded(this.watchJudge(task.id, paseo.agents.ref(state.judgeId) as unknown as SessionHandle), task.id);
  }

  private async watchPlanner(taskId: string, handle: SessionHandle) {
    const key = `${taskId}:planner`;
    this.watching.add(key);
    try {
      const { result } = await finishTurn(handle, this.timeout, "Nobody answers permission requests for the planner, so this one is refused: read what you can and write the plans.", taskId);
      await this.planned(taskId, result.status === "idle" && !result.error ? undefined : result.error || `The planner ended with status ${result.status}.`);
    } finally { this.watching.delete(key); }
  }

  /** The plans are written (or the planner failed: the candidates then choose their own approaches). */
  private async planned(taskId: string, error?: string) {
    const p = this.paths(taskId);
    const state = await this.state(taskId);
    if (!state || state.phase !== "planning") return;
    const text = error ? "" : await readFile(p.plans, "utf8").catch(() => "");
    const skip = SKIP.exec(text);
    if (state.plannerWorkspaceId) await this.paseo!.workspaces.archive(state.plannerWorkspaceId).catch((e) => logFailure("Flowly could not archive the tournament planner:", e, taskId));
    await rm(p.env, { recursive: true, force: true });
    if (skip) {
      const reason = clip(skip[1]!.trim() || "the delivery is mostly outside the workspace", 500);
      await this.update(taskId, (s) => ({ ...s, phase: "skipped", detail: `Planner: ${reason}` }));
      return this.hooks?.fallback(taskId, state.generation, `No tournament for this card (the planner: ${reason}); one implementer works on it as usual.`);
    }
    const plans = text.split(/^##\s*Plan\s+\d+\b.*$/im).slice(1).map((section) => section.trim()).filter(Boolean);
    await this.update(taskId, (s) => ({
      ...s, phase: "implementing",
      candidates: s.candidates.map((c, i) => ({ ...c, ...(plans[i] ? { plan: clip(plans[i]!, 20000) } : {}) })),
      ...(error || plans.length < s.size ? { detail: error ? `Planner failed (${clip(error, 300)}); candidates choose their own approaches.` : `The planner wrote ${plans.length} of ${s.size} plans.` } : {}),
    }));
    await this.startCandidates(taskId);
  }

  private async startCandidates(taskId: string) {
    const board = await this.board!();
    const job = jobOf(board, taskId), task = board.tasks.find((t) => t.id === taskId);
    const project = task && board.projects.find((p) => p.id === task.projectId);
    const state = await this.state(taskId);
    if (!state || !task || !project || !job || job.generation !== state.generation) return;
    const model = this.model(project, "candidate");
    const suite = this.acceptance ? join(this.directory, "acceptance", taskId, "suite") : join(this.paths(taskId).root, "no-acceptance");
    for (const c of state.candidates) {
      if (c.status !== "waiting") continue;
      const dir = this.paths(taskId).candidate(c.id);
      try {
        if (!model) throw new Error("No model for the candidates.");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await this.copy(this.paths(taskId).pristine, dir);
        const created = await this.session(task, project, dir, `Candidate ${c.id}: ${task.title}`, `candidate-${c.id}`, candidatePrompt(task, this.comments(board, taskId), { id: c.id, plan: c.plan, dir, workspace: state.workspace, suite }), model);
        await this.update(taskId, (s) => ({ ...s, candidates: s.candidates.map((x) => (x.id === c.id ? { ...x, status: "working" as const, agentId: created.handle.id, workspaceId: created.workspaceId, startedAt: new Date().toISOString() } : x)) }));
        this.guarded(this.watchCandidate(taskId, c.id, created.handle), taskId);
      } catch (e) {
        logFailure("Flowly tournament candidate not started:", e, taskId);
        await this.update(taskId, (s) => ({ ...s, candidates: s.candidates.map((x) => (x.id === c.id ? { ...x, status: "failed" as const, note: `Not started: ${e instanceof Error ? e.message : String(e)}`, finishedAt: new Date().toISOString() } : x)) }));
      }
    }
  }

  private async watchCandidate(taskId: string, id: string, handle: SessionHandle) {
    const key = `${taskId}:${id}`;
    this.watching.add(key);
    try {
      const { result } = await finishTurn(handle, this.timeout, "Nobody answers permission requests for tournament candidates, so this one is refused: do it another way inside your copy (or in flowly-apply.sh) and go on.", taskId);
      const ok = result.status === "idle" && !result.error;
      const files = await this.manifest(this.paths(taskId).candidate(id)).catch(() => undefined);
      const state = await this.update(taskId, (s) => ({
        ...s,
        candidates: s.candidates.map((c) => (c.id === id ? { ...c, status: ok ? "delivered" as const : "failed" as const, finishedAt: new Date().toISOString(), note: clip(ok ? result.lastMessage ?? "" : result.error || `Ended with status ${result.status}.`, 8000), ...(files ? { files } : {}) } : c)),
      }));
      const workspaceId = state?.candidates.find((c) => c.id === id)?.workspaceId;
      if (workspaceId) await this.paseo!.workspaces.archive(workspaceId).catch((e) => logFailure("Flowly could not archive a tournament candidate:", e, taskId));
      const board = await this.board!();
      const task = board.tasks.find((t) => t.id === taskId);
      const project = task && board.projects.find((p) => p.id === task.projectId);
      if (task && project) await this.judging(board, task, project);
    } finally { this.watching.delete(key); }
  }

  /** Every file of a candidate's tree with its size and hash, for replaying and comparing candidates later. */
  private async manifest(dir: string) {
    const out: { path: string; size: number; sha256: string }[] = [];
    for (const file of (await walk(dir)).slice(0, 50000)) {
      const data = await readFile(file).catch(() => null);
      if (data) out.push({ path: relative(dir, file), size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    }
    return out;
  }

  /** All candidates finished and the acceptance tests are no longer being written: the judge starts (or nobody delivered). */
  private async judging(board: Board, task: Task, project: Project) {
    if (this.advancing.has(task.id)) return;
    this.advancing.add(task.id);
    try {
      const state = await this.state(task.id);
      if (!state || state.phase !== "implementing" || state.candidates.some((c) => c.status === "waiting" || c.status === "working")) return;
      const tests = automationOf(project)?.acceptance && this.acceptance ? await this.acceptance.state(task.id).catch(() => null) : null;
      if (tests && tests.generation === state.generation && tests.status === "writing") return;
      const delivered = state.candidates.filter((c) => c.status === "delivered");
      if (!delivered.length) return this.fail(task.id, state.generation, "No candidate delivered; one implementer works on the card as usual.");
      const model = this.model(project, "judge");
      if (!model) return this.fail(task.id, state.generation, "No model for the judge; one implementer works on the card as usual.");
      const context = tests?.status === "ready" ? await this.acceptance!.context(task.id, true, state.workspace) : null;
      const prompt = judgePrompt(task, this.comments(board, task.id), {
        workspace: state.workspace,
        candidates: delivered.map((c) => ({ id: c.id, dir: this.paths(task.id).candidate(c.id), note: c.note, plan: c.plan })),
        failed: state.candidates.filter((c) => c.status === "failed").map((c) => c.id),
        ...(context ? { run: context.run, holdoutRun: context.holdoutRun, requirements: context.requirements } : {}),
      });
      await this.update(task.id, (s) => ({ ...s, phase: "judging" }));
      // Registered before the session starts: its first tool listing must already offer the judge's tools.
      const judgeId = await this.hooks!.createJudge(task.id, state.generation, prompt, model, (id) => this.judges.add(id));
      if (!judgeId) return;
      await this.update(task.id, (s) => ({ ...s, judgeId }));
      this.guarded(this.watchJudge(task.id, this.paseo!.agents.ref(judgeId) as unknown as SessionHandle), task.id);
    } finally { this.advancing.delete(task.id); }
  }

  private async watchJudge(taskId: string, handle: SessionHandle & { send?: (text: string, options: { activeTurnBehavior: "steer"; messageId: string }) => Promise<unknown> }) {
    const key = `${taskId}:judge`;
    this.watching.add(key);
    try {
      for (;;) {
        await finishTurn(handle, this.timeout, "Nobody answers permission requests for the judge, so this one is refused: do it another way and go on judging.", taskId);
        const state = await this.state(taskId);
        if (!state || state.phase !== "judging") return;
        if (!state.judgeReminded && handle.send) {
          await this.update(taskId, (s) => ({ ...s, judgeReminded: true }));
          await handle.send("[Flowly tournament] Your turn ended without a judgement. Finish judging: activate the winner last, run its flowly-apply.sh and both suites, then call flowly_submit_judgement.", { activeTurnBehavior: "steer", messageId: randomUUID() })
            .catch((e) => logFailure("Flowly could not remind the tournament judge:", e, taskId));
          continue;
        }
        // No judgement after the reminder: the candidate with the fewest problems known so far wins, recorded as such.
        const winner = state.candidates.find((c) => c.status === "delivered")!;
        try {
          await this.activate(taskId, null, winner.id);
        } catch (e) {
          await this.fail(taskId, state.generation, `The judge did not submit a judgement and ${winner.id} could not be activated (${e instanceof Error ? e.message : String(e)}); one implementer works on the card as usual.`);
          return;
        }
        await this.decide(taskId, { winner: winner.id, detail: "The judge did not submit a judgement; the first delivered candidate was activated without a comparison." });
        return;
      }
    } finally { this.watching.delete(key); }
  }

  /** Puts a candidate's tree in the card's real workspace (flowly_tournament_activate, and the winner at the end). */
  async activate(taskId: string, agentId: string | null, candidate: string) {
    const state = await this.state(taskId);
    if (!state || state.phase !== "judging") throw new ToolError("TOURNAMENT_CLOSED", "This card has no tournament being judged.");
    if (agentId !== null && state.judgeId !== agentId) throw new ToolError("NOT_JUDGE", "Only the tournament's judge session can activate candidates.");
    const c = state.candidates.find((x) => x.id === candidate);
    if (!c || c.status !== "delivered") throw new ToolError("UNKNOWN_CANDIDATE", `Delivered candidates: ${state.candidates.filter((x) => x.status === "delivered").map((x) => x.id).join(", ")}.`);
    const target = resolve(state.workspace);
    if (!replaceableFolder(target) || !(await stat(target).then((s) => s.isDirectory(), () => false)))
      throw new ToolError("WORKSPACE_UNAVAILABLE", `Refusing to replace ${target}: it is missing, the filesystem root, the home folder or a system folder.`);
    for (const entry of await readdir(target)) await rm(join(target, entry), { recursive: true, force: true });
    await this.copy(this.paths(taskId).candidate(candidate), target);
    await this.update(taskId, (s) => ({ ...s, active: candidate, activations: [...s.activations, { candidate, at: new Date().toISOString(), by: agentId ?? "flowly" }].slice(-200) }));
    return {
      active: candidate,
      workspace: target,
      message: `Candidate ${candidate} is now in ${target}. Run its flowly-apply.sh if it has one, stop processes the previous candidate started, then run the suites and your probes there.`,
    };
  }

  private async restorePristine(state: TournamentState) {
    const target = resolve(state.workspace);
    if (!replaceableFolder(target) || !(await stat(target).then((s) => s.isDirectory(), () => false))) throw new Error(`Refusing to replace ${target}.`);
    for (const entry of await readdir(target)) await rm(join(target, entry), { recursive: true, force: true });
    await this.copy(this.paths(state.taskId).pristine, target);
  }

  /** flowly_submit_judgement: Flowly holds the judge to the elimination rule and to measuring the winner last (§5.5). */
  async submit(taskId: string, agentId: string, raw: JudgementInput) {
    const input = judgementInputSchema.parse(raw);
    const state = await this.state(taskId);
    if (!state || state.phase !== "judging") throw new ToolError("TOURNAMENT_CLOSED", "This card has no tournament being judged; nothing was recorded.");
    if (state.judgeId !== agentId) throw new ToolError("NOT_JUDGE", "Only the tournament's judge session can submit the judgement.");
    const delivered = new Set(state.candidates.filter((c) => c.status === "delivered").map((c) => c.id));
    const fail = (code: string, message: string): never => { throw new ToolError(code, `${message} Nothing was recorded.`); };
    if (!delivered.has(input.winner)) fail("UNKNOWN_CANDIDATE", `The winner must be a delivered candidate (${[...delivered].join(", ")}).`);
    for (const c of input.candidates) if (!delivered.has(c.id)) fail("UNKNOWN_CANDIDATE", `${c.id} is not a delivered candidate.`);
    for (const d of input.disagreements) if (!delivered.has(d.ruling)) fail("UNKNOWN_CANDIDATE", `A disagreement rules for ${d.ruling}, which is not a delivered candidate.`);
    const tests = this.acceptance ? await this.acceptance.state(taskId).catch(() => null) : null;
    if (tests?.status === "ready" && tests.generation === state.generation) {
      const missing = [...delivered].filter((id) => { const c = input.candidates.find((x) => x.id === id); return !c?.visible || !c.holdout; });
      if (missing.length) fail("ACCEPTANCE_REQUIRED", `Run both acceptance suites on every candidate and send their counts: missing for ${missing.join(", ")}.`);
      if (!input.final) fail("ACCEPTANCE_REQUIRED", "Send final: the winner's counts from your last run of both suites.");
      // Failing checks eliminate; disputed ones (each with the card text it contradicts) do not count (§5.5).
      const failures = (id: string) => { const c = input.candidates.find((x) => x.id === id)!; return Math.max(0, c.visible!.failed + c.holdout!.failed - (c.disputed?.length ?? 0)); };
      const fewest = Math.min(...[...delivered].map(failures));
      if (failures(input.winner) > fewest) fail("TOURNAMENT_ELIMINATED", `${input.winner} has ${failures(input.winner)} undisputed failing checks; another candidate has ${fewest}. Pick among the candidates with the fewest, or dispute wrong checks with the card text they contradict.`);
    }
    if (state.active !== input.winner) fail("WINNER_NOT_ACTIVE", `Activate ${input.winner} last, run its flowly-apply.sh and both suites, then submit with those counts as final.`);
    await this.decide(taskId, { winner: input.winner, judgement: input, ...(input.final ? { final: input.final } : {}) });
    return { accepted: true, winner: input.winner, message: `Recorded. ${input.winner} stays in the workspace and is delivered; end your turn.` };
  }

  private async decide(taskId: string, result: { winner: string; judgement?: unknown; final?: TournamentState["final"]; detail?: string }) {
    const state = await this.update(taskId, (s) => { if (s.judgeId) this.judges.delete(s.judgeId); return { ...s, phase: "decided", winner: result.winner, decidedAt: new Date().toISOString(), ...(result.judgement ? { judgement: result.judgement } : {}), ...(result.final ? { final: result.final } : {}), ...(result.detail ? { detail: result.detail } : {}) }; });
    if (!state) return;
    const j = result.judgement as z.infer<typeof judgementInputSchema> | undefined;
    const counts = j?.candidates.map((c) => `${c.id}${c.visible && c.holdout ? ` ${c.visible.passed + c.holdout.passed}/${c.visible.failed + c.holdout.failed}${c.disputed?.length ? ` (${c.disputed.length} disputed)` : ""}` : ""}`).join(", ");
    const note = [
      `Tournament of ${state.size}: ${result.winner} delivered${counts ? ` (acceptance passed/failed: ${counts})` : ""}.`,
      j ? `${j.disagreements.length} disagreement${j.disagreements.length === 1 ? "" : "s"} ruled. ${j.summary}` : result.detail,
      state.candidates.filter((c) => c.status === "failed").length ? `Out: ${state.candidates.filter((c) => c.status === "failed").map((c) => c.id).join(", ")}.` : "",
    ].filter(Boolean).join("\n\n");
    await this.hooks?.decided(taskId, state.generation, clip(note, 10000));
  }

  private async fail(taskId: string, generation: number, detail: string) {
    const state = await this.state(taskId).catch(() => null);
    // A judge may have left a candidate (or half of one) in the workspace: the implementer starts from the original.
    if (state && state.generation === generation && state.phase === "judging" && state.activations.length)
      await this.restorePristine(state).catch((e) => logFailure("Flowly could not put the original workspace back:", e, taskId));
    if (state && state.generation === generation) await this.update(taskId, (s) => ({ ...s, phase: "failed", detail }));
    else await this.save({ version: 1, taskId, generation, size: 0, phase: "failed", workspace: "", startedAt: new Date().toISOString(), candidates: [], activations: [], detail });
    await this.hooks?.fallback(taskId, generation, detail);
  }
}
