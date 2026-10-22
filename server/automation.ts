import { cardHandoff } from "./automation-handoff";
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentModel } from "../shared/agent-defaults";
import { laneEnabled } from "../shared/lanes";
import { isWorkStatus, type Board, type Project, type Task } from "../shared/model";
import type { ToolIdentity, ToolPreparation } from "../shared/tools";
import {
  activeAgent,
  automationAllowed,
  askedThisTurn,
  providerLimited,
  providerCooling,
  coolingProvider,
  automationOf,
  changesPrompt,
  childrenPrompt,
  parentShouldWake,
  subCardSignature,
  type SubCardLine,
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
  type TurnOutcome,
} from "../shared/automation";
import { childrenOf } from "../shared/links";
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
  private stopped = false;
  private readonly sending = new Map<string, Promise<void>>();
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
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.kick(), this.deps.intervalMs ?? 15_000);
    this.timer.unref?.();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return Promise.allSettled([...(this.ticking ? [this.ticking] : []), ...this.sending.values()]);
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
    if (this.stopped) return Promise.resolve();
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      do {
        this.again = false;
        await this.tick().catch((e) => console.error("Flowly automation pass failed:", e instanceof Error ? e.message : String(e)));
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async tick() {
    if (!this.paseo || this.stopped) return;
    await this.reconcile();
    const settled = await this.store.read();
    for (const job of settled.automation) if (parentShouldWake(settled, job)) await this.wake(job);
    const plan = dispatchPlan(await this.store.read(), this.clock());
    for (const job of plan.retry) await this.resume(job);
    for (const job of plan.start) await this.begin(job);
  }

  // ---- People's actions -------------------------------------------------

  /**
   * "Run with agent": queue the card (Hermes `assign`). Keeps the implementer session of an earlier run.
   * `by`: the agent of a parent card starting its sub-card (SUB-CARDS-SPEC §4).
   */
  queue(taskId: string, by?: { agentId: string }, feedback?: string) {
    return this.store.transaction((board) => ({ value: this.queueIn(board, taskId, by, feedback), changed: true })).then((job) => { void this.kick(); return job; });
  }

  /** Card creation/status and its queue claim commit together. */
  queueIn(board: Board, taskId: string, by?: { agentId: string }, feedback?: string) {
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
          ...(existing?.reviewerId && existing.reviewerId !== existing.implementerId ? { reviewerId: existing.reviewerId } : {}),
          generation: (existing?.generation ?? 0) + 1,
          nudges: 0,
          failures: 0,
          reviewRounds: 0,
          queuedAt: now,
          updatedAt: now,
        };
        board.automation = [...board.automation.filter((j) => j.taskId !== taskId), job];
        this.store.event(board, { taskId, actor: by ? "agent" : "human", ...(by ? { agentId: by.agentId } : {}), action: "automation_queued" });
        if (!laneEnabled(project, "in_review")) throw new Error("Agent automation requires the In review lane.");
        if (by && existing?.state === "failed") throw new ToolError("NEEDS_PERSON", "This job failed. A person must choose Run again.");
        if (by && existing?.state === "stopped") throw new ToolError("TAKEN_BY_PERSON", "This job was stopped or moved. A person must choose Run again.");
        if (feedback) job.feedback = feedback;
        return job;
  }

  /** "Stop automation": no more dispatch, reminders or reviews. Running sessions are left alone. */
  stopJob(taskId: string) {
    return this.store.transaction((board) => {
      const job = jobOf(board, taskId);
      if (!job || !isLive(job)) return { value: job ?? null, changed: false };
      this.close(job, "stopped", "stopped");
      this.store.event(board, { taskId, actor: "human", action: "automation_stopped" });
      return { value: job, changed: true };
    }).then((job) => { void this.kick(); return job; });
  }

  /**
   * A person (or a parent card's agent) moved the card. Done/Cancelled ends the job; Backlog ends it too,
   * and so do Todo and Blocked once an agent is on it (that is the person taking
   * the card back). Moves between work stages are the agent's business.
   */
  async cardMoved(taskId: string, previous: string | undefined, next: string) {
    if (previous === next) return;
    await this.store.transaction((board) => {
      const job = jobOf(board, taskId);
      if (!job || (!isLive(job) && job.state !== "delivered")) return { value: false, changed: false };
      const finished = next === "done" || next === "cancelled";
      const taken = job.state === "delivered" || next === "backlog" || ((next === "todo" || next === "blocked") && job.state !== "queued");
      if (!finished && !taken) return { value: false, changed: false };
      this.close(job, "stopped", finished ? "card_finished" : "card_moved");
      this.store.event(board, { taskId, actor: "system", action: "automation_stopped", note: finished ? "The card was finished" : "The card was moved" });
      return { value: true, changed: true };
    });
    // Any move can free a slot or release the cards this one blocks (Done), with or without a job of its own.
    void this.kick();
  }

  // ---- Session lifecycle (hooks) ----------------------------------------

  /** A supervised session started a turn: a person answered it, or the first instruction arrived. */
  async turnStarted(agentId: string, taskId?: string) {
    await this.store.transaction((board) => {
      if (taskId) {
        const owner = jobOf(board, taskId);
        if (owner && automationAllowed(board, owner) && (isLive(owner) || owner.state === "delivered") && agentId !== owner.implementerId && agentId !== activeAgent(owner)) {
          this.close(owner, "stopped", "card_moved");
          return { value: null, changed: true };
        }
      }
      const job = board.automation.find(
        (j) =>
          (activeAgent(j) === agentId && (j.state === "needs_human" || j.state === "starting" || j.state === "waiting")) ||
          // Feedback after a delivery: the implementer works again, and its next delivery is reviewed again (Hermes reopen-review).
          ((j.state === "delivered" || (j.role === "reviewer" && isLive(j))) && j.implementerId === agentId),
      );
      if (!job) return { value: null, changed: false };
      const project = board.projects.find((p) => p.id === job.projectId);
      if (!automationAllowed(board, job)) return { value: null, changed: false };
      // A prepared session's first real turn proves its creation reached the daemon.
      if (job.pendingOp && activeAgent(job) === agentId) { delete job.instruction; delete job.pendingOp; delete job.pendingRole; }
      if (job.state === "delivered" || (job.role === "reviewer" && job.implementerId === agentId)) {
        const task = board.tasks.find((t) => t.id === job.taskId);
        if (!task || task.archivedAt || task.status === "done" || task.status === "cancelled") return { value: null, changed: false };
        if (job.role === "reviewer") delete job.verdict;
        delete job.instruction; delete job.pendingOp; delete job.pendingRole;
        job.role = "implementer";
        job.reopened = true;
        // Preserve the reviewed delivery until actual new work is delivered.
        this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_resumed", agentId });
      }
      if (job.state === "needs_human" && job.code === "interrupted") delete job.instruction;
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
      if (!job || !automationAllowed(board, job)) return { value: null, changed: false };
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
    const job = board.automation.find((j) => activeAgent(j) === agentId && ["starting", "working", "reviewing", "needs_human", "waiting"].includes(j.state));
    if (!job) return;
    const ended = latestTurnEnd(board, job.taskId, agentId);
    const latest = latestLifecycle(board, job.taskId, agentId);
    if (latest?.action === "agent.turn_started") return;
    if (!ended || (job.turnAt && ended.at <= job.turnAt)) return;
    const settings = automationOf(board.projects.find((p) => p.id === job.projectId));
    // Automation turned off: the session goes on unsupervised.
    if (!settings) return;
    const outcome: TurnOutcome =
      ended.outcome === "failed" ? { kind: "failed", message: ended.note ?? "" } : ended.outcome === "canceled" ? { kind: "canceled" } : { kind: "completed" };
    const newDelivery = board.events.some((event) => event.taskId === job.taskId && event.agentId === agentId && event.actor === "agent" && event.to === "in_review" && (!job.turnAt || event.at > job.turnAt));
    if (job.instruction && !job.pendingOp && outcome.kind === "completed" && !newDelivery && !askedThisTurn(board, job.taskId, agentId)) {
      const pending = await this.store.transaction((b) => { const j = this.current(b, job, job.role); if (!j || latestTurnEnd(b, j.taskId, agentId)?.id !== ended.id) return { value: null, changed: false }; j.turnAt = ended.at; return { value: { ...j }, changed: true }; });
      if (pending) await this.deliver(pending);
      return;
    }
    const applied = await this.apply(job, agentId, ended.at, outcome);
    if (applied?.instruction) await this.deliver(applied);
    void this.kick();
  }

  /** Commits a turn decision; null when the job moved on meanwhile. */
  private apply(seen: AutomationJob, agentId: string, endedAt: string, outcome: TurnOutcome) {
    return this.store.transaction((board) => {
      const job = jobOf(board, seen.taskId);
      if (!job || !isLive(job) || !automationAllowed(board, job) || job.generation !== seen.generation || activeAgent(job) !== agentId || (job.turnAt && endedAt <= job.turnAt))
        return { value: null, changed: false };
      const latest = latestTurnEnd(board, seen.taskId, agentId);
      if (!latest || latest.at !== endedAt) return { value: null, changed: false };
      const settings = automationOf(board.projects.find((p) => p.id === job.projectId))!;
      const decision = turnDecision(board, job, agentId, outcome, settings, this.clock());
      const task = board.tasks.find((t) => t.id === job.taskId)!;
      const pendingInstruction = job.instruction;
      delete job.pendingOp; delete job.pendingRole; delete job.instruction;
      const now = this.now();
      job.turnAt = endedAt;
      job.updatedAt = now;
      if (outcome.kind === "completed") { job.failures = 0; job.cooldowns = 0; delete job.detail; }
      const note = (action: string, text?: string) => this.store.event(board, { taskId: job.taskId, actor: "system", action, agentId, ...(text ? { note: text } : {}) });
      switch (decision.kind) {
        case "ignore":
          return { value: null, changed: false };
        case "review":
          if (job.reopened) job.reviewRounds = 0;
          delete job.reopened;
          job.deliveryEvent = [...board.events].reverse().find((e) => e.taskId === job.taskId && e.actor === "agent" && e.to === "in_review")?.id;
          job.role = "reviewer";
          job.state = "reviewing";
          job.reviewRounds++;
          job.nudges = 0;
          job.failures = 0;
          job.turnAt = now;
          delete job.verdict;
          delete job.code;
          delete job.pendingOp;
          delete job.pendingRole;
          this.instruct(job, "reviewer", reviewPrompt(job.reviewRounds, settings.maxReviewRounds));
          note("automation_review_started", `Review round ${job.reviewRounds} of ${settings.maxReviewRounds}`);
          break;
        case "deliver":
          delete job.reopened;
          job.state = "delivered";
          job.nudges = 0;
          job.failures = 0;
          delete job.instruction;
          delete job.pendingOp;
          delete job.pendingRole;
          if (decision.code) job.code = decision.code;
          else delete job.code;
          note("automation_delivered", decision.code === "review_rounds" ? `Review rounds used up (${settings.maxReviewRounds}); the card waits for you` : undefined);
          break;
        case "wait":
          if (decision.code === "question" || decision.code === "blocked") job.instruction = pendingInstruction;
          job.state = "needs_human";
          job.code = decision.code;
          break;
        case "await_children":
          job.state = "waiting";
          job.code = "sub_cards";
          job.subSeen = decision.signature;
          job.nudges = 0;
          job.failures = 0;
          note("automation_waiting", `Waiting for ${childrenOf(board.links, job.taskId).length} sub-cards`);
          break;
        case "stop":
          this.close(job, "stopped", decision.code);
          note("automation_stopped", decision.code === "card_finished" ? "The card was finished" : "The card was moved");
          break;
        case "nudge":
          job.nudges = decision.count;
          job.turnAt = now;
          this.instruct(job, job.role, nudgePrompt(decision.count, settings.nudgeLimit, job.role));
          note("automation_nudged", `Reminder ${decision.count} of ${settings.nudgeLimit}`);
          break;
        case "retry":
          job.state = "retry_wait";
          if (decision.cooldown) job.cooldowns = decision.count;
          else job.failures = decision.count;
          job.retryAt = decision.at;
          job.code = decision.cooldown ? "cooldown" : "failed";
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
            delete job.pendingOp;
            delete job.pendingRole;
            delete job.instruction;
            delete job.retryAt;
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

  private instruct(job: AutomationJob, role: Role, text: string, fresh = text) {
    job.instruction = { id: randomUUID(), role, text, fresh };
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
      if (!task || !project || task.status !== "in_review" || !automationAllowed(board, job))
        throw new ToolError("REVIEW_CLOSED", "The card is no longer In review; nothing was changed.");
      const now = this.now();
      const text = [input.summary, ...input.findings.map((f) => `- ${f}`)].join("\n");
      job.verdict = verdict;
      job.detail = clip(input.summary);
      job.updatedAt = now;
      job.nudges = 0;
      job.failures = 0;
      job.role = "implementer";
      delete job.pendingOp; delete job.pendingRole; delete job.instruction;
      delete job.code;
      if (verdict === "approved") {
        job.state = "delivered";
        delete job.instruction;
        delete job.pendingOp;
        delete job.pendingRole;
        this.store.event(board, { taskId: task.id, actor: "agent", agentId: identity.agentId, action: "automation_review_approved", note: clip(text, 4000) });
        return { value: { answer: { accepted: true, verdict: input.verdict, message: "Approved. The card stays In review for the user to accept; end your turn." } }, changed: true };
      }
      job.state = "working";
      job.turnAt = now;
      this.instruct(job, "implementer", changesPrompt(job.reviewRounds, automationOf(project)!.maxReviewRounds, input.summary, input.findings));
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
    if (result.changes) void this.deliver(result.changes.job);
    void this.kick();
    return result.answer;
  }

  // ---- Dispatcher -------------------------------------------------------

  /** Claims a queued card and starts (or reuses) its implementer session. */
  private async begin(seen: AutomationJob) {
    if (!(await this.canOccupy(seen))) return;
    const claimed = await this.store.transaction((board) => {
      const job = jobOf(board, seen.taskId);
      if (!job || job.generation !== seen.generation || job.state !== "queued" || !automationAllowed(board, job) || !readiness(board, job.taskId).ready) return { value: null, changed: false };
      const project = board.projects.find((p) => p.id === job.projectId)!;
      const slots = board.automation.filter((j) => j.projectId === project.id && ["starting", "working", "reviewing", "retry_wait"].includes(j.state)).length;
      if (slots >= automationOf(project)!.maxRunning || providerCooling(board, project, this.clock())) return { value: null, changed: false };
      const now = this.now();
      job.state = "starting";
      job.role = "implementer";
      job.startedAt = now;
      job.turnAt = now;
      job.updatedAt = now;
      const settings = automationOf(board.projects.find((p) => p.id === job.projectId))!;
      this.instruct(job, "implementer", [startPrompt({ review: !!settings.reviewer, again: !!job.implementerId }), job.feedback].filter(Boolean).join("\n\n"), [startPrompt({ review: !!settings.reviewer, again: false }), job.feedback].filter(Boolean).join("\n\n"));
      this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_started" });
      return { value: { ...job }, changed: true };
    });
    if (!claimed) return;
    const board = await this.store.read();
    const blockers = board.links.filter((l) => l.kind === "blocks" && l.to === claimed.taskId).map((l) => l.from);
    if (blockers.length) {
      const handoffs = (await Promise.all(blockers.map((id) => cardHandoff(board, id, this.api())))).filter(Boolean);
      const context = `\n\nDependency handoffs (card data):\n${JSON.stringify(handoffs)}\nInspect and merge the relevant blocker branches into this workspace before depending on their changes; Done does not synchronize worktrees.`;
      await this.store.transaction((b) => { const j = this.current(b, claimed, "implementer"); if (!j?.instruction) return { value: null, changed: false }; j.instruction.text += context; j.instruction.fresh += context; return { value: null, changed: true }; });
    }
    await this.deliver(claimed);
  }

  /** A due retry: the same session is told to continue (or created, when it never started). */
  private async resume(seen: AutomationJob) {
    const job = await this.store.transaction((board) => {
      const job = jobOf(board, seen.taskId);
      if (!job || job.generation !== seen.generation || job.state !== "retry_wait" || !automationAllowed(board, job)) return { value: null, changed: false };
      job.state = job.role === "reviewer" ? "reviewing" : "working";
      job.turnAt = this.now();
      job.updatedAt = job.turnAt;
      delete job.retryAt;
      const settings = automationOf(board.projects.find((p) => p.id === job.projectId))!;
      if (!job.instruction) this.instruct(job, job.role, retryPrompt(job.failures, settings.failureLimit, job.detail ?? ""), job.role === "reviewer" ? reviewPrompt(job.reviewRounds, settings.maxReviewRounds) : startPrompt({ review: !!settings.reviewer, again: false }));
      delete job.code;
      delete job.detail;
      return { value: { ...job }, changed: true };
    });
    if (!job) return;
    await this.deliver(job);
  }

  /** Directory workspaces can be distinct native resources over the same physical checkout. */
  private async canOccupy(seen: AutomationJob) {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === seen.taskId);
    if (!task) return false;
    const directory = async (workspaceId: string) => {
      const workspace = await this.api().workspaces.ref(workspaceId).refresh();
      if (!workspace || workspace.archivingAt) return null;
      return realpath(workspace.workspaceDirectory).catch(() => workspace.workspaceDirectory);
    };
    try {
      const target = await directory(task.workspaceId);
      if (!target) return false;
      for (const job of board.automation.filter((j) => j.taskId !== seen.taskId)) {
        let holds = ["starting", "working", "reviewing", "retry_wait"].includes(job.state);
        if (!holds && activeAgent(job)) {
          const agent = (await this.api().agents.ref(activeAgent(job)!).refresh())?.agent;
          holds = !!agent && !agent.archivedAt && (agent.status === "running" || !!agent.activeTurn || !!agent.pendingPermissions?.length);
        }
        if (!holds) continue;
        const other = board.tasks.find((t) => t.id === job.taskId);
        if (other && target === await directory(other.workspaceId)) return false;
      }
      return true;
    } catch { return false; }
  }


  /**
   * Gives `role`'s session of the job `text`: sent to the live session, or the
   * first instruction of a new one (`fresh`, defaulting to `text`). A failure
   * counts as a failed turn.
   */
  private current(board: Board, seen: AutomationJob, role: Role) {
    const job = jobOf(board, seen.taskId);
    return !this.stopped && job && isLive(job) && automationAllowed(board, job) && job.generation === seen.generation && job.role === role && job.instruction?.id === seen.instruction?.id ? job : null;
  }

  /** One side effect at a time per card, including lifecycle-hook follow-ups. */
  private deliver(job: AutomationJob): Promise<void> {
    const pending = this.sending.get(job.taskId);
    if (pending) return pending.then(() => this.deliver(job));
    const work = this.send(job).finally(() => this.sending.delete(job.taskId));
    this.sending.set(job.taskId, work);
    return work;
  }

  private async send(job: AutomationJob) {
    const instruction = job.instruction;
    if (!instruction) return;
    const { role } = instruction;
    try {
      const paseo = this.api();
      const board = await this.store.read();
      const current = this.current(board, job, role);
      const task = board.tasks.find((t) => t.id === job.taskId);
      const project = task && board.projects.find((p) => p.id === task.projectId);
      if (!current || !task || !project) return;
      const { text, fresh } = current.instruction!;
      const id = role === "reviewer" ? current.reviewerId : current.implementerId;
      const peerId = role === "reviewer" ? current.implementerId : current.reviewerId;
      if (peerId && peerId !== id) {
        const peer = (await paseo.agents.ref(peerId).refresh())?.agent;
        if (peer && !peer.archivedAt && peer.workspaceId === task.workspaceId && (peer.status === "running" || peer.status === "initializing" || peer.activeTurn || peer.pendingPermissions?.length)) return;
      }
      if (current.pendingOp) {
        if (current.pendingRole && current.pendingRole !== role) throw new Error("Session preparation belongs to a different automation role.");
        return await this.create(current, role, current.pendingOp, fresh, task, project, paseo);
      }
      if (id) {
        // An RPC failure is unknown, never evidence that a session disappeared.
        const agent = (await paseo.agents.ref(id).refresh())?.agent;
        if (agent && !agent.archivedAt && agent.workspaceId === task.workspaceId) {
          if (coolingProvider(board, agent.provider, this.clock(), job.taskId)) return;
          if (agent.status === "running" || agent.status === "initializing" || agent.activeTurn || agent.pendingPermissions?.length) return;
          if (!this.current(await this.store.read(), job, role)) return;
          await this.store.transaction((b) => { const j = this.current(b, job, role); if (!j) return { value: null, changed: false }; j.provider = agent.provider; return { value: null, changed: true }; });
          if (!this.current(await this.store.read(), job, role)) return;
          await paseo.agents.ref(id).send(text, { messageId: instruction.id, activeTurnBehavior: "steer" });
          await this.started(current, id);
          return;
        }
        if (role === "implementer" && current.state !== "starting") throw new SessionGone();
      }
      const op = `automation:${task.id}:${job.generation}:${role}:${randomUUID()}`;
      const recorded = await this.store.transaction((board) => {
        const j = this.current(board, job, role);
        if (!j) return { value: false, changed: false };
        j.pendingOp = op;
        j.pendingRole = role;
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
    const recorded = await this.store.transaction((board) => {
      const j = this.current(board, job, role);
      if (!j || j.pendingOp !== op) return { value: false, changed: false };
      if (preparation.agentId === (role === "reviewer" ? j.implementerId : j.reviewerId)) throw new Error("Implementer and reviewer must be different sessions.");
      if (role === "reviewer") j.reviewerId = preparation.agentId;
      else j.implementerId = preparation.agentId;
      return { value: true, changed: true };
    });
    if (!recorded) return;
    const model = role === "reviewer" ? settings?.reviewer : await this.implementerModel(project, settings, paseo);
    if (!model) throw new Error(role === "reviewer" ? "No reviewer model is set." : "No available model to start an agent with.");
    if (coolingProvider(await this.store.read(), model.provider, this.clock(), job.taskId)) return;
    await this.store.transaction((board) => { const j = this.current(board, job, role); if (!j) return { value: null, changed: false }; j.provider = model.provider; return { value: null, changed: true }; });
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
      const agent = (await paseo.agents.ref(preparation.agentId).refresh())?.agent;
      if (agent && (agent.workspaceId !== task.workspaceId || agent.archivedAt)) throw new Error("The prepared session belongs to another workspace or is archived.");
      return !!agent;
    };
    if (!this.current(await this.store.read(), job, role)) return;
    if (!(await exists()))
      try {
        if (!this.current(await this.store.read(), job, role)) return;
        await paseo.workspaces.ref(task.workspaceId).agents.create(options);
      } catch (e) {
        if (!(await exists())) throw e;
      }
    await this.store.transaction((board) => {
      const j = jobOf(board, job.taskId);
      if (!this.current(board, job, role) || !j || j.pendingOp !== op) return { value: null, changed: false };
      delete j.pendingOp;
      delete j.pendingRole;
      delete j.instruction;
      if (j.state === "starting") j.state = "working";
      j.updatedAt = this.now();
      return { value: null, changed: true };
    });
  }

  /** The first instruction reached the session. */
  private started(job: AutomationJob, agentId: string) {
    return this.store.transaction((board) => {
      const j = jobOf(board, job.taskId);
      if (!j || !this.current(board, job, job.role) || activeAgent(j) !== agentId) return { value: null, changed: false };
      if (j.state === "starting") j.state = "working";
      delete j.instruction;
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
      if (!job || !this.current(board, seen, role)) return { value: null, changed: false };
      const settings = automationOf(board.projects.find((p) => p.id === job.projectId));
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "agent_request_outcome_unknown" || message.includes("agent_request_outcome_unknown")) {
        job.state = "needs_human"; job.code = "interrupted";
        job.detail = "The daemon cannot confirm whether the instruction reached the provider. Check the session before resuming.";
        job.updatedAt = this.now();
        return { value: null, changed: true };
      }
      const gone = error instanceof SessionGone;
      if (!gone && providerLimited(message)) {
        job.cooldowns = (job.cooldowns ?? 0) + 1;
        job.state = job.cooldowns > 5 ? "needs_human" : "retry_wait";
        job.code = "cooldown";
        job.detail = message;
        job.retryAt = new Date(this.clock() + Math.min(60_000 * 2 ** (job.cooldowns - 1), 900_000)).toISOString();
        job.updatedAt = this.now();
        return { value: null, changed: true };
      }
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
        delete job.pendingOp;
        delete job.pendingRole;
        delete job.instruction;
        delete job.retryAt;
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
    for (const seen of board.automation) {
      if (!isLive(seen) || this.stopped) continue;
      const currentBoard = await this.store.read();
      const job = jobOf(currentBoard, seen.taskId);
      if (!job || !isLive(job) || job.generation !== seen.generation) continue;
      const task = currentBoard.tasks.find((t) => t.id === job.taskId);
      const project = currentBoard.projects.find((p) => p.id === job.projectId);
      if (!task || task.archivedAt || !project || project.archivedAt || ["done", "cancelled"].includes(task.status)) {
        await this.store.transaction((b) => {
          const j = jobOf(b, job.taskId);
          if (!j || j.generation !== job.generation || !isLive(j)) return { value: null, changed: false };
          this.close(j, "stopped", "card_finished");
          this.store.event(b, { taskId: j.taskId, actor: "system", action: "automation_stopped", note: "The card or project was finished or archived" });
          return { value: null, changed: true };
        });
        continue;
      }
      if (!automationOf(project)) continue;
      if (!laneEnabled(project, "in_review")) continue;
      if (!automationAllowed(currentBoard, job)) {
        await this.store.transaction((b) => { const j = jobOf(b, job.taskId); if (!j || j.generation !== job.generation || !isLive(j)) return { value: null, changed: false }; this.close(j, "stopped", "card_moved"); return { value: null, changed: true }; });
        continue;
      }
      if (job.state === "queued" || job.state === "retry_wait") continue;
      if (job.instruction && ["starting", "working", "reviewing"].includes(job.state)) { await this.deliver(job); continue; }
      const stale = Date.parse(job.updatedAt) + (this.deps.staleStartMs ?? 120_000) <= this.clock();
      const agentId = activeAgent(job);
      if (stale && (job.state === "starting" || job.pendingOp || !agentId)) {
        const recovered = await this.store.transaction((b) => {
          const j = jobOf(b, job.taskId);
          if (!j || !isLive(j) || j.generation !== job.generation || !automationAllowed(b, j)) return { value: null, changed: false };
          const settings = automationOf(b.projects.find((p) => p.id === j.projectId))!;
          if (j.pendingRole && j.pendingRole !== j.role) { delete j.pendingOp; delete j.pendingRole; }
          this.instruct(j, j.role, j.role === "reviewer" ? reviewPrompt(j.reviewRounds, settings.maxReviewRounds) : startPrompt({ review: !!settings.reviewer, again: !!j.implementerId }));
          j.updatedAt = this.now();
          return { value: { ...j }, changed: true };
        });
        if (recovered) await this.deliver(recovered);
        continue;
      }
      if (!agentId) continue;
      const agent = await paseo.agents.ref(agentId).refresh().then((r) => r?.agent ?? null, () => undefined);
      if (agent === undefined) continue;
      if (!agent || agent.archivedAt || agent.workspaceId !== task.workspaceId) {
        await this.sideEffectFailed(job, job.role, new SessionGone());
        continue;
      }
      const last = latestLifecycle(currentBoard, job.taskId, agentId);
      if (last?.action === "agent.turn_ended" && (!job.turnAt || last.at > job.turnAt)) await this.turnEnded(agentId);
      else if ((agent.status === "running" || agent.activeTurn) && (job.state === "waiting" || (job.state === "needs_human" && job.code !== "permission"))) await this.turnStarted(agentId);
      else if (stale && ["working", "reviewing"].includes(job.state) && agent.status === "idle" && !agent.activeTurn && !agent.pendingPermissions?.length) {
        // An idle session proves there is no running worker, not how its missing turn ended.
        await this.store.transaction((b) => {
          const j = jobOf(b, job.taskId);
          if (!this.current(b, job, job.role) || !j || j.updatedAt !== job.updatedAt) return { value: null, changed: false };
          j.state = "needs_human";
          j.code = "interrupted";
          j.detail = "The session is idle but its turn outcome was not recorded. Check it before resuming.";
          j.updatedAt = this.now();
          return { value: null, changed: true };
        });
      }
    }
  }

  /** A waiting parent whose sub-cards settled gets their summary and works again (SUB-CARDS-SPEC §5). */
  private async wake(seen: AutomationJob) {
    const board = await this.store.read();
    if (!parentShouldWake(board, seen) || !(await this.canOccupy(seen))) return;
    const project = board.projects.find((p) => p.id === seen.projectId);
    const lines = (await Promise.all(childrenOf(board.links, seen.taskId).map((id) => cardHandoff(board, id, this.api())))).filter((line): line is SubCardLine => !!line);
    const woken = await this.store.transaction((b) => {
      const job = jobOf(b, seen.taskId);
      if (!job || job.generation !== seen.generation || !parentShouldWake(b, job) || subCardSignature(b, job.taskId) !== subCardSignature(board, job.taskId)) return { value: null, changed: false };
      job.state = "working";
      job.role = "implementer";
      job.subSeen = subCardSignature(b, job.taskId);
      job.turnAt = this.now();
      job.updatedAt = job.turnAt;
      job.nudges = 0;
      delete job.code;
      this.instruct(job, "implementer", childrenPrompt(lines));
      this.store.event(b, { taskId: job.taskId, actor: "system", action: "automation_woken", note: "Its sub-cards settled" });
      return { value: { ...job }, changed: true };
    });
    if (woken) await this.deliver(woken);
  }

  // ---- Helpers ----------------------------------------------------------

  private close(job: AutomationJob, state: "stopped" | "failed", code: AutomationCode) {
    job.state = state;
    job.code = code;
    job.updatedAt = this.now();
    delete job.retryAt;
    delete job.pendingOp;
    delete job.pendingRole;
    delete job.instruction;
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
