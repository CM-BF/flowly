import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentModel } from "../shared/agent-defaults";
import { laneEnabled } from "../shared/lanes";
import { isWorkStatus, type Board, type Project, type Task } from "../shared/model";
import type { ToolIdentity, ToolPreparation } from "../shared/tools";
import {
  activeAgent,
  automationOf,
  changesPrompt,
  dispatchPlan,
  isLive,
  jobOf,
  nudgePrompt,
  readiness,
  retryDelayMs,
  retryPrompt,
  reviewInputSchema,
  reviewPrompt,
  startPrompt,
  turnDecision,
  unattendedModes,
  type AutomationCode,
  type AutomationJob,
  type AutomationSettings,
  type ReviewInput,
  type TurnDecision,
  type TurnOutcome,
} from "../shared/automation";
import { resumeStage } from "./progress-rules";
import type { BoardStore } from "./store";
import { ToolError } from "./tool-error";

type Role = AutomationJob["role"];
export type AutomationDeps = {
  /** Prepares a Flowly-managed session of the card (ToolServer.prepareSession): its id, tools and instructions. */
  prepare(taskId: string, operationId: string, paseo: PaseoApi): Promise<ToolPreparation>;
  /** The global default model (Settings → Models), or null. */
  globalModel(): Promise<AgentModel | null>;
  clock?: () => number;
  /** Dispatcher period; the dispatcher also runs on every queue, stop, turn end and card move. */
  intervalMs?: number;
  /** A session still `starting` after this long is created again (idempotently). */
  staleStartMs?: number;
};

/** Short tail for event notes and the job's detail. */
const clip = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Agent automation (AUTOMATION-SPEC): Hermes Kanban's dispatcher, worker
 * supervision and review loop on Flowly cards. All state lives in the board
 * (one transaction with the card); side effects (creating a session, sending
 * it a message) happen after the commit, and a session being created is
 * recorded first so a restart creates the same one again instead of a second.
 */
export class AutomationService {
  private paseo?: PaseoApi;
  private timer?: ReturnType<typeof setInterval>;
  private ticking: Promise<void> | null = null;
  private again = false;
  private readonly clock: () => number;
  constructor(
    readonly store: BoardStore,
    private readonly deps: AutomationDeps,
  ) {
    this.clock = deps.clock ?? (() => Date.now());
  }
  attach(paseo: PaseoApi) {
    const first = !this.paseo;
    this.paseo = paseo;
    // Work queued before a restart starts once the daemon hands us a connection.
    if (first) void this.kick();
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.kick(), this.deps.intervalMs ?? 15_000);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private api() {
    if (!this.paseo) throw new Error("Paseo context is not ready yet.");
    return this.paseo;
  }

  /** Runs a dispatcher pass; calls during a pass coalesce into one more pass. */
  kick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.again = false;
        await this.tick().catch((e) => console.error("Flowly automation pass failed:", e instanceof Error ? e.message : String(e)));
      } while (this.again);
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async tick() {
    if (!this.paseo) return;
    await this.reconcile();
    const plan = dispatchPlan(await this.store.read(), this.clock());
    for (const job of plan.retry) await this.resume(job);
    for (const job of plan.start) await this.begin(job);
  }

  // ---- People's actions -------------------------------------------------

  /** "Run with agent": queue the card (Hermes `assign`). Keeps the implementer session of an earlier run. */
  queue(taskId: string) {
    return this.store
      .transaction((board) => {
        const task = board.tasks.find((t) => t.id === taskId);
        const project = task && board.projects.find((p) => p.id === task.projectId);
        if (!task || !project) throw new Error("Task not found.");
        if (task.archivedAt || project.archivedAt) throw new Error("Archived cards can't be run.");
        if (task.status === "done" || task.status === "cancelled") throw new Error("Move the card out of Done or Cancelled before running it.");
        if (!automationOf(project)) throw new Error("Turn on agent automation for this project first (Edit project → Agent automation).");
        const existing = jobOf(board, taskId);
        if (isLive(existing)) throw new Error("This card is already queued or running.");
        const now = this.now();
        const job: AutomationJob = {
          taskId,
          projectId: project.id,
          state: "queued",
          role: "implementer",
          ...(existing?.implementerId ? { implementerId: existing.implementerId } : {}),
          generation: (existing?.generation ?? 0) + 1,
          nudges: 0,
          failures: 0,
          reviewRounds: 0,
          queuedAt: now,
          updatedAt: now,
        };
        board.automation = [...board.automation.filter((j) => j.taskId !== taskId), job];
        this.store.event(board, { taskId, actor: "human", action: "automation_queued" });
        return { value: job, changed: true };
      })
      .then((job) => {
        void this.kick();
        return job;
      });
  }

  /** "Stop automation": no more dispatch, reminders or reviews. Running sessions are left alone. */
  stopJob(taskId: string) {
    return this.store.transaction((board) => {
      const job = jobOf(board, taskId);
      if (!job || !isLive(job)) return { value: job ?? null, changed: false };
      this.close(job, "stopped", "stopped");
      this.store.event(board, { taskId, actor: "human", action: "automation_stopped" });
      return { value: job, changed: true };
    });
  }

  /**
   * A person moved the card. Done/Cancelled ends the job; Backlog ends it too,
   * and so do Todo and Blocked once an agent is on it (that is the person taking
   * the card back). Moves between work stages are the agent's business.
   */
  async humanMoved(taskId: string, previous: string | undefined, next: string) {
    if (previous === next) return;
    const changed = await this.store.transaction((board) => {
      const job = jobOf(board, taskId);
      if (!job || !isLive(job)) return { value: false, changed: false };
      const finished = next === "done" || next === "cancelled";
      const taken = next === "backlog" || ((next === "todo" || next === "blocked") && job.state !== "queued");
      if (!finished && !taken) return { value: false, changed: false };
      this.close(job, "stopped", finished ? "card_finished" : "card_moved");
      this.store.event(board, { taskId, actor: "system", action: "automation_stopped", note: finished ? "The card was finished" : "The card was moved" });
      return { value: true, changed: true };
    });
    if (changed) void this.kick();
  }

  // ---- Session lifecycle (hooks) ----------------------------------------

  /** A supervised session started a turn: a person answered it, or the first instruction arrived. */
  async turnStarted(agentId: string) {
    await this.store.transaction((board) => {
      const job = board.automation.find(
        (j) =>
          (activeAgent(j) === agentId && (j.state === "needs_human" || j.state === "starting")) ||
          // Feedback after a delivery: the implementer works again, and its next delivery is reviewed again (Hermes reopen-review).
          (j.state === "delivered" && j.implementerId === agentId),
      );
      if (!job) return { value: null, changed: false };
      const project = board.projects.find((p) => p.id === job.projectId);
      if (!automationOf(project)) return { value: null, changed: false };
      if (job.state === "delivered") {
        const task = board.tasks.find((t) => t.id === job.taskId);
        if (!task || task.archivedAt || task.status === "done" || task.status === "cancelled") return { value: null, changed: false };
        job.role = "implementer";
        job.reviewRounds = 0;
        delete job.verdict;
        this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_resumed", agentId });
      }
      job.state = job.role === "reviewer" ? "reviewing" : "working";
      job.nudges = 0;
      delete job.code;
      job.updatedAt = this.now();
      return { value: job, changed: true };
    });
  }

  /** A supervised session asked for a permission (its turn is paused), or the request was answered. */
  async permission(agentId: string, open: boolean) {
    await this.store.transaction((board) => {
      const job = board.automation.find((j) => activeAgent(j) === agentId && isLive(j));
      if (!job) return { value: null, changed: false };
      if (open && (job.state === "working" || job.state === "reviewing")) {
        job.state = "needs_human";
        job.code = "permission";
      } else if (!open && job.state === "needs_human" && job.code === "permission") {
        job.state = job.role === "reviewer" ? "reviewing" : "working";
        delete job.code;
      } else return { value: null, changed: false };
      job.updatedAt = this.now();
      return { value: job, changed: true };
    });
  }

  /**
   * A supervised session's turn ended. The outcome is read from the board's
   * lifecycle event (recorded by the turn hook just before), so the hook and the
   * reconcile pass share one path and `turnAt` keeps either from handling it twice.
   */
  async turnEnded(agentId: string) {
    const board = await this.store.read();
    const job = board.automation.find((j) => activeAgent(j) === agentId && ["starting", "working", "reviewing", "needs_human"].includes(j.state));
    if (!job) return;
    const ended = latestTurnEnd(board, job.taskId, agentId);
    if (!ended || (job.turnAt && ended.at <= job.turnAt)) return;
    const settings = automationOf(board.projects.find((p) => p.id === job.projectId));
    // Automation turned off: the session goes on unsupervised.
    if (!settings) return;
    const outcome: TurnOutcome =
      ended.outcome === "failed" ? { kind: "failed", message: ended.note ?? "" } : ended.outcome === "canceled" ? { kind: "canceled" } : { kind: "completed" };
    const decision = turnDecision(board, job, agentId, outcome, settings, this.clock());
    const applied = await this.apply(job, agentId, ended.at, decision, settings, outcome);
    if (applied) await this.followUp(applied, decision, settings, outcome);
    void this.kick();
  }

  /** Commits a turn decision; null when the job moved on meanwhile. */
  private apply(seen: AutomationJob, agentId: string, endedAt: string, decision: TurnDecision, settings: AutomationSettings, outcome: TurnOutcome) {
    return this.store.transaction((board) => {
      const job = jobOf(board, seen.taskId);
      if (!job || job.generation !== seen.generation || activeAgent(job) !== agentId || (job.turnAt && endedAt <= job.turnAt))
        return { value: null, changed: false };
      const task = board.tasks.find((t) => t.id === job.taskId)!;
      const now = this.now();
      job.turnAt = endedAt;
      job.updatedAt = now;
      const note = (action: string, text?: string) => this.store.event(board, { taskId: job.taskId, actor: "system", action, agentId, ...(text ? { note: text } : {}) });
      switch (decision.kind) {
        case "ignore":
          return { value: null, changed: false };
        case "review":
          job.role = "reviewer";
          job.state = "reviewing";
          job.reviewRounds++;
          job.nudges = 0;
          job.failures = 0;
          job.turnAt = now;
          delete job.verdict;
          delete job.code;
          note("automation_review_started", `Review round ${job.reviewRounds} of ${settings.maxReviewRounds}`);
          break;
        case "deliver":
          job.state = "delivered";
          job.nudges = 0;
          job.failures = 0;
          if (decision.code) job.code = decision.code;
          else delete job.code;
          note("automation_delivered", decision.code === "review_rounds" ? `Review rounds used up (${settings.maxReviewRounds}); the card waits for you` : undefined);
          break;
        case "wait":
          job.state = "needs_human";
          job.code = decision.code;
          break;
        case "stop":
          this.close(job, "stopped", decision.code);
          note("automation_stopped", decision.code === "card_finished" ? "The card was finished" : "The card was moved");
          break;
        case "nudge":
          job.nudges = decision.count;
          job.turnAt = now;
          note("automation_nudged", `Reminder ${decision.count} of ${settings.nudgeLimit}`);
          break;
        case "retry":
          job.state = "retry_wait";
          job.failures = decision.count;
          job.retryAt = decision.at;
          job.code = "failed";
          job.detail = clip(outcome.kind === "failed" ? outcome.message : "");
          note("automation_retry", `Turn failed (${decision.count} of ${settings.failureLimit}); retrying${job.detail ? `: ${job.detail}` : ""}`);
          break;
        case "give_up": {
          job.failures += outcome.kind === "failed" ? 1 : 0;
          if (outcome.kind === "failed") job.detail = clip(outcome.message);
          if (job.role === "reviewer") {
            // The delivery stands; the user reviews it (the card stays In review).
            job.role = "implementer";
            job.state = "delivered";
            job.verdict = "incomplete";
            job.code = decision.code;
          } else this.close(job, "failed", decision.code);
          const why = giveUpNote(decision.code, settings);
          note("automation_failed", why);
          if (decision.blockCard) this.blockCard(board, task, `Agent automation stopped: ${why}`, agentId);
          break;
        }
      }
      return { value: { ...job }, changed: true };
    });
  }

  /** The message or session a committed decision calls for. */
  private async followUp(job: AutomationJob, decision: TurnDecision, settings: AutomationSettings, _outcome: TurnOutcome) {
    if (decision.kind === "nudge") await this.send(job, job.role, nudgePrompt(decision.count, settings.nudgeLimit));
    if (decision.kind === "review") await this.send(job, "reviewer", reviewPrompt(job.reviewRounds, settings.maxReviewRounds));
  }

  // ---- The reviewer's verdict (flowly_submit_review) --------------------

  async submitReview(identity: ToolIdentity, raw: ReviewInput) {
    const input = reviewInputSchema.parse(raw);
    type Answer = { accepted: boolean; verdict: "approve" | "changes"; replayed?: boolean; message: string };
    const result = await this.store.transaction<{ answer: Answer; changes?: { job: AutomationJob; prompt: string } }>((board) => {
      const job = jobOf(board, identity.taskId);
      if (!job || job.reviewerId !== identity.agentId)
        throw new ToolError("NOT_REVIEWER", "Only the reviewer session that Flowly's agent automation started for this card can submit a review.");
      const verdict = input.verdict === "approve" ? "approved" : "changes";
      if (job.role !== "reviewer" || !["reviewing", "needs_human"].includes(job.state)) {
        // A repeated call after a lost response: the same verdict is acknowledged, a different one is refused.
        if (job.verdict === verdict)
          return { value: { answer: { accepted: true, verdict: input.verdict, replayed: true, message: "This verdict was already recorded." } }, changed: false };
        throw new ToolError("REVIEW_CLOSED", "This review round is already closed; nothing was changed.");
      }
      const task = board.tasks.find((t) => t.id === job.taskId);
      const project = task && board.projects.find((p) => p.id === task.projectId);
      if (!task || !project || task.status !== "in_review")
        throw new ToolError("REVIEW_CLOSED", "The card is no longer In review; nothing was changed.");
      const now = this.now();
      const text = [input.summary, ...input.findings.map((f) => `- ${f}`)].join("\n");
      job.verdict = verdict;
      job.detail = clip(input.summary);
      job.updatedAt = now;
      job.nudges = 0;
      job.failures = 0;
      job.role = "implementer";
      delete job.code;
      if (verdict === "approved") {
        job.state = "delivered";
        this.store.event(board, { taskId: task.id, actor: "agent", agentId: identity.agentId, action: "automation_review_approved", note: clip(text, 4000) });
        return { value: { answer: { accepted: true, verdict: input.verdict, message: "Approved. The card stays In review for the user to accept; end your turn." } }, changed: true };
      }
      job.state = "working";
      job.turnAt = now;
      this.store.event(board, { taskId: task.id, actor: "agent", agentId: identity.agentId, action: "automation_changes_requested", note: clip(text, 4000) });
      // Back to work: the same stage a person's review feedback leads to (rule A1).
      const stage = resumeStage(board, task, project);
      if (stage && stage !== task.status) {
        const from = task.status;
        task.status = stage;
        task.revision++;
        task.updatedAt = now;
        this.store.event(board, { taskId: task.id, actor: "system", action: "status_changed", agentId: identity.agentId, rule: "REVIEW", from, to: stage, note: "The reviewer requested changes" });
      }
      const max = automationOf(project)?.maxReviewRounds ?? job.reviewRounds;
      return {
        value: {
          answer: { accepted: true, verdict: input.verdict, message: "Changes requested. Flowly sends your findings to the implementer; end your turn." },
          changes: { job: { ...job }, prompt: changesPrompt(job.reviewRounds, max, input.summary, input.findings) },
        },
        changed: true,
      };
    });
    if (result.changes) void this.send(result.changes.job, "implementer", result.changes.prompt);
    return result.answer;
  }

  // ---- Dispatcher -------------------------------------------------------

  /** Claims a queued card and starts (or reuses) its implementer session. */
  private async begin(seen: AutomationJob) {
    const claimed = await this.store.transaction((board) => {
      const job = jobOf(board, seen.taskId);
      if (!job || job.generation !== seen.generation || job.state !== "queued" || !readiness(board, job.taskId).ready) return { value: null, changed: false };
      const now = this.now();
      job.state = "starting";
      job.role = "implementer";
      job.startedAt = now;
      job.turnAt = now;
      job.updatedAt = now;
      this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_started" });
      return { value: { ...job }, changed: true };
    });
    if (!claimed) return;
    const settings = await this.settingsOf(claimed);
    const again = !!claimed.implementerId;
    await this.send(claimed, "implementer", startPrompt({ review: !!settings?.reviewer, again }), startPrompt({ review: !!settings?.reviewer, again: false }));
  }

  /** A due retry: the same session is told to continue (or created, when it never started). */
  private async resume(seen: AutomationJob) {
    const job = await this.store.transaction((board) => {
      const job = jobOf(board, seen.taskId);
      if (!job || job.generation !== seen.generation || job.state !== "retry_wait") return { value: null, changed: false };
      job.state = job.role === "reviewer" ? "reviewing" : "working";
      job.turnAt = this.now();
      job.updatedAt = job.turnAt;
      delete job.retryAt;
      return { value: { ...job }, changed: true };
    });
    if (!job) return;
    const settings = await this.settingsOf(job);
    if (!settings) return;
    const fresh = job.role === "reviewer" ? reviewPrompt(job.reviewRounds, settings.maxReviewRounds) : startPrompt({ review: !!settings.reviewer, again: false });
    await this.send(job, job.role, retryPrompt(job.failures, settings.failureLimit, job.detail ?? ""), fresh);
  }

  private async settingsOf(job: AutomationJob) {
    return automationOf((await this.store.read()).projects.find((p) => p.id === job.projectId));
  }

  /**
   * Gives `role`'s session of the job `text`: sent to the live session, or the
   * first instruction of a new one (`fresh`, defaulting to `text`). A failure
   * counts as a failed turn.
   */
  private async send(job: AutomationJob, role: Role, text: string, fresh = text) {
    try {
      const paseo = this.api();
      const board = await this.store.read();
      const current = jobOf(board, job.taskId);
      const task = board.tasks.find((t) => t.id === job.taskId);
      const project = task && board.projects.find((p) => p.id === task.projectId);
      if (!current || current.generation !== job.generation || !task || !project) return;
      const id = role === "reviewer" ? current.reviewerId : current.implementerId;
      if (current.pendingOp) return await this.create(current, role, current.pendingOp, fresh, task, project, paseo);
      if (id) {
        const agent = (await paseo.agents.ref(id).refresh().catch(() => null))?.agent;
        if (agent && !agent.archivedAt && agent.workspaceId === task.workspaceId) {
          await paseo.agents.ref(id).send(text);
          await this.started(current, id);
          return;
        }
        // The implementer of a running job is gone: that is not a new start.
        if (role === "implementer" && current.state !== "starting") throw new SessionGone();
      }
      const op = `automation:${task.id}:${randomUUID()}`;
      const recorded = await this.store.transaction((board) => {
        const j = jobOf(board, job.taskId);
        if (!j || j.generation !== job.generation) return { value: false, changed: false };
        j.pendingOp = op;
        return { value: true, changed: true };
      });
      if (recorded) await this.create(current, role, op, fresh, task, project, paseo);
    } catch (e) {
      await this.sideEffectFailed(job, role, e);
    }
  }

  private async create(job: AutomationJob, role: Role, op: string, prompt: string, task: Task, project: Project, paseo: PaseoApi) {
    const settings = automationOf(project);
    const preparation = await this.deps.prepare(task.id, op, paseo);
    await this.store.transaction((board) => {
      const j = jobOf(board, job.taskId);
      if (!j || j.generation !== job.generation) return { value: null, changed: false };
      if (role === "reviewer") j.reviewerId = preparation.agentId;
      else j.implementerId = preparation.agentId;
      return { value: null, changed: true };
    });
    const model = role === "reviewer" ? settings?.reviewer : await this.implementerModel(project, settings, paseo);
    if (!model) throw new Error(role === "reviewer" ? "No reviewer model is set." : "No available model to start an agent with.");
    const mode = settings?.fullAccess ? unattendedModes[model.provider] : undefined;
    const options = {
      config: {
        provider: `${model.provider}/${model.model}`,
        systemPrompt: preparation.instructions,
        mcpServers: { flowly: preparation.mcp },
        ...(mode ? { modeId: mode } : {}),
        ...(model.thinking ? { thinkingOptionId: model.thinking } : {}),
      },
      agentId: preparation.agentId,
      idempotencyKey: `ultra-kanban-session:${preparation.agentId}`,
      env: { FLOWLY_CONTEXT_FILE: preparation.contextFile, FLOWLY_CLI: preparation.cliPath, FLOWLY_SKILL: preparation.skillPath },
      title: (role === "reviewer" ? `Review: ${task.title}` : task.title).slice(0, 120),
      labels: { "flowly-task": task.id, "flowly-automation": role },
      prompt,
    };
    // A failed response can hide a created session (client/session.ts createPreparedSession).
    const exists = async () => {
      const agent = (await paseo.agents.ref(preparation.agentId).refresh().catch(() => null))?.agent;
      if (agent && (agent.workspaceId !== task.workspaceId || agent.archivedAt)) throw new Error("The prepared session belongs to another workspace or is archived.");
      return !!agent;
    };
    if (!(await exists()))
      try {
        await paseo.workspaces.ref(task.workspaceId).agents.create(options);
      } catch (e) {
        if (!(await exists())) throw e;
      }
    await this.store.transaction((board) => {
      const j = jobOf(board, job.taskId);
      if (!j || j.pendingOp !== op) return { value: null, changed: false };
      delete j.pendingOp;
      if (j.state === "starting") j.state = "working";
      j.updatedAt = this.now();
      return { value: null, changed: true };
    });
  }

  /** The first instruction reached the session. */
  private started(job: AutomationJob, agentId: string) {
    return this.store.transaction((board) => {
      const j = jobOf(board, job.taskId);
      if (!j || j.generation !== job.generation || j.state !== "starting" || j.implementerId !== agentId) return { value: null, changed: false };
      j.state = "working";
      j.updatedAt = this.now();
      return { value: null, changed: true };
    });
  }

  /** The implementer's model: the automation's own, else the project's default, the global default, the first available. */
  private async implementerModel(project: Project, settings: AutomationSettings | null, paseo: PaseoApi): Promise<AgentModel | null> {
    const chosen = settings?.implementer ?? project.agentModel ?? (await this.deps.globalModel().catch(() => null));
    if (chosen) return chosen;
    const available = (await paseo.providers.listAvailable()).providers.filter((p) => p.available).map((p) => p.provider);
    for (const provider of [...["codex", "claude"].filter((p) => available.includes(p)), ...available.filter((p) => p !== "codex" && p !== "claude")]) {
      const models = (await paseo.providers.listModels(provider).catch(() => null))?.models?.filter((m) => m.isSelectable !== false) ?? [];
      const pick = models.find((m) => m.isDefault) ?? models[0];
      if (pick) return { provider, model: pick.id };
    }
    return null;
  }

  /** Creating or messaging a session failed: retried like a failed turn, then given up. */
  private async sideEffectFailed(seen: AutomationJob, role: Role, error: unknown) {
    const message = clip(error instanceof Error ? error.message : String(error));
    console.error("Flowly automation could not reach the session:", message);
    await this.store.transaction((board) => {
      const job = jobOf(board, seen.taskId);
      if (!job || job.generation !== seen.generation || !isLive(job)) return { value: null, changed: false };
      const settings = automationOf(board.projects.find((p) => p.id === job.projectId));
      const gone = error instanceof SessionGone;
      const count = job.failures + 1;
      job.failures = count;
      job.detail = gone ? undefined : message;
      job.updatedAt = this.now();
      if (!gone && settings && count < settings.failureLimit) {
        job.state = "retry_wait";
        job.role = role;
        job.code = "start_failed";
        job.retryAt = new Date(this.clock() + retryDelayMs(count)).toISOString();
        this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_retry", note: `Could not start the ${role} session; retrying: ${message}` });
      } else if (role === "reviewer") {
        job.role = "implementer";
        job.state = "delivered";
        job.verdict = "incomplete";
        job.code = gone ? "session_unavailable" : "start_failed";
        this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_failed", note: `The review could not run: ${message}` });
      } else {
        this.close(job, "failed", gone ? "session_unavailable" : "start_failed");
        this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_failed", note: gone ? "The agent's session is no longer available" : `Could not start the agent: ${message}` });
      }
      return { value: null, changed: true };
    });
  }

  /**
   * Catches what a hook missed (a restart, a reload during a turn): turn ends and
   * starts already on the board, sessions archived under a running job, and
   * sessions still being created.
   */
  private async reconcile() {
    const board = await this.store.read();
    const paseo = this.api();
    for (const job of board.automation) {
      if (!isLive(job) || job.state === "queued" || job.state === "retry_wait") continue;
      const agentId = activeAgent(job);
      if (job.state === "starting" || job.pendingOp) {
        if (Date.parse(job.updatedAt) + (this.deps.staleStartMs ?? 120_000) <= this.clock()) {
          await this.store.transaction((b) => {
            const j = jobOf(b, job.taskId);
            if (!j || j.generation !== job.generation) return { value: null, changed: false };
            j.updatedAt = this.now();
            return { value: null, changed: true };
          });
          const settings = automationOf(board.projects.find((p) => p.id === job.projectId));
          const fresh = job.role === "reviewer" ? reviewPrompt(job.reviewRounds, settings?.maxReviewRounds ?? job.reviewRounds) : startPrompt({ review: !!settings?.reviewer, again: false });
          if (job.pendingOp) await this.send(job, job.role, fresh);
          else if (agentId) await this.started(job, agentId);
        }
        continue;
      }
      if (!agentId) continue;
      const agent = await paseo.agents
        .ref(agentId)
        .refresh()
        .then((r) => r?.agent ?? null, () => undefined);
      // undefined: the daemon did not answer; try again next pass.
      if (agent === undefined) continue;
      if (!agent || agent.archivedAt) {
        await this.sideEffectFailed(job, job.role, new SessionGone());
        continue;
      }
      const last = latestLifecycle(board, job.taskId, agentId);
      if (last?.action === "agent.turn_ended" && (!job.turnAt || last.at > job.turnAt)) await this.turnEnded(agentId);
      else if (last?.action === "agent.turn_started" && job.state === "needs_human" && job.code !== "permission" && (!job.turnAt || last.at > job.turnAt))
        await this.turnStarted(agentId);
    }
  }

  // ---- Helpers ----------------------------------------------------------

  private close(job: AutomationJob, state: "stopped" | "failed", code: AutomationCode) {
    job.state = state;
    job.code = code;
    job.updatedAt = this.now();
    delete job.retryAt;
    delete job.pendingOp;
  }

  /** Moves a card that automation gave up on to Blocked, so it stops looking active (Hermes auto-block). */
  private blockCard(board: Board, task: Task, note: string, agentId: string) {
    const project = board.projects.find((p) => p.id === task.projectId);
    if (task.status === "blocked" || task.status === "in_review" || !laneEnabled(project, "blocked")) return;
    if (!isWorkStatus(task.status) && task.status !== "todo" && task.status !== "backlog") return;
    const from = task.status;
    task.status = "blocked";
    task.revision++;
    task.updatedAt = this.now();
    this.store.event(board, { taskId: task.id, actor: "system", action: "status_changed", agentId, rule: "AUTO", from, to: "blocked", note });
  }
}

class SessionGone extends Error {
  constructor() {
    super("The session is archived or no longer exists.");
  }
}

function latestLifecycle(board: Pick<Board, "events">, taskId: string, agentId: string) {
  for (let i = board.events.length - 1; i >= 0; i--) {
    const e = board.events[i];
    if (e.taskId === taskId && e.agentId === agentId && (e.action === "agent.turn_ended" || e.action === "agent.turn_started")) return e;
  }
  return undefined;
}

function latestTurnEnd(board: Pick<Board, "events">, taskId: string, agentId: string) {
  const last = latestLifecycle(board, taskId, agentId);
  return last?.action === "agent.turn_ended" ? last : undefined;
}

function giveUpNote(code: AutomationCode, settings: AutomationSettings) {
  switch (code) {
    case "no_delivery":
      return `the agent ended ${settings.nudgeLimit + 1} turns in a row without a delivery, a question or a blocker`;
    case "failed":
      return `${settings.failureLimit} turns in a row failed`;
    case "review_incomplete":
      return "the reviewer did not submit a verdict; the delivery waits for you";
    default:
      return code;
  }
}
