import { rotationDecision, rotationLimits, poisonedSession, checkpointObservation, growthSamplesMatter, type RotationDecision, type RotationLimits } from "../shared/session-rotation";
import type { SessionPolicyFacts } from "../shared/session-measurement";
import { resolveReviewLevel, reviewPlan, withFallback } from "./review-levels";
import { AutomationLaunches } from "./automation-launch";
import { beginRotation, retireRotation, rollbackRotation, rotationContext, type AutomationHandoffBridge } from "./automation-rotation";
import type { AutomationLaunch } from "../shared/automation-launch";
import { supportedFeatures } from "../shared/agent-features";
import { cardHandoff, cardLocation } from "./automation-handoff";
import type { ContinuityReader } from "./handoff-links";
import { realpath } from "node:fs/promises";
import { historyBytes, megabytes, type HistoryAgent } from "./provider-history";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentModel } from "../shared/agent-defaults";
import { laneEnabled } from "../shared/lanes";
import { isWorkStatus, type Board, type Project, type Task } from "../shared/model";
import type { ToolIdentity, ToolPreparation } from "../shared/tools";
import {
  activeAgent,
  automationSessionRole,
  agentRestartLimit,
  arrivalDelivery,
  automationAllowed,
  askedThisTurn,
  providerLimited,
  hostTransient,
  providerCooling,
  coolingProvider,
  automationOf,
  changesPrompt,
  childrenPrompt,
  cooldownDelayMs,
  cooldownLimit,
  cooldownPrompt,
  motionOf,
  parentShouldWake,
  subCardSignature,
  type Motion,
  type SubCardLine,
  dispatchPlan,
  failureTakenBack,
  isLive,
  jobOf,
  judgedDelivery,
  newestDelivery,
  nudgePrompt,
  readiness,
  recoveredOutcome,
  retryDelayMs,
  retryPrompt,
  reviewInputSchema,
  slotStates,
  reviewPrompt,
  reviewersFor,
  rotationNote,
  historyLimits,
  reviewsFor,
  startPrompt,
  turnDecision,
  automationExecution,
  fallbackHoldMs,
  fallbackModel,
  limitNotice,
  modelKey,
  modelLimited,
  primaryModel,
  takeoverNote,
  levelRounds,
  reasonText,
  reviewStartNote,
  roundSeat,
  seatOf,
  type ReviewPlan,
  type ReviewSeat,
  type AutomationCode,
  type AutomationJob,
  type AutomationSettings,
  type ReviewInput,
  type TurnOutcome,
} from "../shared/automation";
import { childrenOf, parentOf } from "../shared/links";
import { resumeStage } from "./progress-rules";
import type { BoardStore } from "./store";
import { ToolError } from "./tool-error";
import { logFailure } from "./error-report";
import type { AcceptanceService } from "./acceptance";
import type { TournamentService } from "./tournament";
import { acceptanceDecision } from "../shared/automation";

type Role = AutomationJob["role"];
export type RoutedComment = { taskId: string; sourceId: string; messageId: string; text: string; mode?: "steer" | "interrupt" | "queue"; fresh?: boolean };
export type CommentRouteResult = { kind: "sent" | "queued" | "pending" | "fresh" | "saved"; agentId?: string };
export type AutomationDeps = {
  /**
   * Prepares a Flowly-managed session of the card (ToolServer.prepareSession): its id, tools and instructions.
   * `reviewer`: the session reviews the card, so its context leaves out the implementer's setup line.
   */
  prepare(taskId: string, operationId: string, paseo: PaseoApi, options?: { reviewer?: boolean }): Promise<ToolPreparation>;
  /** The global default model (Settings → Models), or null. */
  globalModel(): Promise<AgentModel | null>;
  /** Bounded preparation of Auto; no classifier dependency in offline automation fixtures. */
  classifyReview?: (taskId: string, paseo: PaseoApi) => Promise<void>;
  clock?: () => number;
  /** Dispatcher period; the dispatcher also runs on every queue, stop, turn end and card move. */
  intervalMs?: number;
  /** A session still `starting` after this long is created again (idempotently). */
  staleStartMs?: number;
  /** The size of a session's provider history (AUTOMATION-SPEC §4.6); tests replace it. */
  historyBytes?: (agent: HistoryAgent) => Promise<number | null>;
  /** Card records/capture only; create, send, retirement and recovery stay in this dispatcher. */
  handoff?: AutomationHandoffBridge;
  continuity?: ContinuityReader;
  lastToolAt?: (agentId: string) => string | undefined;
  checkpointAt?: (taskId: string, agentId: string) => Promise<number | undefined>;
  rotationLimits?: (taskId: string, projectId: string) => Partial<RotationLimits> | Promise<Partial<RotationLimits>>;
  readComment?: (taskId: string, sourceId: string) => Promise<{ text: string; messageId: string; mode?: "steer" | "interrupt" | "queue"; fresh?: boolean } | undefined>;
  sendComment?: (input: Omit<RoutedComment, "fresh"> & { agentId: string }) => Promise<{ kind: "sent" | "queued" }>;
  commentResult?: (taskId: string, sourceId: string, result: CommentRouteResult) => Promise<void>;
  commentFailed?: (taskId: string, sourceId: string, error: unknown) => Promise<void>;
  /** Acceptance-test review (AUTOMATION-SPEC §5.4): authors, snapshots and reverts. */
  acceptance?: Pick<AcceptanceService, "tick" | "snapshot" | "restore" | "workspaceDirectory" | "guard" | "paths" | "state">;
  /** Tournament mode (AUTOMATION-SPEC §5.5): K candidates and a judge instead of one implementer and review rounds. */
  tournament?: Pick<TournamentService, "tick" | "holds">;
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
  private readonly acceptanceTold = new Set<string>();
  private readonly clock: () => number;
  private readonly launches: AutomationLaunches;
  constructor(
    readonly store: BoardStore,
    private readonly deps: AutomationDeps,
  ) {
    this.launches = new AutomationLaunches(store.directory);
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
        await this.tick().catch((e) => logFailure("Flowly automation pass failed:", e));
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async tick() {
    if (!this.paseo || this.stopped) return;
    await this.launches.collect(await this.store.read());
    await this.recordTakeBacks();
    await this.reconcile();
    await this.recoverComments();
    await this.drainComments();
    const settled = await this.store.read();
    let motion: Motion | undefined;
    for (const job of settled.automation) if (job.state === "waiting" && parentShouldWake(settled, job, (motion ??= motionOf(settled, this.clock())))) await this.wake(job);
    const board = await this.store.read();
    // Cooldown gating compares providers; a project that sets no model starts on the global default's.
    const fallback = board.automation.some((j) => j.state === "retry_wait" && j.code === "cooldown") ? (await this.deps.globalModel().catch(() => null))?.provider : undefined;
    const plan = dispatchPlan(board, this.clock(), fallback);
    for (const job of plan.retry) await this.resume(job);
    for (const job of plan.start) await this.begin(job, fallback);
    // Authors start after their job is claimed, outside the board lock (§5.4.1).
    if (this.deps.acceptance) await this.deps.acceptance.tick(await this.store.read(), this.paseo).catch((e) => logFailure("Flowly acceptance pass failed:", e));
    if (this.deps.tournament) await this.deps.tournament.tick(await this.store.read(), this.paseo, this.tournamentHooks, () => this.store.read()).catch((e) => logFailure("Flowly tournament pass failed:", e));
    await this.watchHistory();
  }

  private measure(agent: HistoryAgent) {
    return (this.deps.historyBytes ?? historyBytes)(agent).catch(() => null);
  }

  private async policy(job: AutomationJob, agent: { id: string; provider?: string; status?: string; lastError?: string | null }, bytes?: number | null, kind?: string) {
    const facts = await this.deps.handoff?.measure?.({ taskId: job.taskId, agentId: agent.id }).catch(() => undefined);
    if (facts && facts.agentId !== agent.id) throw new Error("The rotation measurement belongs to a different session.");
    const observed: SessionPolicyFacts = { agentId: agent.id, provider: agent.provider ?? "unknown", at: this.clock(), ...facts, ...(bytes == null ? {} : { B: bytes }) };
    const board = await this.store.read();
    const ended = board.events.filter(e => e.taskId === job.taskId && e.action === "agent.turn_ended").map(e => Date.parse(e.at)).filter(Number.isFinite);
    const lastCardTurnEndAt = Math.max(observed.lastTurnEndAt ?? 0, ...ended) || undefined;
    const cached = job.instruction?.rotationDecision;
    const limits = await this.deps.rotationLimits?.(job.taskId, job.projectId);
    const decision = rotationDecision({ facts: observed, now: this.clock(), role: kind === "comment" ? "implementer" : job.instruction?.role ?? job.role,
      kind: kind ?? (job.instruction?.comment ? "comment" : job.instruction?.kind), lastCardTurnEndAt,
      error: agent.status === "error" ? "session_error" : agent.lastError ?? undefined,
      softCount: job.rotations?.soft, byteCount: job.rotations?.bytes,
      abandoned: kind === undefined && job.rotationAbandoned?.instructionId === job.instruction?.id,
      ...(kind === undefined && cached?.agentId === agent.id ? { cached } : {}),
    }, limits);
    return { decision, facts: observed, limits: { ...rotationLimits, ...limits } };
  }

  /** A policy result only feeds the existing recoverable rotation; it never starts another dispatcher. */
  private async applyPolicy(job: AutomationJob, agent: { id: string; provider?: string; status?: string; lastError?: string | null }, bytes: number | null) {
    const { decision, facts, limits } = await this.policy(job, agent, bytes);
    const changed = await this.store.transaction(board => {
      const j = this.current(board, job, job.instruction!.role);
      if (!j?.instruction || activeAgent(j) !== agent.id) return { value: null, changed: false };
      if (j.rotation) return { value: { ...j }, changed: false };
      if (decision.action === "keep") {
        if (j.instruction.rotationDecision?.agentId === agent.id) return { value: null, changed: false };
        j.instruction.rotationDecision = { agentId: agent.id, ...decision };
        return { value: null, changed: true };
      }
      if (decision.action === "hold") {
        j.rotations = { soft: j.rotations?.soft ?? 0, bytes: (j.rotations?.bytes ?? 0) + 1 };
        j.hold = "history_runaway"; j.state = "needs_human"; j.code = "interrupted";
        j.detail = "History kept growing too large in three sessions. The next instruction is saved; inspect the card's pitfalls before Run again.";
        j.updatedAt = this.now();
        this.store.event(board, { taskId: j.taskId, actor: "system", action: "automation_history_runaway", note: j.detail });
        return { value: { ...j }, changed: true };
      }
      beginRotation(j, "history", this.now(), { forced: decision.forced, ...(facts.B === undefined ? {} : { bytes: facts.B }) });
      j.rotation!.policy = { rule: decision.rule, boundary: decision.boundary, reason: decision.reason, C: facts.C, W: facts.W, K: facts.K };
      if (decision.rule === "R1" || (decision.rule === "R0" && facts.B !== undefined && facts.B >= limits.bytesNoRead))
        j.rotations = { soft: j.rotations?.soft ?? 0, bytes: (j.rotations?.bytes ?? 0) + 1 };
      return { value: { ...j }, changed: true };
    });
    if (changed?.rotation) { await this.send(changed); return true; }
    return decision.action !== "keep";
  }

  private historyCheckedAt = 0;
  private readonly liveHistorySamples = new Map<string, { at: number; bytes: number }[]>();
  /** Existing minute watch: observe and show card reminders; never steer, stop or replace a running session. */
  private async watchHistory() {
    if (this.clock() - this.historyCheckedAt < 60_000) return;
    this.historyCheckedAt = this.clock();
    const board = await this.store.read();
    const current = new Set(board.automation.filter(isLive).map(activeAgent).filter(Boolean));
    for (const id of this.liveHistorySamples.keys()) if (!current.has(id)) this.liveHistorySamples.delete(id);
    for (const job of board.automation) {
      const agentId = isLive(job) ? activeAgent(job) : undefined;
      if (!agentId) continue;
      const agent = (await this.api().agents.ref(agentId).refresh().catch(() => null))?.agent;
      if (!agent || agent.archivedAt || !busyAgent(agent)) continue;
      const bytes = await this.measure(agent as HistoryAgent);
      const facts = await this.deps.handoff?.measure?.({ taskId: job.taskId, agentId }).catch(() => undefined);
      const checkpointAt = await this.deps.checkpointAt?.(job.taskId, agentId).catch(() => undefined);
      if (facts && facts.agentId !== agentId) continue;
      const lifecycle = latestLifecycle(board, job.taskId, agentId);
      const turnStartedAt = busyAgent(agent) && lifecycle?.action === "agent.turn_started" ? Date.parse(lifecycle.at) : undefined;
      const rawToolAt = this.deps.lastToolAt?.(agentId), lastToolAt = rawToolAt === undefined ? undefined : Date.parse(rawToolAt);
      const observed = checkpointObservation({ facts: { agentId, provider: agent.provider ?? "unknown", at: this.clock(), ...facts, ...(bytes === null ? {} : { B: bytes }) }, now: this.clock(),
        seen: job.checkpointSeen, samples: this.liveHistorySamples.get(agentId) ?? (job.historySamples?.agentId === agentId ? job.historySamples.values : undefined),
        turnStartedAt: Number.isFinite(turnStartedAt) ? turnStartedAt : undefined, checkpointAt, lastToolAt });
      this.liveHistorySamples.set(agentId, observed.samples);
      const mainBytes = bytes ?? facts?.B;
      const level = mainBytes !== undefined && mainBytes >= historyLimits.warn ? "critical" : mainBytes !== undefined && mainBytes >= 128 * 2 ** 20 ? "large" : undefined;
      await this.store.transaction(b => {
        const j = jobOf(b, job.taskId);
        if (!j || j.generation !== job.generation || activeAgent(j) !== agentId) return { value: undefined, changed: false };
        let changed = false;
        if (level && (j.historyWarning?.agentId !== agentId || (j.historyWarning.level ?? "critical") !== "critical" && j.historyWarning.level !== level)) {
          j.historyWarning = { agentId, bytes: mainBytes!, at: this.now(), level }; changed = true;
          this.store.event(b, { taskId: j.taskId, actor: "system", agentId, action: "automation_history_large", note: `This session's provider history is ${megabytes(mainBytes!)} MB${level === "critical" ? "; it is unsafe to load again" : "; save screenshots and large outputs to files"}. Its next instruction uses a fresh session. Nothing has been interrupted.` });
        }
        if (this.deps.handoff?.measure) {
          const previousBytes = j.historySamples?.agentId === agentId ? j.historySamples.values.at(-1)?.bytes : undefined;
          // The minute samples live in memory. The board keeps a copy only where the fast-growth reminder can still fire
          // (main history at least 64 MiB), so a reload in the middle of the samples still sees them; below that a busy
          // turn's growing history would rewrite board.json every minute. A timestamp alone is never a board change.
          if (growthSamplesMatter(mainBytes, observed.seen) && previousBytes !== mainBytes) { j.historySamples = { agentId, values: observed.samples }; changed = true; }
          const seen = Object.keys(observed.seen).length > 1 ? observed.seen : undefined;
          if (JSON.stringify(j.checkpointSeen) !== JSON.stringify(seen)) { if (seen) j.checkpointSeen = seen; else delete j.checkpointSeen; changed = true; }
          if (j.role === "implementer" && observed.reason && !(j.checkpoint?.agentId === agentId && j.checkpoint.reason === observed.reason && (checkpointAt === undefined || checkpointAt < Date.parse(j.checkpoint.at)))) {
            j.checkpoint = { agentId, reason: observed.reason, at: this.now() }; changed = true;
            this.store.event(b, { taskId: j.taskId, actor: "system", agentId, action: "automation_checkpoint", note: observed.reason });
          }
          const silentSince = observed.silentSince === undefined ? undefined : new Date(observed.silentSince).toISOString();
          if (j.silentSince !== silentSince) { if (silentSince) j.silentSince = silentSince; else delete j.silentSince; changed = true; }
        }
        return { value: undefined, changed };
      });
    }
  }

  // ---- People's actions -------------------------------------------------

  /**
   * "Run with agent": queue the card (Hermes `assign`). Keeps the implementer session of an earlier run.
   * `by`: the agent of a parent card starting its sub-card (SUB-CARDS-SPEC §4).
   */
  async queue(taskId: string, by?: { agentId: string }, feedback?: string, launch?: AutomationLaunch) {
    const launchKey = launch ? await this.launches.save(taskId, launch) : undefined;
    const job = await this.store.transaction((board) => {
      const existing = jobOf(board, taskId);
      if (launchKey && existing?.launchKey === launchKey) return { value: existing, changed: false };
      if (launchKey && existing) throw new Error("This card already has an automation launch. Use Run again to continue it.");
      const value = this.queueIn(board, taskId, by, feedback);
      if (launchKey) value.launchKey = launchKey;
      return { value, changed: true };
    });
    void this.kick();
    return job;
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
        if (this.deps.handoff && existing?.unconfirmed) throw new ToolError("NEEDS_PERSON", "The previous session's creation is unconfirmed. Confirm that same session before starting a fresh one.");
        const now = this.now();
        // A reviewer session reviews rounds of one level (§5.2.3): one from a Light or Deep round is not carried either.
        const healthy =
          existing?.reviewerId && existing.reviewerId !== existing.implementerId && !existing.fallback?.reviewer && !seatOf(existing) && (existing.review?.level ?? "standard") === "standard";
        const carried = healthy && (!this.deps.handoff || (by && !this.deps.handoff.measure)) ? existing.reviewerId : undefined;
        // Reviewer sessions not carried stay the card's reviewers (no takeover when a person asks them later).
        const earlierReviewers = [...(existing?.reviewers ?? []), ...(existing?.reviewerId && !carried && existing.reviewerId !== existing.implementerId ? [existing.reviewerId] : [])].slice(-20);
        const held = (existing?.heldLimits ?? []).filter((limit) => Date.parse(limit.until) > this.clock());
        const recovery = this.deps.handoff && existing?.state === "failed" && existing.rotation?.role === "implementer" ? existing.rotation : undefined;
        const job: AutomationJob = {
          taskId,
          projectId: project.id,
          state: "queued",
          role: "implementer",
          ...(existing?.retired ? { retired: existing.retired } : {}),
          ...(existing?.launchModel ? { launchModel: existing.launchModel } : {}),
          ...(existing?.sessionModels ? { sessionModels: existing.sessionModels } : {}),
          ...(existing?.pendingInputs ? { pendingInputs: existing.pendingInputs } : {}),
          ...(existing?.subSeen ? { subSeen: existing.subSeen } : {}),
          ...(this.deps.handoff && !by && existing?.implementerId && !recovery ? { rotateRequested: { at: now, reason: "run_again" as const } } : {}),
          ...(existing?.implementerId ? { implementerId: existing.implementerId } : {}),
          ...(recovery ? { rotation: { ...recovery, stage: "sealing" as const, toAgentId: undefined, confirmed: undefined }, implementerId: recovery.fromAgentId } : {}),
          // A reviewer that ran on its fallback model (§4.5), the panel model (§5.1) or a review level's own model (§5.2)
          // is not carried: the next run starts on the reviewer's own model.
          ...(carried ? { reviewerId: carried } : {}),
          ...(earlierReviewers.length ? { reviewers: earlierReviewers } : {}),
          // The implementer session is kept, so is its model: a limit on it is not another switch to the same fallback.
          ...(existing?.implementerId && existing.fallback?.implementer ? { fallback: { implementer: true } } : {}),
          ...(existing?.providerLimit && Date.parse(existing.providerLimit.until) > this.clock() ? { providerLimit: existing.providerLimit } : {}),
          ...(held.length ? { heldLimits: held } : {}),
          ...(existing?.launchKey && !existing.launchConsumed ? { launchKey: existing.launchKey } : {}),
          // The reviewer's risks stay with the card until a verdict replaces them; the next run's reviewer re-checks them (§5.2.4).
          ...(existing?.risks?.length ? { risks: existing.risks, ...(existing.risksFrom ? { risksFrom: existing.risksFrom } : {}) } : {}),
          generation: (existing?.generation ?? 0) + 1,
          ...(this.deps.handoff ? { cycle: (existing?.cycle ?? existing?.generation ?? 0) + 1 } : {}),
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
        // An agent queueing earlier work again counts until a person runs or moves the card; a first start does not.
        const restarts = by && existing ? (existing.restarts ?? 0) + 1 : 0;
        if (restarts > agentRestartLimit)
          throw new ToolError("NEEDS_PERSON", `An agent already started this card again ${agentRestartLimit} times since a person last ran or moved it. Ask a person to check its work; their Run again lets agents restart it again.`);
        if (restarts) job.restarts = restarts;
        if (feedback) job.feedback = feedback;
        if (this.deps.handoff && existing?.reviewerId && !carried) job.retired = [...(job.retired ?? []).filter(s => s.agentId !== existing.reviewerId), { agentId: existing.reviewerId, role: "reviewer" as const, at: now, reason: "run_again" }].slice(-50);
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

  /** Human comments reuse the per-card dispatcher lock; the native sender owns the handoff mutex. */
  routeComment(input: RoutedComment): Promise<CommentRouteResult> {
    if (this.stopped) return Promise.reject(new ToolError("HANDOFF_UNAVAILABLE", "Automation is stopping; the original comment stays on the card."));
    const pending = this.sending.get(input.taskId);
    if (pending) return pending.then(() => this.routeComment(input));
    const work = this.routeCommentNow(input);
    const tail = work.then(() => undefined, () => undefined);
    this.sending.set(input.taskId, tail);
    void tail.finally(() => { if (this.sending.get(input.taskId) === tail) this.sending.delete(input.taskId); });
    return work;
  }

  private async routeCommentNow(input: RoutedComment): Promise<CommentRouteResult> {
    const board = await this.store.read(), job = jobOf(board, input.taskId);
    const task = board.tasks.find(t => t.id === input.taskId), project = task && board.projects.find(p => p.id === task.projectId);
    if (!job || !task || !project || !automationOf(project) || task.archivedAt || project.archivedAt || ["done", "cancelled"].includes(task.status)) return { kind: "saved" };
    if (["stopped", "failed"].includes(job.state)) return { kind: "saved" };
    if (job.rotation || job.pendingOp || job.unconfirmed || job.hold) {
      await this.pendingComment(job, input.sourceId); return { kind: "pending" };
    }
    const id = job.implementerId;
    if (!id) { await this.pendingComment(job, input.sourceId); return { kind: "pending" }; }
    const actor = (await this.api().agents.ref(id).refresh())?.agent;
    if (!actor || actor.workspaceId !== task.workspaceId || actor.archivedAt) { await this.pendingComment(job, input.sourceId); return { kind: "pending" }; }
    if (input.fresh && busyAgent(actor)) throw new ToolError("SESSION_BUSY", "Wait for the current session before choosing a fresh one. The comment is saved.");
    const observed = this.deps.handoff?.measure && !busyAgent(actor) ? await this.policy(job, actor, await this.measure(actor), "comment") : undefined;
    const decision: RotationDecision = input.fresh && (!observed || observed.decision.action === "keep")
      ? { action: "rotate", rule: "R5", boundary: "other", forced: false, reason: "A person chose a fresh session for this comment." }
      : observed?.decision ?? { action: "keep", rule: "R6", boundary: "tight", forced: false, reason: "Send the person's message to the current worker." };
    if (decision.action === "keep") {
      if (!this.deps.sendComment) throw new ToolError("HANDOFF_UNAVAILABLE", "The durable comment sender is unavailable.");
      const result = { ...await this.deps.sendComment({ ...input, agentId: id }), agentId: id };
      await this.deps.commentResult?.(input.taskId, input.sourceId, result);
      await this.removePendingComment(input.taskId, input.sourceId);
      return result;
    }
    if (job.instruction?.role === "reviewer" && !job.instruction.dispatched) {
      await this.pendingComment(job, input.sourceId); return { kind: "pending" };
    }
    await this.store.transaction(current => {
      const j = jobOf(current, input.taskId);
      if (!j || j.generation !== job.generation || j.implementerId !== id) throw new ToolError("HANDOFF_CONFLICT", "The card owner changed while the comment was being routed. Retry the same comment.");
      this.addPendingComment(j, input.sourceId);
      if (j.rotation || j.pendingOp || j.unconfirmed || (j.instruction?.role === "reviewer" && !j.instruction.dispatched)) return { value: undefined, changed: true };
      if (decision.action === "hold") {
        j.rotations = { soft: j.rotations?.soft ?? 0, bytes: (j.rotations?.bytes ?? 0) + 1 };
        j.state = "needs_human"; j.code = "interrupted"; j.hold = "history_runaway";
        j.detail = "History kept growing across three sessions. The comment is saved; inspect the card before Run again.";
        return { value: undefined, changed: true };
      }
      const previous = j.instruction?.role === "implementer" ? j.instruction : undefined;
      if (j.state === "delivered" || j.role === "reviewer") {
        if (j.role === "reviewer" && ["needs_human", "retry_wait"].includes(j.state)) j.reviewPause = this.reviewPause(j);
        if (j.role === "reviewer") delete j.verdict;
        j.reopened = true; delete j.changes;
        this.store.event(current, { taskId: j.taskId, actor: "system", action: "automation_resumed", agentId: id });
      }
      j.role = "implementer"; j.state = "working"; j.nudges = 0;
      delete j.retryAt; delete j.code; delete j.detail;
      j.instruction = { id: `comment:${input.sourceId}`, role: "implementer", text: input.text, fresh: input.text, kind: "requested", verbatim: true,
        comment: { sourceId: input.sourceId, messageId: input.messageId }, ...(previous ? { continuation: { id: previous.id, text: previous.text, fresh: previous.fresh, kind: previous.kind } } : {}) };
      beginRotation(j, input.fresh ? "requested" : "history", this.now(), { forced: decision.forced, ...(observed?.facts.B === undefined ? {} : { bytes: observed.facts.B }) });
      j.rotation!.policy = { rule: decision.rule, boundary: decision.boundary, reason: decision.reason, C: observed?.facts.C, W: observed?.facts.W, K: observed?.facts.K };
      if (decision.rule === "R1" || (decision.rule === "R0" && observed?.facts.B !== undefined && observed.facts.B >= observed.limits.bytesNoRead))
        j.rotations = { soft: j.rotations?.soft ?? 0, bytes: (j.rotations?.bytes ?? 0) + 1 };
      j.updatedAt = this.now(); return { value: undefined, changed: true };
    });
    void this.kick();
    return { kind: "pending" };
  }

  private addPendingComment(job: AutomationJob, sourceId: string) {
    if (job.pendingInputs?.includes(sourceId)) return;
    if ((job.pendingInputs?.length ?? 0) >= 20) throw new ToolError("HANDOFF_PENDING", "Twenty inputs await dispatch. The original comment is preserved; resolve pending deliveries before retrying.");
    job.pendingInputs = [...(job.pendingInputs ?? []), sourceId];
  }
  private pendingComment(job: AutomationJob, sourceId: string) {
    return this.store.transaction(board => {
      const j = jobOf(board, job.taskId);
      if (!j || j.generation !== job.generation) throw new ToolError("HANDOFF_CONFLICT", "The card run changed. Retry the same saved comment.");
      if (j.pendingInputs?.includes(sourceId)) return { value: undefined, changed: false };
      this.addPendingComment(j, sourceId); return { value: undefined, changed: true };
    });
  }
  private removePendingComment(taskId: string, sourceId: string) {
    return this.store.transaction(board => {
      const j = jobOf(board, taskId);
      if (!j?.pendingInputs?.includes(sourceId)) return { value: undefined, changed: false };
      j.pendingInputs = j.pendingInputs.filter(id => id !== sourceId); return { value: undefined, changed: true };
    });
  }
  private async finishComment(job: AutomationJob, agentId: string, kind: "sent" | "fresh") {
    const comment = job.rotation?.carry.comment ?? job.instruction?.comment;
    if (!comment) return;
    await this.deps.commentResult?.(job.taskId, comment.sourceId, { kind, agentId });
    await this.removePendingComment(job.taskId, comment.sourceId);
  }
  /** The comment is reserved before this dispatcher sees it; recover a crash between those commits. */
  private async recoverComments() {
    if (!this.deps.readComment) return;
    await this.store.transaction(board => {
      let changed = false;
      for (const route of board.commentRoutes ?? []) {
        if (!["auto", "fresh"].includes(typeof route.choice === "string" ? route.choice : "") || !["prepared", "pending", "sending"].includes(route.phase)) continue;
        const job = jobOf(board, route.taskId);
        if (!job || ["stopped", "failed"].includes(job.state) || job.pendingInputs?.includes(route.sourceId)) continue;
        const task = board.tasks.find(t => t.id === job.taskId), project = board.projects.find(p => p.id === job.projectId);
        if (!task || task.archivedAt || !project || project.archivedAt || !automationOf(project) || ["done", "cancelled"].includes(task.status)) continue;
        if ((job.pendingInputs?.length ?? 0) >= 20) {
          // Leave every source in the durable routing outbox; never slice away the oldest obligation.
          if (job.code !== "interrupted" || job.detail !== "More than twenty saved comments await dispatch. Resolve pending deliveries before continuing.") {
            job.code = "interrupted"; job.detail = "More than twenty saved comments await dispatch. Resolve pending deliveries before continuing.";
            job.state = "needs_human";
            this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_comment_pending", note: job.detail }); changed = true;
          }
          continue;
        }
        this.addPendingComment(job, route.sourceId); changed = true;
      }
      return { value: undefined, changed };
    });
  }
  private async drainComments() {
    if (!this.deps.readComment) return;
    for (const job of (await this.store.read()).automation) {
      if (!job.pendingInputs?.length || job.rotation || job.pendingOp || job.unconfirmed || job.hold || (!isLive(job) && job.state !== "delivered") || ["queued", "starting", "stopped", "failed"].includes(job.state)) continue;
      for (const sourceId of job.pendingInputs) {
        const comment = await this.deps.readComment(job.taskId, sourceId).catch(error => { logFailure("Flowly saved comment cannot be read:", error); return undefined; });
        if (!comment) {
          const route = (await this.store.read()).commentRoutes?.find(r => r.taskId === job.taskId && r.sourceId === sourceId);
          if (route && ["sent", "queued", "saved", "fresh"].includes(route.phase)) await this.removePendingComment(job.taskId, sourceId);
          continue; // Other captured inputs share this list; they are not comment deliveries.
        }
        await this.routeComment({ taskId: job.taskId, sourceId, ...comment }).catch(async error => {
          await this.deps.commentFailed?.(job.taskId, sourceId, error);
          logFailure("Flowly saved comment still awaits dispatch:", error);
        });
        break;
      }
    }
  }

  /**
   * A person (or a parent card's agent) moved the card. Done/Cancelled ends the job; Backlog ends it too,
   * and so do Todo and Blocked once an agent is on it (that is the person taking
   * the card back). Moves between work stages are the agent's business; a delivered
   * card moved back to work stays delivered, so feedback to its implementer reopens it (§4.2).
   */
  async cardMoved(taskId: string, previous: string | undefined, next: string) {
    if (previous === next) return;
    await this.store.transaction((board) => {
      const job = jobOf(board, taskId);
      if (!job || (!isLive(job) && job.state !== "delivered")) return { value: false, changed: false };
      const finished = next === "done" || next === "cancelled";
      const taken = next === "backlog" || ((next === "todo" || next === "blocked") && job.state !== "queued");
      if (!finished && !taken) {
        // A person moving the card acted on it: its parent's agent may start it again (SUB-CARDS-SPEC §8).
        const move = [...board.events].reverse().find((e) => e.taskId === taskId && e.action === "status_changed");
        if (!job.restarts || move?.actor !== "human") return { value: false, changed: false };
        delete job.restarts;
        return { value: false, changed: true };
      }
      this.close(job, "stopped", finished ? "card_finished" : "card_moved");
      this.store.event(board, { taskId, actor: "system", action: "automation_stopped", note: finished ? "The card was finished" : "The card was moved" });
      return { value: true, changed: true };
    });
    // Any move can free a slot or release the cards this one blocks (Done), with or without a job of its own.
    void this.kick();
  }

  // ---- Session lifecycle (hooks) ----------------------------------------

  /**
   * A supervised session started a turn: a person answered it, the first instruction arrived, or a
   * person spoke to it during a retry wait (their turn replaces the pending retry).
   */
  async turnStarted(agentId: string, taskId?: string) {
    await this.store.transaction((board) => {
      const membership = automationSessionRole(board, agentId, taskId);
      if (membership?.role === "retired") return { value: null, changed: false };
      if (membership?.role === "finalizing") {
        const job = membership.job;
        if (job.rotation!.finalize && !job.rotation!.finalize.startedAt) job.rotation!.finalize.startedAt = this.now();
        job.updatedAt = this.now();
        return { value: null, changed: true };
      }
      if (membership?.job.rotation?.stage === "creating" && membership.job.rotation.toAgentId === agentId) {
        const j = membership.job;
        j.rotation!.confirmed = true;
        j.state = j.role === "reviewer" ? "reviewing" : "working";
        if (j.launchKey && j.role === "implementer") j.launchConsumed = true;
        delete j.pendingOp; delete j.pendingRole; delete j.instruction;
        delete j.unconfirmed; delete j.unconfirmedStart; delete j.code;
        j.updatedAt = this.now();
        return { value: null, changed: true };
      }
      if (taskId) {
        const owner = jobOf(board, taskId);
        // Another managed session of the card took over. The job's own reviewer, outside its round, did not.
        if (owner && automationAllowed(board, owner) && (isLive(owner) || owner.state === "delivered") && agentId !== owner.implementerId && !reviewsFor(owner, agentId) && agentId !== activeAgent(owner)) {
          this.close(owner, "stopped", "taken_over");
          this.store.event(board, { taskId, actor: "system", agentId, action: "automation_stopped", note: "Another session took over the card" });
          return { value: null, changed: true };
        }
      }
      // The host can start a reviewer's turn before create/send returns, including while the implementer
      // briefly owns the job. Its pending preparation or dispatched prompt identifies that same review.
      const presented = board.automation.find((j) =>
        j.reviewerId === agentId && j.instruction?.role === "reviewer" && j.instruction.reviewDelivery === j.deliveryEvent &&
        !!j.instruction.reviewDelivery && (j.instruction.dispatched || (j.pendingOp && j.pendingRole === "reviewer")) &&
        (j.role === "reviewer" || j.reopened) && isLive(j) && automationAllowed(board, j),
      );
      if (presented) { delete presented.instruction; delete presented.pendingOp; delete presented.pendingRole; }
      const arriving = board.automation.find((j) => {
        const start = j.unconfirmedStart;
        const uncertainId = start ? (start.agentId ?? (start.role === "reviewer" ? j.reviewerId : j.implementerId)) : activeAgent(j);
        return j.unconfirmed && uncertainId === agentId && isLive(j) && automationAllowed(board, j);
      });
      if (arriving) { delete arriving.unconfirmed; delete arriving.unconfirmedStart; }
      const answering = board.automation.find((j) => j.reviewerId === agentId && j.reviewPause && isLive(j) && automationAllowed(board, j));
      if (answering) delete answering.reviewPause;
      const job = board.automation.find(
        (j) =>
          (activeAgent(j) === agentId && (j.state === "needs_human" || j.state === "starting" || j.state === "waiting" || j.state === "retry_wait")) ||
          // Feedback after a delivery: the implementer works again, and its next delivery is reviewed again (Hermes reopen-review).
          ((j.state === "delivered" || (j.role === "reviewer" && isLive(j))) && j.implementerId === agentId),
      );
      if (!job) return { value: null, changed: !!presented || !!arriving || !!answering };
      // Bind older boolean-only records before an implementer turn can temporarily take this review's role.
      if (job.unconfirmed && !job.unconfirmedStart) job.unconfirmedStart = {
        role: job.role, agentId: activeAgent(job), creating: true, code: job.code ?? "interrupted", detail: job.detail ?? "The session start was not confirmed.",
        ...(job.role === "reviewer" && job.deliveryEvent ? { reviewDelivery: job.deliveryEvent } : {}),
      };
      const project = board.projects.find((p) => p.id === job.projectId);
      if (!automationAllowed(board, job)) return { value: null, changed: false };
      // A real implementer turn proves the initial message reached the daemon, even if create has not returned.
      if (job.launchKey && job.implementerId === agentId) job.launchConsumed = true;
      // A prepared session's first real turn proves its creation reached the daemon.
      if (job.pendingOp && activeAgent(job) === agentId && (!job.pendingRole || job.pendingRole === job.role)) { delete job.instruction; delete job.pendingOp; delete job.pendingRole; }
      if (job.rotation?.stage === "creating" && job.rotation.toAgentId === agentId) job.rotation.confirmed = true;
      if (job.state === "delivered" || (job.role === "reviewer" && job.implementerId === agentId)) {
        const task = board.tasks.find((t) => t.id === job.taskId);
        if (!task || task.archivedAt || task.status === "done" || task.status === "cancelled") return { value: null, changed: false };
        if (job.role === "reviewer" && (job.state === "needs_human" || job.state === "retry_wait")) job.reviewPause = this.reviewPause(job);
        if (job.role === "reviewer") delete job.verdict;
        // A preparation is not proof that its prompt reached the reviewer. Pause the entire pending operation;
        // a casual answer resumes that same round, with the same preparation and instruction identities.
        const held = job.role === "reviewer" && job.instruction?.role === "reviewer";
        if (!held) { delete job.instruction; delete job.pendingOp; delete job.pendingRole; }
        job.role = "implementer";
        job.reopened = true;
        // A person's feedback starts a new cycle; earlier requested changes were delivered already.
        delete job.changes;
        // Preserve the reviewed delivery until actual new work is delivered.
        this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_resumed", agentId });
      }
      if (job.state === "needs_human" && job.code === "interrupted" && !job.instruction?.reviewDelivery) delete job.instruction;
      // The person's turn is judged when it ends; the failed turn's retry is not sent after it.
      if (job.state === "retry_wait") { delete job.retryAt; delete job.detail; }
      job.state = job.role === "reviewer" ? "reviewing" : "working";
      job.nudges = 0;
      delete job.code;
      job.updatedAt = this.now();
      return { value: job, changed: true };
    });
    const confirmed = (await this.store.read()).automation.find(j => j.rotation?.confirmed && j.rotation.toAgentId === agentId);
    if (confirmed) await this.commitRotation(confirmed);
  }

  /** A supervised session asked for a permission (its turn is paused), or the request was answered. */
  async permission(agentId: string, open: boolean) {
    await this.store.transaction((board) => {
      const job = board.automation.find((j) => activeAgent(j) === agentId && isLive(j));
      if (!job || !automationAllowed(board, job)) return { value: null, changed: false };
      if (job.rotation?.stage === "finalizing") return { value: null, changed: false };
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
   * The turn_ended hook. However the turn is judged (or ignored, e.g. a reviewer
   * whose verdict already went to the implementer), a dispatcher pass follows: an
   * instruction deferred while this session was busy may go out now.
   */
  async turnEnded(agentId: string) {
    try {
      await this.store.transaction(board => {
        const job = board.automation.find(j => activeAgent(j) === agentId && !!j.silentSince);
        if (!job) return { value: undefined, changed: false };
        delete job.silentSince; return { value: undefined, changed: true };
      });
      await this.judgeTurnEnd(agentId);
    } finally {
      void this.kick();
    }
  }

  /**
   * A supervised session's turn ended. The outcome is read from the board's
   * lifecycle event (recorded by the turn hook just before), so the hook and the
   * reconcile pass share one path and `turnAt` keeps either from handling it twice.
   */
  private async judgeTurnEnd(agentId: string) {
    const board = await this.store.read();
    const finishing = board.automation.find(j => j.rotation?.stage === "finalizing" && j.rotation.fromAgentId === agentId && isLive(j));
    if (finishing) {
      const end = latestTurnEnd(board, finishing.taskId, agentId);
      if (end && end.at >= finishing.rotation!.at && latestLifecycle(board, finishing.taskId, agentId)?.action !== "agent.turn_started") {
        const limit = providerLimited(end.note ?? "") ? end.note : end.outcome === "completed" ? await this.limitNotice(agentId, finishing.taskId) : undefined;
        await this.finishFinalizing(finishing, end.outcome === "completed" ? undefined : `The handover turn ended ${end.outcome ?? "without an outcome"}.`, limit ?? undefined);
      }
      return;
    }
    const committing = board.automation.find(j => j.rotation?.confirmed && j.rotation.toAgentId === agentId);
    if (committing) { await this.commitRotation(committing); return; }
    const job = board.automation.find((j) => activeAgent(j) === agentId && ["starting", "working", "reviewing", "needs_human", "waiting"].includes(j.state));
    if (!job) return;
    const ended = latestTurnEnd(board, job.taskId, agentId);
    const latest = latestLifecycle(board, job.taskId, agentId);
    if (latest?.action === "agent.turn_started") return;
    if (!ended || (job.turnAt && ended.at <= job.turnAt)) return;
    const settings = automationOf(board.projects.find((p) => p.id === job.projectId));
    // Automation turned off: the session goes on unsupervised.
    if (!settings) return;
    let outcome: TurnOutcome =
      ended.outcome === "failed" ? { kind: "failed", message: ended.note ?? "" } : ended.outcome === "canceled" ? { kind: "canceled" } : { kind: "completed" };
    const newDelivery = board.events.some((event) => event.taskId === job.taskId && event.agentId === agentId && event.actor === "agent" && event.to === "in_review" && (!job.turnAt || event.at > job.turnAt));
    // Claude Code can end a turn "completed" with its quota notice as the last row: that is a provider limit (§4.5).
    if (outcome.kind === "completed" && !newDelivery && !askedThisTurn(board, job.taskId, agentId)) {
      const notice = await this.limitNotice(agentId, job.taskId);
      if (notice) outcome = { kind: "failed", message: notice };
    }
    if (job.instruction?.role === job.role && !job.pendingOp && outcome.kind === "completed" && !newDelivery && !askedThisTurn(board, job.taskId, agentId)) {
      const pending = await this.store.transaction((b) => { const j = this.current(b, job, job.role); if (!j || latestTurnEnd(b, j.taskId, agentId)?.id !== ended.id) return { value: null, changed: false }; j.turnAt = ended.at; return { value: { ...j }, changed: true }; });
      if (pending) await this.deliver(pending);
      return;
    }
    const applied = await this.apply(job, agentId, ended.at, outcome);
    if (applied?.instruction) await this.deliver(applied);
  }

  /** Commits a turn decision; null when the job moved on meanwhile. */
  private async apply(seen: AutomationJob, agentId: string, endedAt: string, outcome: TurnOutcome) {
    const snapshot = await this.store.read();
    const candidate = snapshot.tasks.find((t) => t.id === seen.taskId);
    const settings = automationOf(snapshot.projects.find((p) => p.id === seen.projectId));
    if (candidate && settings?.reviewer && seen.role === "implementer" && outcome.kind === "completed" && candidate.status === "in_review") {
      candidate.reviewClassification = withFallback(snapshot, candidate).reviewClassification;
      const next = turnDecision(snapshot, seen, agentId, outcome, settings, this.clock());
      if (next.kind === "review" || (next.kind === "deliver" && next.code === "review_rounds"))
        await this.deps.classifyReview?.(seen.taskId, this.api());
    }
    return this.store.transaction((board) => {
      const job = jobOf(board, seen.taskId);
      if (!job || !isLive(job) || !automationAllowed(board, job) || job.generation !== seen.generation || activeAgent(job) !== agentId || (job.turnAt && endedAt <= job.turnAt))
        return { value: null, changed: false };
      const latest = latestTurnEnd(board, seen.taskId, agentId);
      if (!latest || latest.at !== endedAt) return { value: null, changed: false };
      const settings = automationOf(board.projects.find((p) => p.id === job.projectId))!;
      // Keyword fallback is prepared for shared turnDecision's round-cap calculation too.
      const currentTask = board.tasks.find((t) => t.id === job.taskId)!;
      currentTask.reviewClassification = withFallback(board, currentTask).reviewClassification;
      const decision = turnDecision(board, job, agentId, outcome, settings, this.clock());
      const task = board.tasks.find((t) => t.id === job.taskId)!;
      // Kept on the job: the card's history holds only its newest events, and later turns are compared with it (§3).
      const delivery = job.role === "implementer" ? newestDelivery(board, job, agentId) : undefined;
      if (delivery) job.latestDelivery = delivery;
      if (job.launchKey && job.implementerId === agentId) job.launchConsumed = true;
      const pendingInstruction = job.instruction;
      const pendingReview = pendingInstruction?.role === "reviewer" && job.pendingRole === "reviewer" ? job.pendingOp : undefined;
      const pausedReview = job.reviewPause;
      delete job.reviewPause;
      delete job.pendingOp; delete job.pendingRole; delete job.instruction;
      const now = this.now();
      const handledAt = job.turnAt;
      job.turnAt = endedAt;
      job.updatedAt = now;
      if (outcome.kind === "completed") { job.failures = 0; job.cooldowns = 0; delete job.detail; }
      const note = (action: string, text?: string) => this.store.event(board, { taskId: job.taskId, actor: "system", action, agentId, ...(text ? { note: text } : {}) });
      if (outcome.kind === "failed" && this.deps.handoff?.measure && poisonedSession(outcome.message)) {
        if (pendingInstruction) job.instruction = pendingInstruction;
        else this.instruct(job, job.role, job.workInstructions?.[job.role]?.fresh ?? (job.role === "reviewer" ? roundPrompt(job, settings) : opening(settings, true)), undefined, "retry");
        job.state = job.role === "reviewer" ? "reviewing" : "working";
        beginRotation(job, "history", now, { forced: true });
        job.rotation!.policy = { rule: "R0", boundary: "followup", reason: "The failed turn exceeded the provider context; continue from the card in a fresh conversation." };
        return { value: { ...job }, changed: true };
      }
      switch (decision.kind) {
        case "ignore":
          return { value: null, changed: false };
        case "review":
          if (job.workInstructions) delete job.workInstructions.implementer;
          const newReviewCycle = !!job.reopened;
          if (newReviewCycle) {
            job.reviewRounds = 0;
            delete job.acceptanceRuns;
            if (this.deps.handoff) job.cycle = (job.cycle ?? job.generation) + 1;
          }
          delete job.reopened;
          // The card reached In review without a delivery of the agent (a person moved it): this turn end stands for it.
          job.deliveryEvent = decision.delivery ?? arrivalDelivery(endedAt);
          job.latestDelivery = job.deliveryEvent;
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
          delete job.changes;
          // The round's level, cap and reviewers are resolved now and kept for the whole round (§5.2).
          const before = job.review?.level ?? "standard";
          const plan = reviewPlan(settings, board, task, job.reviewRounds);
          job.review = plan;
          this.choosePanelSession(job, roundSeat(settings, plan), plan.level !== before, newReviewCycle && !!this.deps.handoff?.measure);
          this.instruct(job, "reviewer", roundPrompt(job, settings), undefined, "round");
          job.instruction!.reviewDelivery = job.deliveryEvent;
          if (newReviewCycle && this.deps.handoff?.measure && job.reviewerId) {
            const model = primaryModel(settings, board.projects.find(p => p.id === job.projectId), "reviewer", job);
            beginRotation(job, "new_cycle", now, { forced: true, ...(model ? { model: automationExecution(model, board.projects.find(p => p.id === job.projectId)?.agentModel, settings.fullAccess) } : {}) });
          }
          this.waitOnUnconfirmed(job);
          note("automation_review_started", reviewStartNote(job.reviewRounds, plan));
          break;
        case "deliver":
          if (job.workInstructions) delete job.workInstructions.implementer;
          delete job.reopened;
          // Requested changes a delivery answered are no longer to do (a takeover must not redo them).
          delete job.changes;
          job.state = "delivered";
          job.nudges = 0;
          job.failures = 0;
          delete job.instruction;
          delete job.pendingOp;
          delete job.pendingRole;
          if (decision.code) job.code = decision.code;
          else delete job.code;
          if (decision.unreviewed) delete job.verdict;
          note("automation_delivered", decision.code === "review_rounds" ? `Review rounds used up (${levelRounds(settings, resolveReviewLevel(board, task).level)}); the card waits for you` : undefined);
          break;
        case "wait":
          if (decision.code === "question" || decision.code === "blocked") job.instruction = pendingInstruction;
          job.state = "needs_human";
          job.code = decision.code;
          break;
        case "resume_review": {
          // Nothing new was delivered: the round on that delivery goes on, with its count (§4.2). Its prompt is sent
          // only if it never reached the reviewer; a reviewer turn that already ended is judged on the next pass.
          delete job.reopened;
          job.role = "reviewer";
          job.state = "reviewing";
          job.nudges = 0;
          delete job.code;
          if (pendingInstruction?.role === "reviewer") job.instruction = pendingInstruction;
          if (pendingReview) { job.pendingOp = pendingReview; job.pendingRole = "reviewer"; }
          const reviewer = job.reviewerId ? latestLifecycle(board, job.taskId, job.reviewerId) : undefined;
          if (!job.instruction && reviewer?.action === "agent.turn_ended" && (!handledAt || reviewer.at > handledAt)) job.turnAt = new Date(Date.parse(reviewer.at) - 1).toISOString();
          else if (handledAt) job.turnAt = handledAt;
          else delete job.turnAt;
          if (pausedReview) {
            Object.assign(job, pausedReview);
            job.role = pausedReview.state === "delivered" ? "implementer" : "reviewer";
          }
          this.waitOnUnconfirmed(job);
          break;
        }
        case "fallback":
          this.switchToFallback(board, job, job.role, settings, pendingInstruction);
          break;
        case "await_children":
          job.state = "waiting";
          job.code = "sub_cards";
          job.subSeen = decision.signature;
          job.nudges = 0;
          note("automation_waiting", `Waiting for ${childrenOf(board.links, job.taskId).length} sub-cards`);
          break;
        case "stop":
          this.close(job, "stopped", decision.code);
          note("automation_stopped", decision.code === "card_finished" ? "The card was finished" : "The card was moved");
          break;
        case "nudge":
          job.nudges = decision.count;
          job.turnAt = now;
          this.instruct(job, job.role, nudgePrompt(decision.count, settings.nudgeLimit, job.role, !!settings.unattended), undefined, "nudge");
          note("automation_nudged", `Reminder ${decision.count} of ${settings.nudgeLimit}`);
          break;
        case "retry":
          job.state = "retry_wait";
          if (decision.cooldown) job.cooldowns = decision.count;
          else job.failures = decision.count;
          job.retryAt = decision.at;
          job.code = decision.cooldown ? "cooldown" : "failed";
          job.detail = clip(outcome.kind === "failed" ? outcome.message : "");
          note(
            "automation_retry",
            decision.cooldown
              ? `Provider limit (${decision.count} of ${cooldownLimit}); retrying in ${Math.round(cooldownDelayMs(decision.count) / 60_000)} min${job.detail ? `: ${job.detail}` : ""}`
              : `Turn failed (${decision.count} of ${settings.failureLimit}); retrying${job.detail ? `: ${job.detail}` : ""}`,
          );
          break;
        case "give_up": {
          job.failures += outcome.kind === "failed" ? 1 : 0;
          if (outcome.kind === "failed") job.detail = clip(outcome.message);
          if (job.role === "reviewer") {
            // The delivery stands; the user reviews it (the card stays In review).
            job.role = "implementer";
            job.state = "delivered";
            job.verdict = "incomplete";
            job.reviewedEvent = job.deliveryEvent;
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

  /**
   * `role`'s model reported a provider limit and the project set a fallback (§4.5): the limit is recorded so new
   * sessions avoid that model for a while, the role is marked, and its session is replaced. The next send creates a
   * Flowly-prepared session on the fallback model; the old session stays, unsupervised. `pending`: an instruction the
   * limited session never received (requested changes, a wake summary), carried to the new one.
   */
  private switchToFallback(board: Board, job: AutomationJob, role: Role, settings: AutomationSettings, pending?: AutomationJob["instruction"], { keep = false } = {}) {
    const project = board.projects.find((p) => p.id === job.projectId);
    const primary = this.deps.handoff ? job.sessionModels?.[role] ?? (role === "implementer" ? job.launchModel : undefined) ?? primaryModel(settings, project, role, job) : primaryModel(settings, project, role, job);
    const limited = primary ? modelKey(primary) : (job.provider ?? "its model");
    const limit = { provider: primary?.provider ?? job.provider ?? "", ...(primary ? { model: modelKey(primary) } : {}), until: new Date(this.clock() + fallbackHoldMs).toISOString() };
    // An earlier limit of this run (the reviewer's own model before a panel model's) stays on hold.
    const earlier = job.providerLimit && Date.parse(job.providerLimit.until) > this.clock() && job.providerLimit.model !== limit.model ? [job.providerLimit] : [];
    const held = [...(job.heldLimits ?? []).filter((l) => Date.parse(l.until) > this.clock() && l.model !== limit.model), ...earlier].slice(-10);
    if (held.length) job.heldLimits = held;
    else delete job.heldLimits;
    job.providerLimit = limit;
    job.fallback = { ...job.fallback, [role]: true };
    const replaced = role === "reviewer" ? job.reviewerId : job.implementerId;
    const recoveringRotation = this.deps.handoff && job.rotation?.stage === "creating";
    const oldPending = job.pendingOp;
    if (job.historyWarning?.agentId === replaced) delete job.historyWarning;
    if (!this.deps.handoff || !replaced || keep) {
      if (!recoveringRotation) {
        if (role === "reviewer") this.retireReviewer(job);
        else delete job.implementerId;
      }
    }
    job.role = role;
    job.state = role === "reviewer" ? "reviewing" : job.state === "starting" ? "starting" : "working";
    job.failures = 0;
    job.cooldowns = 0;
    job.nudges = 0;
    job.turnAt = this.now();
    job.updatedAt = job.turnAt;
    delete job.code;
    delete job.detail;
    delete job.retryAt;
    delete job.pendingOp;
    delete job.pendingRole;
    const note = takeoverNote(role, limited);
    // A session that was never created keeps its first instruction: the new one is simply started on the fallback.
    if (keep && pending) job.instruction = pending;
    else if (role === "reviewer") {
      this.instruct(job, "reviewer", `${note}\n\n${roundPrompt(job, settings)}`, undefined, "round");
      job.instruction!.reviewDelivery = job.deliveryEvent;
    } else {
      // Jobs recorded before job.changes kept them only in the event; a delivery since that verdict answered them.
      const recorded = job.verdict === "changes" && !job.changes && (!job.latestDelivery || job.latestDelivery === job.reviewedEvent) ? [...board.events].reverse().find((e) => e.taskId === job.taskId && e.action === "automation_changes_requested")?.note : undefined;
      const changes = job.verdict === "changes" ? (job.changes ?? (recorded ? `The reviewer's requested changes, still to do:\n${recorded}` : undefined)) : undefined;
      const substantive = this.deps.handoff && pending?.kind && ["nudge", "retry", "cooldown"].includes(pending.kind) ? job.workInstructions?.implementer : pending;
      const carried = substantive?.role === "implementer" ? substantive.text : changes ?? (this.deps.handoff ? job.workInstructions?.implementer?.text : undefined);
      this.instruct(job, "implementer", [note, opening(settings, false), job.feedback, carried].filter(Boolean).join("\n\n"), undefined, carried ? "changes" : "start");
    }
    const replacementModel = fallbackModel(settings, role);
    const model = replacementModel ? automationExecution(replacementModel, project?.agentModel, settings.fullAccess) : undefined;
    if (this.deps.handoff && replaced && !keep) beginRotation(job, "fallback", this.now(), { forced: true, model });
    if (recoveringRotation && job.rotation) {
      job.rotation.forced = true;
      job.rotation.model = model;
      job.pendingOp = oldPending;
      job.pendingRole = role;
    }
    this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_fallback", note: `${limited} reported a provider limit; the ${role} continues on its fallback model` });
  }

  /** A provider limit reported as the last row of a completed turn, or null; an unreadable timeline is no evidence. */
  private async limitNotice(agentId: string, taskId?: string) {
    try {
      const agent = (await this.api().agents.ref(agentId).refresh())?.agent;
      if (!agent || agent.archivedAt) return null;
      let bytes = await this.measure(agent as HistoryAgent);
      if (bytes === null && taskId && this.deps.handoff?.measure) {
        const facts = await this.deps.handoff.measure({ taskId, agentId });
        if (facts.agentId !== agentId) return null;
        bytes = facts.B ?? null;
      }
      // Unlike the global 200 MiB no-load guard, a quota tail is optional: skip it from the 64 MiB early boundary.
      if (bytes !== null && bytes >= rotationLimits.bytesRotate) return null;
      const page = await this.api().agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 30, projection: "projected" });
      return limitNotice(((page?.entries ?? []) as { item?: unknown }[]).map((entry) => entry.item).filter(Boolean));
    } catch {
      return null;
    }
  }

  private instruct(job: AutomationJob, role: Role, text: string, fresh = text, kind?: NonNullable<AutomationJob["instruction"]>["kind"]) {
    job.instruction = { id: randomUUID(), role, text, fresh, ...(kind ? { kind } : {}) };
    if (kind && !["nudge", "retry", "cooldown"].includes(kind)) job.workInstructions = { ...job.workInstructions, [role]: { ...job.instruction } };
  }

  /** A person's fresh-session request waits for idle and uses the same recoverable replacement path. */
  async requestFresh(taskId: string) {
    if (!this.deps.handoff) throw new Error("Card handoff is not ready.");
    const before = jobOf(await this.store.read(), taskId);
    const id = before && activeAgent(before);
    if (id) {
      const agent = (await this.api().agents.ref(id).refresh())?.agent;
      if (agent && busyAgent(agent)) throw new ToolError("SESSION_BUSY", "The current session is still running or waiting for a permission. Let its turn end before continuing in a fresh session.");
    }
    const job = await this.store.transaction((board) => {
      const j = jobOf(board, taskId);
      if (!j || !isLive(j) || !automationAllowed(board, j)) throw new Error("This card has no active automation run.");
      if (j.generation !== before?.generation || activeAgent(j) !== id) throw new Error("The card's session changed. Read the card before requesting a fresh session.");
      if (j.unconfirmed || j.reviewPause) throw new Error("Confirm the pending session before requesting a fresh one.");
      if (j.hold === "history_runaway") throw new ToolError("NEEDS_PERSON", "History kept growing across three sessions. Inspect the card's pitfalls and choose Run again to start a new run.");
      if (j.rotation) return { value: { ...j }, changed: false };
      const settings = automationOf(board.projects.find(p => p.id === j.projectId))!;
      if (!j.instruction) this.instruct(j, j.role, j.workInstructions?.[j.role]?.text ?? (j.role === "reviewer" ? roundPrompt(j, settings) : opening(settings, true)), undefined, "requested");
      if (j.role === "reviewer") j.instruction!.reviewDelivery = j.deliveryEvent;
      // Waiting parents retain their child signature; the continuation explicitly reads the current child state.
      if (["needs_human", "waiting", "retry_wait"].includes(j.state)) j.state = j.role === "reviewer" ? "reviewing" : "working";
      beginRotation(j, "requested", this.now(), { forced: false });
      return { value: { ...j }, changed: true };
    });
    await this.deliver(job);
    void this.kick();
    return job;
  }

  /** Finalization never enters ordinary turn judgment, including when its end hook was lost. */
  private async finishFinalizing(seen: AutomationJob, gap?: string, limit?: string) {
    const r = seen.rotation;
    if (!r) return;
    const agent = await this.api().agents.ref(r.fromAgentId).refresh().then(x => x?.agent ?? null, () => undefined);
    if (agent === undefined) return;
    if (agent && busyAgent(agent)) return;
    await this.store.transaction(board => {
      const j = jobOf(board, seen.taskId);
      if (!j || j.generation !== seen.generation || j.rotation?.id !== r.id || j.rotation.stage !== "finalizing" || !isLive(j)) return { value: null, changed: false };
      const settings = automationOf(board.projects.find(p => p.id === j.projectId));
      if (limit && settings && fallbackModel(settings, r.role) && !j.fallback?.[r.role]) {
        this.switchToFallback(board, j, r.role, settings, j.instruction);
        j.rotation!.model = automationExecution(fallbackModel(settings, r.role)!, board.projects.find(p => p.id === j.projectId)?.agentModel, settings.fullAccess);
        j.rotation!.forced = true;
      }
      j.rotation.stage = "sealing";
      if (gap) j.rotation.gap = gap;
      j.updatedAt = this.now();
      return { value: null, changed: true };
    });
  }

  /** Commit errors retain the confirmed successor; they cannot create another or restore the old owner. */
  private async commitRotation(seen: AutomationJob) {
    const r = seen.rotation;
    if (!r?.confirmed || !r.toAgentId || !this.deps.handoff) return;
    try {
      await this.deps.handoff.committed?.({ ...rotationContext(seen), toAgentId: r.toAgentId });
      if (r.carry.comment) await this.finishComment(seen, r.toAgentId, "fresh");
      await this.store.transaction(board => {
        const j = jobOf(board, seen.taskId);
        if (!j || j.generation !== seen.generation || j.rotation?.id !== r.id || !j.rotation.confirmed) return { value: null, changed: false };
        if (j.rotation.policy && ["R2", "R3", "R4"].includes(j.rotation.policy.rule)) j.rotations = { soft: (j.rotations?.soft ?? 0) + 1, bytes: j.rotations?.bytes ?? 0 };
        delete j.rotation;
        delete j.rotateRequested;
        this.store.event(board, { taskId: j.taskId, actor: "system", action: "automation_rotated", note: `A new ${r.role} session continues after ${r.reason}${r.bytes === undefined ? "" : ` (${megabytes(r.bytes)} MB)`}; ${r.gap ?? "the card handoff was sealed"}` });
        return { value: null, changed: true };
      });
    } catch (error) {
      logFailure("Flowly handoff commit will retry:", error);
    }
  }

  private successorInstruction(board: Board, job: AutomationJob, continuity: string) {
    const r = job.rotation!;
    const settings = automationOf(board.projects.find(p => p.id === job.projectId))!;
    const carry = r.carry;
    if (carry.verbatim) return carry.text;
    const followup = carry.kind && ["nudge", "retry", "cooldown"].includes(carry.kind);
    const outstanding = job.workInstructions?.[r.role];
    const substantive = (followup ? outstanding?.fresh : carry.fresh)?.replace(opening(settings, false), opening(settings, true));
    const task = r.role === "reviewer"
      ? [roundPrompt(job, settings), substantive && !substantive.includes("You are the reviewer of this card") ? substantive : ""]
      : [opening(settings, true), job.feedback, job.verdict === "changes" ? job.changes : "", substantive];
    const note = r.reason === "history" && !r.policy ? rotationNote(r.role, megabytes(r.bytes ?? 0)) : `[Flowly automation] The previous ${r.role} session gives way after ${(r.policy?.reason ?? r.reason).replace(/\.$/, "")}. Continue the card from its recorded state; do not redo completed work.`;
    return [note, continuity, ...task].filter(Boolean).join("\n\n");
  }

  /** Returns true while replacement owns this instruction, including recoverable bridge failures. */
  private async advanceRotation(seen: AutomationJob): Promise<boolean> {
    if (!seen.rotation || !this.deps.handoff) return false;
    const r = seen.rotation;
    if (r.confirmed) { await this.commitRotation(seen); return true; }
    if (r.stage === "creating") return false;
    try {
      const snapshot = await this.store.read();
      const j = this.current(snapshot, seen, r.role);
      if (!j || j.rotation?.id !== r.id) return true;
      const agent = (await this.api().agents.ref(r.fromAgentId).refresh())?.agent;
      if (agent && busyAgent(agent)) return true;
      const bytes = agent && !agent.archivedAt ? await this.measure(agent as HistoryAgent) : null;
      if (r.stage === "requested") {
        const allowFinalize = r.role === "implementer" && !r.forced && !!agent && !agent.archivedAt && agent.status === "idle" && bytes !== null && bytes < 64 * 2 ** 20;
        const prepared = await this.deps.handoff.prepare(rotationContext(j, allowFinalize));
        await this.store.transaction(board => {
          const current = this.current(board, seen, r.role);
          if (!current || current.rotation?.id !== r.id || current.rotation.stage !== "requested") return { value: null, changed: false };
          if (prepared.finalize && allowFinalize) {
            current.rotation.stage = "finalizing";
            current.rotation.finalize = { id: `${r.id}:finalize`, text: prepared.finalize };
            this.store.event(board, { taskId: current.taskId, actor: "system", action: "automation_handoff_requested", note: `The previous ${r.role} updates the card handoff before a fresh session continues` });
          } else {
            current.rotation.stage = "sealing";
            current.rotation.gap = r.forced ? `No handover turn after ${r.reason}.` : "No safe handover turn was available; use the captured card record and verify it.";
          }
          current.updatedAt = this.now();
          return { value: null, changed: true };
        });
        const next = jobOf(await this.store.read(), seen.taskId);
        if (next?.rotation?.id === r.id) return this.advanceRotation(next);
        return true;
      }
      if (r.stage === "finalizing") {
        if (!agent || agent.archivedAt || (bytes !== null && bytes >= historyLimits.rotate)) {
          await this.finishFinalizing(seen, "The previous session was unavailable or unsafe to resume for handover.");
          return true;
        }
        const f = r.finalize!;
        if (f.startedAt || (f.sentAt && Date.parse(f.sentAt) + 600_000 <= this.clock())) {
          await this.finishFinalizing(seen, f.startedAt ? undefined : "The handover turn did not start before the idle timeout.");
          return true;
        }
        if (f.sentAt) return true;
        const latest = (await this.api().agents.ref(r.fromAgentId).refresh())?.agent;
        if (!latest || latest.archivedAt || busyAgent(latest)) return true;
        // Mark the attempt before send: an unknown response must not launch a successor while it may be running.
        await this.store.transaction(board => {
          const current = this.current(board, seen, r.role);
          if (!current?.rotation?.finalize || current.rotation.id !== r.id) return { value: null, changed: false };
          current.rotation.finalize.sentAt = this.now();
          return { value: null, changed: true };
        });
        await this.api().agents.ref(r.fromAgentId).send(f.text, { messageId: f.id, activeTurnBehavior: "steer" });
        return true;
      }
      const sealed = await this.deps.handoff.seal(rotationContext(j));
      // Capture/seal can be slow; never retire an owner which started a turn while we were sealing.
      const latest = (await this.api().agents.ref(r.fromAgentId).refresh())?.agent;
      if (latest && busyAgent(latest)) return true;
      const advanced = await this.store.transaction(board => {
        const current = this.current(board, seen, r.role);
        if (!current || current.rotation?.id !== r.id || current.rotation.stage !== "sealing") return { value: null, changed: false };
        const prompt = this.successorInstruction(board, current, sealed.prompt);
        current.rotation.handoffRevision = sealed.revision;
        retireRotation(current, this.now());
        current.instruction = { ...r.carry, text: prompt, fresh: prompt, dispatched: undefined };
        return { value: { ...current }, changed: true };
      });
      if (advanced) await this.send(advanced);
      return true;
    } catch (error) {
      logFailure("Flowly handoff will retry:", error);
      const detail = clip(`The handoff could not be recorded; the successor is withheld: ${error instanceof Error ? error.message : String(error)}`);
      await this.store.transaction(board => {
        const current = jobOf(board, seen.taskId);
        if (!current || current.generation !== seen.generation || current.rotation?.id !== r.id || current.rotation.gap === detail) return { value: null, changed: false };
        current.rotation.gap = detail;
        this.store.event(board, { taskId: current.taskId, actor: "system", action: "automation_handoff_wait", note: detail });
        return { value: null, changed: true };
      }).catch(() => {});
      return true;
    }
  }

  /**
   * The role's session grew a provider history too large to load safely (§4.6): a new session takes over with the
   * same instruction. The old one stays, unsupervised, like a session replaced by its fallback.
   */
  private rotate(board: Board, job: AutomationJob, role: Role, bytes: number) {
    const settings = automationOf(board.projects.find((p) => p.id === job.projectId))!;
    const old = role === "reviewer" ? job.reviewerId : job.implementerId;
    // A retry's fresh text starts the card from scratch; the new session takes over instead.
    const fresh = job.instruction!.fresh.replace(opening(settings, false), opening(settings, true));
    const parts =
      role === "reviewer"
        ? // A reminder or retry alone would leave the new reviewer without its round, lens and panel instructions.
          [fresh.includes("You are the reviewer of this card") ? "" : roundPrompt(job, settings)]
        : [
            fresh.includes("Follow the Flowly skill:") ? "" : opening(settings, true),
            job.feedback && !fresh.includes(job.feedback) ? job.feedback : "",
            // The reviewer's requested changes still to do (as a fallback takeover carries them, §4.5).
            job.verdict === "changes" && job.changes && !fresh.includes(job.changes) ? job.changes : "",
          ];
    const text = [rotationNote(role, megabytes(bytes)), ...parts, fresh].filter(Boolean).join("\n\n");
    if (role === "reviewer") this.retireReviewer(job);
    else delete job.implementerId;
    delete job.pendingOp;
    delete job.pendingRole;
    if (job.historyWarning?.agentId === old) delete job.historyWarning;
    this.instruct(job, role, text);
    if (role === "reviewer") job.instruction!.reviewDelivery = job.deliveryEvent;
    job.updatedAt = this.now();
    this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_rotated", note: `The ${role} session's provider history reached ${megabytes(bytes)} MB, too large for Paseo to load safely; a new session takes over` });
  }

  /** The current reviewer session gives way to a new one; it stays one of the card's reviewers (`reviewers`). */
  private retireReviewer(job: AutomationJob) {
    if (job.reviewerId && job.reviewerId !== job.implementerId) job.reviewers = [...(job.reviewers ?? []).filter((id) => id !== job.reviewerId), job.reviewerId].slice(-20);
    delete job.reviewerId;
  }

  /**
   * Panel rounds on their own model get a reviewer session of their own (§5.1), and so do rounds on a review level's
   * own model (§5.2.3); the rounds after them a regular one again: a round whose model slot differs from the current
   * reviewer session's starts a new session on its model. So does a round of another level than the last one, so a
   * reviewer session reviews rounds of one level and its title ("Light review:", "Deep review:") stays true.
   */
  private choosePanelSession(job: AutomationJob, seat: ReviewSeat, levelChanged: boolean, preserveOwner = false) {
    if (seatOf(job) === seat && !levelChanged && !preserveOwner) return;
    if (!preserveOwner) this.retireReviewer(job);
    if (job.fallback?.reviewer) {
      const { reviewer: _reviewer, ...rest } = job.fallback;
      job.fallback = rest;
    }
    delete job.panel;
    delete job.seat;
    if (seat === "panel") job.panel = true;
    else if (seat) job.seat = seat;
  }

  // ---- The reviewer's verdict (flowly_submit_review) --------------------

  async submitReview(identity: ToolIdentity, raw: ReviewInput, beforeCommit?: (board: Board, sourceId: string) => Promise<void>) {
    const input = reviewInputSchema.parse(raw);
    // An approval does not pass over failing acceptance checks (§5.4.2): each one is named as wrong, with the card text it contradicts.
    const failing = input.acceptance ? input.acceptance.visible.failed + input.acceptance.holdout.failed : 0;
    if (input.verdict === "approve" && failing > (input.acceptance?.disputed?.length ?? 0))
      throw new ToolError("ACCEPTANCE_FAILING", `${failing} acceptance check${failing === 1 ? "" : "s"} failed. Approve only when each failing check is wrong: list every one in acceptance.disputed with the check's name and the card text it contradicts (quote it); otherwise send verdict=changes for the failures. Nothing was recorded.`);
    type Answer = { accepted: boolean; verdict: "approve" | "changes"; replayed?: boolean; message: string; handoffSourceId?: string };
    // Acceptance-test review (§5.4.3): a change request keeps this delivery, so a rework that does not improve can go back to it.
    const workspace = await this.acceptanceSnapshot(identity, input.verdict, !!input.acceptance);
    const result = await this.store.transaction<{ answer: Answer; changes?: { job: AutomationJob; prompt: string }; revert?: { job: AutomationJob; round: number } }>(async (board) => {
      const job = jobOf(board, identity.taskId);
      if (!job || job.reviewerId !== identity.agentId)
        throw new ToolError("NOT_REVIEWER", "Only the reviewer session that Flowly's agent automation started for this card can submit a review.");
      if (job.rotation) throw new ToolError("HANDOFF_PENDING", "The card handoff is still being recorded. Read the card and finish acknowledging the handoff before submitting this review.");
      const handoffSourceId = `review:${job.taskId}:${job.cycle ?? job.generation}:${job.reviewRounds}:${job.deliveryEvent ?? "unknown"}`;
      const verdict = input.verdict === "approve" ? "approved" : "changes";
      if ((job.instruction?.reviewDelivery && job.instruction.reviewDelivery === job.deliveryEvent) ||
          (job.unconfirmed && job.unconfirmedStart?.reviewDelivery && job.unconfirmedStart.reviewDelivery === job.deliveryEvent))
        throw new ToolError("REVIEW_CLOSED", "This delivery has not reached its reviewer yet. Finish the previous turn and wait for Flowly's new review instruction.");
      // A casual implementer turn reopened this review (§4.2): the verdict on the delivery under review still counts
      // while that turn has delivered nothing newer.
      const reopenedRound =
        job.role === "implementer" && job.state === "working" && !!job.reopened && !!job.deliveryEvent &&
        judgedDelivery(job) !== job.deliveryEvent && newestDelivery(board, job, job.implementerId) === job.deliveryEvent;
      if (!reopenedRound && (job.role !== "reviewer" || !["reviewing", "needs_human"].includes(job.state))) {
        // A repeated call after a lost response: the same verdict is acknowledged, a different one is refused.
        // Nothing of the repeated call is recorded, not even risks it adds (§5.2.4); say so.
        if (job.verdict === verdict)
          return {
            value: { answer: { accepted: true, verdict: input.verdict, replayed: true, message: "This verdict was already recorded; nothing from this call was recorded (its summary, findings and risks stay as first sent).", ...(beforeCommit ? { handoffSourceId } : {}) } },
            changed: false,
          };
        throw new ToolError("REVIEW_CLOSED", "This review round is already closed; nothing was changed.");
      }
      const task = board.tasks.find((t) => t.id === job.taskId);
      const project = task && board.projects.find((p) => p.id === task.projectId);
      // Rule A1 moves the card to a work stage for the implementer's turn; that turn's end puts it back.
      const lastMove = reopenedRound ? [...board.events].reverse().find((e) => e.taskId === job.taskId && e.action === "status_changed") : undefined;
      const resumedForTurn = lastMove?.rule === "A1" && lastMove.from === "in_review" && lastMove.agentId === job.implementerId;
      if (!task || !project || (task.status !== "in_review" && !resumedForTurn) || !automationAllowed(board, job))
        throw new ToolError("REVIEW_CLOSED", "The card is no longer In review; nothing was changed.");
      await beforeCommit?.(board, handoffSourceId);
      const now = this.now();
      const text = [input.summary, ...input.findings.map((f) => `- ${f}`)].join("\n");
      delete job.changes;
      // The latest verdict's risks replace earlier ones, with the round and delivery they were reported on (§5.2.4);
      // they never block approval.
      if (input.risks.length) {
        job.risks = input.risks;
        job.risksFrom = { round: job.reviewRounds, ...(job.deliveryEvent ? { delivery: job.deliveryEvent } : {}) };
      } else {
        delete job.risks;
        delete job.risksFrom;
      }
      const risks = () => {
        if (input.risks.length)
          this.store.event(board, { taskId: job.taskId, actor: "agent", agentId: identity.agentId, action: "automation_review_risks", note: clip(`Risks beyond the acceptance criteria (${input.risks.length}):\n${input.risks.map((r) => `- ${r}`).join("\n")}`, 10000) });
      };
      // The reviewer's acceptance counts against the previous round of this cycle (§5.4.3).
      const counted = input.acceptance && automationOf(project)?.acceptance
        ? { passed: input.acceptance.visible.passed + input.acceptance.holdout.passed, failed: input.acceptance.visible.failed + input.acceptance.holdout.failed }
        : undefined;
      const previousRun = job.acceptanceRuns?.filter((r) => r.round < job.reviewRounds).at(-1);
      if (counted) job.acceptanceRuns = [...(job.acceptanceRuns ?? []).filter((r) => r.round !== job.reviewRounds), { round: job.reviewRounds, ...counted }].slice(-10);
      if (counted && previousRun && workspace && acceptanceDecision(previousRun, counted, input.verdict) === "revert") {
        job.verdict = "changes";
        job.reviewedEvent = job.deliveryEvent;
        job.detail = clip(input.summary);
        job.updatedAt = now;
        job.nudges = 0;
        job.failures = 0;
        job.role = "implementer";
        job.state = "delivered";
        job.code = "acceptance_reverted";
        delete job.pendingOp; delete job.pendingRole; delete job.instruction; delete job.reopened;
        this.store.event(board, { taskId: task.id, actor: "agent", agentId: identity.agentId, action: "automation_changes_requested", note: clip(text, 10000) });
        risks();
        this.store.event(board, { taskId: task.id, actor: "system", action: "automation_acceptance_reverted", note: `Rework did not improve the acceptance tests (${previousRun.failed} → ${counted.failed} failing, ${previousRun.passed} → ${counted.passed} passing); restoring the workspace to review round ${previousRun.round}'s delivery. The card waits for you.` });
        return {
          value: {
            answer: { accepted: true, verdict: input.verdict, message: `Recorded. The rework did not improve the acceptance tests over round ${previousRun.round}, so Flowly restores that delivery and the card waits for a person; end your turn.`, ...(beforeCommit ? { handoffSourceId } : {}) },
            revert: { job: { ...job }, round: previousRun.round },
          },
          changed: true,
        };
      }
      job.verdict = verdict;
      job.reviewedEvent = job.deliveryEvent;
      job.detail = clip(input.summary);
      job.updatedAt = now;
      job.nudges = 0;
      job.failures = 0;
      job.role = "implementer";
      delete job.pendingOp; delete job.pendingRole; delete job.instruction;
      delete job.code;
      if (verdict === "approved") {
        // During the implementer's turn the job stays with it: its end settles the card on this verdict unless it delivers new work.
        if (!reopenedRound) job.state = "delivered";
        delete job.instruction;
        delete job.pendingOp;
        delete job.pendingRole;
        const disputed = input.acceptance?.disputed?.length ? `\n\nFailing acceptance checks judged wrong (${input.acceptance.disputed.length}):\n${input.acceptance.disputed.map((d) => `- ${d.check}: ${d.reason}`).join("\n")}` : "";
        this.store.event(board, { taskId: task.id, actor: "agent", agentId: identity.agentId, action: "automation_review_approved", note: clip(text + disputed, 10000) });
        risks();
        return { value: { answer: { accepted: true, verdict: input.verdict, message: "Approved. The card stays In review for the user to accept; end your turn.", ...(beforeCommit ? { handoffSourceId } : {}) } }, changed: true };
      }
      // The rework continues this review cycle: its delivery is the next round.
      delete job.reopened;
      job.state = "working";
      job.turnAt = now;
      const settings = automationOf(project)!;
      const plan = planOf(job, settings);
      // The implementer never learns where the reviewer-only tests are (§5.4.2).
      const hidden = settings.acceptance && this.deps.acceptance ? this.deps.acceptance.paths(task.id).holdout : null;
      const redact = (text: string) => (hidden ? text.split(hidden).join("[reviewer-only tests]") : text);
      job.changes = changesPrompt(job.reviewRounds, plan.max, redact(input.summary), input.findings.map(redact), plan.size, plan.level, input.risks.map(redact));
      this.instruct(job, "implementer", job.changes, undefined, "changes");
      this.store.event(board, { taskId: task.id, actor: "agent", agentId: identity.agentId, action: "automation_changes_requested", note: clip(text, 10000) });
      risks();
      // Back to work: the same stage a person's review feedback leads to (rule A1).
      const stage = resumeStage(board, task, project);
      if (stage && stage !== task.status) {
        const from = task.status;
        task.status = stage;
        task.revision++;
        task.updatedAt = now;
        this.store.event(board, { taskId: task.id, actor: "system", action: "status_changed", agentId: identity.agentId, rule: "REVIEW", from, to: stage, note: "The reviewer requested changes" });
      }
      return {
        value: {
          answer: { accepted: true, verdict: input.verdict, message: "Changes requested. Flowly sends your findings to the implementer; end your turn.", ...(beforeCommit ? { handoffSourceId } : {}) },
          changes: { job: { ...job }, prompt: job.changes! },
        },
        changed: true,
      };
    });
    if (result.changes) void this.deliver(result.changes.job);
    if (result.revert && workspace) await this.acceptanceRestore(result.revert.job, workspace, result.revert.round);
    void this.kick();
    return result.answer;
  }

  /** What the tournament asks of the dispatcher (§5.5): settle the job, fall back to one implementer, start the judge. */
  private readonly tournamentHooks = {
    decided: (taskId: string, generation: number, note: string) => this.tournamentDecided(taskId, generation, note),
    fallback: (taskId: string, generation: number, note: string) => this.store.transaction((board) => {
      const job = jobOf(board, taskId);
      if (!job || job.generation !== generation || !isLive(job)) return { value: null, changed: false };
      this.store.event(board, { taskId, actor: "system", action: "automation_tournament_skipped", note: clip(note, 1000) });
      return { value: null, changed: true };
    }).then(() => this.kick()),
    createJudge: (taskId: string, generation: number, prompt: string, model: AgentModel, prepared: (agentId: string) => void) => this.createJudge(taskId, generation, prompt, model, prepared),
  };

  /** The winner is in the workspace: the job is delivered without review rounds and the card waits In review (§5.5). */
  private async tournamentDecided(taskId: string, generation: number, note: string) {
    await this.store.transaction((board) => {
      const job = jobOf(board, taskId), task = board.tasks.find((t) => t.id === taskId);
      if (!job || !task || job.generation !== generation || !isLive(job)) return { value: null, changed: false };
      const now = this.now();
      job.state = "delivered";
      job.verdict = "approved";
      job.nudges = 0;
      job.failures = 0;
      job.updatedAt = now;
      delete job.instruction; delete job.pendingOp; delete job.pendingRole; delete job.code;
      this.store.event(board, { taskId, actor: "system", action: "automation_tournament_decided", agentId: job.reviewerId, note });
      if (task.status !== "in_review") {
        const from = task.status;
        task.status = "in_review";
        task.revision++;
        task.updatedAt = now;
        this.store.event(board, { taskId, actor: "system", action: "status_changed", rule: "AUTO", from, to: "in_review", note: "The tournament delivered its winner" });
      }
      return { value: null, changed: true };
    });
    void this.kick();
  }

  /** The tournament's judge: a prepared session in the card's own workspace, recorded as the job's reviewer so it is not taken for a takeover. */
  private async createJudge(taskId: string, generation: number, prompt: string, model: AgentModel, prepared: (agentId: string) => void) {
    const paseo = this.api();
    const board = await this.store.read();
    const job = jobOf(board, taskId), task = board.tasks.find((t) => t.id === taskId);
    if (!job || !task || job.generation !== generation || !isLive(job)) return null;
    const preparation = await this.deps.prepare(taskId, randomUUID(), paseo, { reviewer: true });
    const recorded = await this.store.transaction((b) => {
      const j = jobOf(b, taskId);
      if (!j || j.generation !== generation || !isLive(j)) return { value: false, changed: false };
      if (j.reviewerId && j.reviewerId !== preparation.agentId) this.retireReviewer(j);
      j.reviewerId = preparation.agentId;
      return { value: true, changed: true };
    });
    if (!recorded) return null;
    prepared(preparation.agentId);
    await paseo.workspaces.ref(task.workspaceId).agents.create({
      config: {
        provider: `${model.provider}/${model.model}`,
        systemPrompt: preparation.instructions,
        mcpServers: { flowly: preparation.mcp },
        ...(model.modeId ? { modeId: model.modeId } : {}),
        ...(model.thinking ? { thinkingOptionId: model.thinking } : {}),
      },
      agentId: preparation.agentId,
      idempotencyKey: `ultra-kanban-session:${preparation.agentId}`,
      env: { FLOWLY_CONTEXT_FILE: preparation.contextFile, FLOWLY_CLI: preparation.cliPath, FLOWLY_SKILL: preparation.skillPath },
      title: `Judge: ${task.title}`.slice(0, 120),
      labels: { "flowly-task": task.id, "flowly-automation": "reviewer", "flowly-tournament": "judge", "paseo-rate-fallback": "off" },
      prompt,
    });
    return preparation.agentId;
  }

  /**
   * A review waits for this generation's acceptance tests while their author is still writing (§5.4.2): a review that
   * started before them approved without any. The pass retries the held instruction; the round is not used up.
   * A failed author lets the review go on without tests. Each wait and each failure is told once on the card.
   */
  private async acceptancePending(job: AutomationJob, project: Project) {
    if (!this.deps.acceptance || !automationOf(project)?.acceptance) return false;
    const state = await this.deps.acceptance.state(job.taskId).catch(() => null);
    if (!state || state.generation !== job.generation) return false;
    const key = `${job.taskId}:${job.generation}:${state.status === "writing" ? job.deliveryEvent ?? "" : "failed"}`;
    const tell = state.status === "writing" || state.status === "failed" ? !this.acceptanceTold.has(key) : false;
    if (tell) {
      this.acceptanceTold.add(key);
      await this.store.transaction((b) => {
        // Already told for this delivery (writing) or this run (failed), e.g. before a plugin reload.
        const action = state.status === "writing" ? "automation_acceptance_waiting" : "automation_acceptance_failed";
        const since = state.status === "writing" ? b.events.find((e) => e.id === job.deliveryEvent)?.at ?? job.queuedAt : state.startedAt;
        if (b.events.some((e) => e.taskId === job.taskId && e.action === action && e.at >= since)) return { value: null, changed: false };
        this.store.event(b, state.status === "writing"
          ? { taskId: job.taskId, actor: "system", action: "automation_acceptance_waiting", note: "The review starts when the acceptance tests are written; this round is not used up while they are." }
          : { taskId: job.taskId, actor: "system", action: "automation_acceptance_failed", note: clip(`The acceptance tests could not be written, so this card is reviewed without them${state.detail ? `: ${state.detail}` : "."}`, 600) });
        return { value: null, changed: true };
      }).catch((e) => logFailure("Flowly could not record the acceptance wait:", e, job.taskId));
    }
    return state.status === "writing";
  }

  /** Before a verdict: the reviewer's card is an acceptance card; a change request snapshots the delivery under review (§5.4.3). */
  private async acceptanceSnapshot(identity: ToolIdentity, verdict: "approve" | "changes", counted: boolean) {
    const acceptance = this.deps.acceptance;
    if (!acceptance || !this.paseo) return null;
    const board = await this.store.read();
    const job = jobOf(board, identity.taskId), task = board.tasks.find((t) => t.id === identity.taskId);
    if (!job || !task || job.reviewerId !== identity.agentId || !automationOf(board.projects.find((p) => p.id === job.projectId))?.acceptance) return null;
    // Counts are what reverts compare (§5.4.3): with the tests ready, a verdict without them is refused before anything is recorded.
    const state = await acceptance.state(task.id).catch(() => null);
    // A reviewer that got going before the tests were written (§5.4.2) waits for them like a held review.
    if (state?.status === "writing" && state.generation === job.generation)
      throw new ToolError("ACCEPTANCE_PENDING", "This card's acceptance tests are still being written. End your turn without a verdict; Flowly sends the review instruction again when they are ready. Nothing was recorded.");
    if (!counted && state?.status === "ready")
      throw new ToolError("ACCEPTANCE_REQUIRED", "This card's acceptance tests are ready: run both suites and send their counts in acceptance { visible: { passed, failed }, holdout: { passed, failed } } (from each suite's final ACCEPTANCE line), then submit again. Nothing was recorded.");
    // A session that changed the tests gets the author's version back before anything counts (§5.4.2).
    if (await acceptance.guard(task.id).catch(() => false))
      await this.store.transaction((b) => {
        this.store.event(b, { taskId: task.id, actor: "system", action: "automation_acceptance_reverted", note: "A session changed the acceptance tests; Flowly put the author's version back. Counts reported against the changed tests do not show the card's real state." });
        return { value: null, changed: true };
      });
    const directory = await acceptance.workspaceDirectory(task, this.paseo).catch(() => null);
    if (!directory) return null;
    if (verdict === "changes")
      await acceptance.snapshot(task.id, directory, job.cycle ?? job.generation, job.reviewRounds).catch((e) => logFailure("Flowly acceptance snapshot failed:", e, task.id));
    return directory;
  }

  /** Puts the workspace back to the round's delivery; a failure is recorded on the card and leaves the workspace as it is. */
  private async acceptanceRestore(job: AutomationJob, directory: string, round: number) {
    const error = await this.deps.acceptance!.restore(job.taskId, directory, job.cycle ?? job.generation, round).then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
    await this.store.transaction((board) => {
      this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_acceptance_reverted", note: error ? `The workspace could not be restored to review round ${round}'s delivery: ${clip(error, 300)}` : `The workspace is back at review round ${round}'s delivery.` });
      return { value: null, changed: true };
    });
  }

  // ---- Dispatcher -------------------------------------------------------

  /** Claims a queued card and starts (or reuses) its implementer session. `fallbackProvider`: the global default model's. */
  private async begin(seen: AutomationJob, fallbackProvider?: string) {
    const place = await this.occupancy(seen);
    if (place === "unavailable") return this.workspaceGone(seen);
    if (place !== "free") return;
    const claimed = await this.store.transaction((board) => {
      const job = jobOf(board, seen.taskId);
      if (!job || job.generation !== seen.generation || job.state !== "queued" || !automationAllowed(board, job) || !readiness(board, job.taskId).ready) return { value: null, changed: false };
      const project = board.projects.find((p) => p.id === job.projectId)!;
      const slots = board.automation.filter((j) => j.projectId === project.id && slotStates.includes(j.state)).length;
      if (slots >= automationOf(project)!.maxRunning || providerCooling(board, project, this.clock(), fallbackProvider)) return { value: null, changed: false };
      const now = this.now();
      job.state = "starting";
      job.role = "implementer";
      job.startedAt = now;
      job.turnAt = now;
      job.updatedAt = now;
      const settings = automationOf(board.projects.find((p) => p.id === job.projectId))!;
      this.instruct(job, "implementer", [opening(settings, !!job.implementerId), job.feedback].filter(Boolean).join("\n\n"), [opening(settings, false), job.feedback].filter(Boolean).join("\n\n"), job.implementerId ? "again" : "start");
      this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_started" });
      return { value: { ...job }, changed: true };
    });
    if (!claimed) return;
    const board = await this.store.read();
    const blockers = board.links.filter((l) => l.kind === "blocks" && l.to === claimed.taskId).map((l) => l.from);
    if (blockers.length) {
      const handoffs = (await Promise.all(blockers.map((id) => cardHandoff(board, id, this.api(), this.deps.continuity, "dependency")))).filter(Boolean);
      // A sub-card's parent merges its accepted siblings: its branch may hold their changes already integrated.
      const parentId = parentOf(board.links, claimed.taskId);
      const parent = parentId ? await cardLocation(board, parentId, this.api(), undefined, this.deps.continuity) : null;
      const integration = parent
        ? `\n\nParent integration branch (card data): ${JSON.stringify({ id: parent.id, title: parent.title, lane: parent.lane, branch: parent.branch, directory: parent.directory, continuity: parent.continuity })}\nThe parent card brings its accepted sub-cards together, so its branch may already hold the sibling blockers' changes with their conflicts resolved. Check it first and prefer merging it over merging each sibling branch again.`
        : "";
      const context = `\n\nDependency handoffs (card data):\n${JSON.stringify(handoffs)}\nInspect and merge the relevant blocker branches into this workspace before depending on their changes; Done does not synchronize worktrees.${integration}`;
      await this.store.transaction((b) => { const j = this.current(b, claimed, "implementer"); if (!j?.instruction) return { value: null, changed: false }; j.instruction.text += context; j.instruction.fresh += context; return { value: null, changed: true }; });
    }
    if (this.deps.handoff && claimed.rotateRequested && claimed.implementerId) {
      await this.store.transaction(board => {
        const j = this.current(board, claimed, "implementer");
        if (!j) return { value: null, changed: false };
        beginRotation(j, j.rotateRequested!.reason, this.now(), { forced: false });
        return { value: null, changed: true };
      });
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
      const retry = job.code === "cooldown" ? cooldownPrompt(job.cooldowns ?? 1, job.detail ?? "") : retryPrompt(job.failures, settings.failureLimit, job.detail ?? "");
      if (!job.instruction) this.instruct(job, job.role, retry, job.role === "reviewer" ? roundPrompt(job, settings) : opening(settings, false), job.code === "cooldown" ? "cooldown" : "retry");
      delete job.code;
      delete job.detail;
      return { value: { ...job }, changed: true };
    });
    if (!job) return;
    await this.deliver(job);
  }

  /**
   * Whether the job's card may take its workspace's directory now. Directory workspaces can be distinct
   * native resources over the same physical checkout: another card holds it while its job runs, or while
   * its session still runs, waits for a permission or is mid-turn (a stopped job's session too). Only cards
   * still in play are asked: a finished or archived card's jobs ended and its sessions are a person's.
   * `unavailable`: the card's own workspace is archived or gone; `unknown`: the daemon did not answer.
   */
  private async occupancy(seen: AutomationJob): Promise<"free" | "occupied" | "unavailable" | "unknown"> {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === seen.taskId);
    if (!task) return "unknown";
    try {
      // Workspace ref.refresh scans the full list too; share one paginated snapshot for this attempt.
      const workspaces = new Map<string, { workspaceDirectory: string; archivingAt?: string | null }>();
      let cursor: string | undefined;
      do {
        const page = await this.api().workspaces.list({ page: { limit: 200, cursor } });
        for (const workspace of page.entries) workspaces.set(workspace.id, workspace);
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      const directories = new Map<string, Promise<string | null>>();
      const directory = (workspaceId: string) => {
        let found = directories.get(workspaceId);
        if (!found) {
          const workspace = workspaces.get(workspaceId);
          found = !workspace || workspace.archivingAt
            ? Promise.resolve(null)
            : realpath(workspace.workspaceDirectory).catch(() => workspace.workspaceDirectory);
          directories.set(workspaceId, found);
        }
        return found;
      };
      const target = await directory(task.workspaceId);
      if (!target) return "unavailable";
      const others = board.automation.flatMap((job) => {
        if (!slotStates.includes(job.state) && !activeAgent(job)) return [];
        const other = job.taskId !== seen.taskId ? board.tasks.find((t) => t.id === job.taskId) : undefined;
        return other && !other.archivedAt && other.status !== "done" && other.status !== "cancelled" ? [{ job, other }] : [];
      });
      const shared = (await Promise.all(others.map(async ({ job, other }) => ((await directory(other.workspaceId)) === target ? [job] : [])))).flat();
      const holds = await Promise.all(
        shared.map(async (job) => {
          if (slotStates.includes(job.state)) return true;
          const id = activeAgent(job);
          if (!id) return false;
          const agent = (await this.api().agents.ref(id).refresh())?.agent;
          return !!agent && !agent.archivedAt && (agent.status === "running" || !!agent.activeTurn || !!agent.pendingPermissions?.length);
        }),
      );
      return holds.some(Boolean) ? "occupied" : "free";
    } catch {
      return "unknown";
    }
  }

  /** The card's own workspace is archived or gone: the job settles with the reason, so its parent can wake. */
  private workspaceGone(seen: AutomationJob) {
    return this.store.transaction((board) => {
      const job = jobOf(board, seen.taskId);
      if (!job || job.generation !== seen.generation || job.state !== seen.state || !automationAllowed(board, job)) return { value: null, changed: false };
      this.close(job, "failed", "workspace_unavailable");
      job.detail = "The card's workspace is archived or no longer exists.";
      this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_failed", note: "The card's workspace is archived or no longer exists" });
      return { value: null, changed: true };
    });
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

  /** A successful send/create can be confirmed while a casual implementer turn has paused this same review. */
  private confirmation(board: Board, seen: AutomationJob, role: Role) {
    const job = jobOf(board, seen.taskId);
    const paused = role === "reviewer" && job?.role === "implementer" && job.reopened && job.instruction?.role === "reviewer";
    return this.current(board, seen, paused ? "implementer" : role);
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
      if (!current || !task || !project || !["starting", "working", "reviewing"].includes(current.state) || this.unconfirmedFor(current, role)) return;
      if (role === "reviewer" && await this.acceptancePending(current, project)) return;
      // A tournament card's implementer waits: the candidates and the judge do its work (§5.5).
      if (role === "implementer" && this.deps.tournament && automationOf(project)?.tournament && await this.deps.tournament.holds(current.taskId, current.generation)) return;
      const { text, fresh } = current.instruction!;
      const id = role === "reviewer" ? current.reviewerId : current.implementerId;
      const peerId = role === "reviewer" ? current.implementerId : current.reviewerId;
      if (peerId && peerId !== id) {
        const peer = (await paseo.agents.ref(peerId).refresh())?.agent;
        if (peer && !peer.archivedAt && peer.workspaceId === task.workspaceId && (peer.status === "running" || peer.status === "initializing" || peer.activeTurn || peer.pendingPermissions?.length)) return;
      }
      if (this.deps.handoff) {
        for (const retired of (current.retired ?? []).slice(-5)) {
          if (retired.agentId === id) continue;
          const old = await paseo.agents.ref(retired.agentId).refresh().then(x => x?.agent ?? null, () => undefined);
          if (old === undefined || (old && !old.archivedAt && old.workspaceId === task.workspaceId && busyAgent(old))) return;
        }
        if (await this.advanceRotation(current)) return;
      }
      if (current.pendingOp) {
        if (current.pendingRole && current.pendingRole !== role) throw new Error("Session preparation belongs to a different automation role.");
        return await this.create(current, role, current.pendingOp, fresh, task, project, paseo);
      }
      if (id) {
        // An RPC failure is unknown, never evidence that a session disappeared.
        const agent = (await paseo.agents.ref(id).refresh())?.agent;
        if (agent && !agent.archivedAt && agent.workspaceId === task.workspaceId) {
          if (coolingProvider(board, agent.provider, this.clock(), { except: job.taskId })) return;
          if (agent.status === "running" || agent.status === "initializing" || agent.activeTurn || agent.pendingPermissions?.length) return;
          const bytes = await this.measure(agent as HistoryAgent);
          if (this.deps.handoff?.measure && await this.applyPolicy(current, agent, bytes)) return;
          if (bytes !== null && bytes >= historyLimits.rotate) {
            // A turn started on it while it was measured (a person's message) keeps it: never two sessions in one
            // workspace. The snapshot decides, so a lost turn-end hook cannot hold the rotation forever.
            const again = (await paseo.agents.ref(id).refresh())?.agent;
            if (!again || again.archivedAt || again.status === "running" || again.status === "initializing" || again.activeTurn || again.pendingPermissions?.length) return;
            const rotated = await this.store.transaction((b) => {
              const j = this.current(b, job, role);
              if (!j?.instruction || (role === "reviewer" ? j.reviewerId : j.implementerId) !== id) return { value: null, changed: false };
              if (this.deps.handoff) beginRotation(j, "history", this.now(), { forced: true, bytes });
              else this.rotate(b, j, role, bytes);
              return { value: { ...j }, changed: true };
            });
            if (rotated) await this.send(rotated);
            return;
          }
          if (!this.current(await this.store.read(), job, role)) return;
          await this.store.transaction((b) => { const j = this.current(b, job, role); if (!j) return { value: null, changed: false }; j.provider = agent.provider; return { value: null, changed: true }; });
          if (!this.current(await this.store.read(), job, role)) return;
          const launch = role === "implementer" && current.launchKey && !current.launchConsumed ? await this.launches.read(task.id, current.launchKey) : undefined;
          // Measurement, handoff capture and launch-file reads all yield: the initial idle snapshot is stale by now.
          const finalActor = await paseo.agents.ref(id).refresh().then(ref => ref?.agent, () => undefined);
          if (!finalActor || finalActor.archivedAt || finalActor.workspaceId !== task.workspaceId || busyAgent(finalActor)) return;
          const latest = this.current(await this.store.read(), job, role);
          if (!latest || activeAgent(latest) !== id || latest.rotation || latest.pendingOp || this.unconfirmedFor(latest, role) || !["starting", "working", "reviewing"].includes(latest.state) || (launch && (latest.launchConsumed || latest.launchKey !== current.launchKey))) return;
          const response = paseo.agents.ref(id).send(text, { messageId: launch?.clientMessageId ?? current.instruction?.comment?.messageId ?? instruction.id, activeTurnBehavior: "steer", ...(launch?.images ? { images: launch.images } : {}) });
          const dispatched = instruction.reviewDelivery ? this.store.transaction((b) => {
            const j = this.confirmation(b, job, role);
            if (!j?.instruction) return { value: null, changed: false };
            j.instruction.dispatched = true;
            return { value: null, changed: true };
          }) : Promise.resolve();
          await Promise.all([response, dispatched]);
          await this.consumeLaunch(current, role);
          await this.started(current, id);
          if (current.instruction?.comment) await this.finishComment(current, id, "sent");
          return;
        }
        if (this.deps.handoff?.measure && (role === "reviewer" || current.state === "starting")) {
          const replacement = await this.store.transaction(b => {
            const j = this.current(b, job, role);
            if (!j?.instruction || j.rotation) return { value: null, changed: false };
            beginRotation(j, "archived", this.now(), { forced: true });
            return { value: { ...j }, changed: true };
          });
          if (replacement) await this.send(replacement);
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
    const preparation = await this.deps.prepare(task.id, op, paseo, { reviewer: role === "reviewer" });
    const recorded = await this.store.transaction((board) => {
      const j = this.current(board, job, role);
      if (!j || j.pendingOp !== op) return { value: false, changed: false };
      if (preparation.agentId === (role === "reviewer" ? j.implementerId : j.reviewerId)) throw new Error("Implementer and reviewer must be different sessions.");
      if (role === "reviewer") {
        if (j.reviewerId !== preparation.agentId) this.retireReviewer(j);
        j.reviewerId = preparation.agentId;
        if (this.deps.handoff?.measure) j.reviewerCycle = j.cycle ?? j.generation;
      }
      else j.implementerId = preparation.agentId;
      if (j.rotation?.stage === "creating") j.rotation.toAgentId = preparation.agentId;
      return { value: true, changed: true };
    });
    if (!recorded) return;
    const launch = role === "implementer" && job.launchKey && !job.launchConsumed ? await this.launches.read(task.id, job.launchKey) : undefined;
    const primary = launch?.model ?? job.rotation?.model ?? (role === "implementer" && job.launchModel ? job.launchModel : role === "reviewer" ? settings && primaryModel(settings, project, role, job) : await this.implementerModel(project, settings, paseo));
    // The role's fallback (§4.5): once it switched, or while its own model has a recent limit or its provider cools down.
    const fallback = settings ? fallbackModel(settings, role) : undefined;
    const known = await this.store.read();
    const switched = !!fallback && !job.fallback?.[role] && !!primary &&
      (modelLimited(known, primary, this.clock()) || coolingProvider(known, primary.provider, this.clock(), { except: job.taskId }));
    const onFallback = !!fallback && (!!job.fallback?.[role] || switched);
    const chosen = job.rotation?.model ?? (onFallback ? fallback : primary);
    const preserve = job.rotation?.model || (!onFallback && (launch || (role === "implementer" && job.launchModel)));
    const model = chosen && (preserve ? chosen : automationExecution(chosen, project.agentModel, !!settings?.fullAccess));
    if (!model) throw new Error(role === "reviewer" ? "No reviewer model is set." : "No available model to start an agent with.");
    if (coolingProvider(known, model.provider, this.clock(), { except: job.taskId })) return;
    await this.store.transaction((board) => {
      const j = this.current(board, job, role);
      if (!j) return { value: null, changed: false };
      j.provider = model.provider;
      if (this.deps.handoff) {
        j.sessionModels = { ...j.sessionModels, [role]: model };
        if (role === "implementer" && !j.launchModel) j.launchModel = launch?.model ?? model;
      }
      if (switched && !j.fallback?.[role]) {
        j.fallback = { ...j.fallback, [role]: true };
        this.store.event(board, { taskId: j.taskId, actor: "system", action: "automation_fallback", note: `${modelKey(primary!)} recently reported a provider limit; the ${role} starts on its fallback model` });
      }
      return { value: null, changed: true };
    });
    const mode = model.modeId;
    let featureValues = model.featureValues;
    if (featureValues && Object.keys(featureValues).length) {
      const features = await paseo.providers.listFeatures({ provider: `${model.provider}/${model.model}`, cwd: task.sourcePath });
      if (features.error) throw new Error(features.error);
      featureValues = supportedFeatures(featureValues, features.features ?? []);
    }
    const options = {
      config: {
        provider: `${model.provider}/${model.model}`,
        systemPrompt: preparation.instructions,
        mcpServers: { flowly: preparation.mcp },
        ...(mode ? { modeId: mode } : {}),
        ...(model.thinking ? { thinkingOptionId: model.thinking } : {}),
        ...(featureValues ? { featureValues } : {}),
      },
      agentId: preparation.agentId,
      idempotencyKey: `ultra-kanban-session:${preparation.agentId}`,
      env: { FLOWLY_CONTEXT_FILE: preparation.contextFile, FLOWLY_CLI: preparation.cliPath, FLOWLY_SKILL: preparation.skillPath },
      title: (role === "reviewer" ? `${reviewTitle(job)}: ${task.title}` : task.title).slice(0, 120),
      // Flowly handles provider limits of its automation sessions itself (§4.5); the rate-fallback plugin leaves them alone.
      labels: { "flowly-task": task.id, "flowly-automation": role, "paseo-rate-fallback": "off" },
      prompt,
      ...(launch ? { images: launch.images, clientMessageId: launch.clientMessageId } : job.instruction?.comment ? { clientMessageId: job.instruction.comment.messageId } : {}),
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
    await this.consumeLaunch(job, role);
    await this.store.transaction((board) => {
      const j = jobOf(board, job.taskId);
      if (!this.confirmation(board, job, role) || !j || j.pendingOp !== op) return { value: null, changed: false };
      delete j.pendingOp;
      delete j.pendingRole;
      delete j.instruction;
      if (j.rotation?.stage === "creating" && j.rotation.toAgentId === preparation.agentId) j.rotation.confirmed = true;
      if (j.state === "starting") j.state = "working";
      j.updatedAt = this.now();
      return { value: null, changed: true };
    });
    const confirmed = jobOf(await this.store.read(), job.taskId);
    if (confirmed?.rotation?.confirmed) await this.commitRotation(confirmed);
  }

  private consumeLaunch(job: AutomationJob, role: Role) {
    if (role !== "implementer" || !job.launchKey) return Promise.resolve();
    return this.store.transaction((board) => {
      const j = jobOf(board, job.taskId);
      if (!j || j.generation !== job.generation || j.launchKey !== job.launchKey) return { value: undefined, changed: false };
      j.launchConsumed = true;
      return { value: undefined, changed: true };
    });
  }

  private reviewPause(job: AutomationJob): NonNullable<AutomationJob["reviewPause"]> {
    return {
      state: job.state as NonNullable<AutomationJob["reviewPause"]>["state"], code: job.code, detail: job.detail,
      retryAt: job.retryAt, failures: job.failures, cooldowns: job.cooldowns, verdict: job.verdict, reviewedEvent: job.reviewedEvent,
    };
  }

  private unconfirmedFor(job: AutomationJob, role: Role = job.role) {
    const start = job.unconfirmedStart;
    const id = role === "reviewer" ? job.reviewerId : job.implementerId;
    return !!job.unconfirmed && (!start || (start.role === role && (!start.agentId || start.agentId === id)));
  }

  /** A peer's casual turn or new delivery cannot resolve an uncertain start; keep its original wait reason. */
  private waitOnUnconfirmed(job: AutomationJob) {
    if (!this.unconfirmedFor(job)) return;
    job.state = "needs_human";
    job.code = job.unconfirmedStart?.code ?? "interrupted";
    job.detail = job.unconfirmedStart?.detail ?? "The session start was not confirmed. Check it before resuming.";
  }

  /** The session whose creation was unconfirmed exists: from now on its absence means it is gone. */
  private confirmed(seen: AutomationJob) {
    return this.store.transaction((board) => {
      const job = jobOf(board, seen.taskId);
      if (!job || !this.unconfirmedFor(job) || job.unconfirmedStart?.creating === false || job.generation !== seen.generation || activeAgent(job) !== activeAgent(seen)) return { value: null, changed: false };
      delete job.unconfirmed;
      delete job.unconfirmedStart;
      if (job.rotation?.stage === "creating" && job.rotation.toAgentId === activeAgent(job)) {
        job.rotation.confirmed = true;
        job.state = job.role === "reviewer" ? "reviewing" : "working";
        delete job.instruction; delete job.pendingOp; delete job.pendingRole; delete job.code;
      }
      return { value: null, changed: true };
    });
  }

  /** The first instruction reached the session. */
  private started(job: AutomationJob, agentId: string) {
    return this.store.transaction((board) => {
      const j = jobOf(board, job.taskId);
      if (!j || !this.confirmation(board, job, job.role) || (job.role === "reviewer" ? j.reviewerId : j.implementerId) !== agentId) return { value: null, changed: false };
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
    logFailure("Flowly automation could not reach the session:", message);
    let switched = false;
    let abandoned: AutomationJob | undefined;
    let safeRollback = false;
    if (seen.rotation && !seen.rotation.forced && seen.rotation.stage === "creating" && !seen.rotation.confirmed) {
      const old = await this.api().agents.ref(seen.rotation.fromAgentId).refresh().then(x => x?.agent ?? null, () => undefined);
      const successor = seen.rotation.toAgentId ? await this.api().agents.ref(seen.rotation.toAgentId).refresh().then(x => x?.agent ?? null, () => undefined) : null;
      safeRollback = !!old && !old.archivedAt && old.status === "idle" && !busyAgent(old) && successor === null;
    }
    await this.store.transaction((board) => {
      const job = jobOf(board, seen.taskId);
      if (!job || !this.confirmation(board, seen, role)) return { value: null, changed: false };
      const paused = job.role !== role ? {
        role: job.role, state: job.state, code: job.code, detail: job.detail, verdict: job.verdict, reviewedEvent: job.reviewedEvent,
        failures: job.failures, cooldowns: job.cooldowns, retryAt: job.retryAt,
      } : undefined;
      // The review's asynchronous result is saved without taking over its implementer's current turn.
      const settle = () => {
        if (paused) {
          job.reviewPause = this.reviewPause(job);
          Object.assign(job, paused);
        }
        return { value: null, changed: true };
      };
      if (paused) job.role = role;
      const settings = automationOf(board.projects.find((p) => p.id === job.projectId));
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      // Waiting for a person drops the instruction and any preparation: nothing is sent or created until they act.
      // A session the daemon did create stays reachable through its recorded id (turnStarted resumes it).
      const waitForPerson = (why: AutomationCode, detail: string, uncertain = !!job.pendingOp) => {
        job.state = "needs_human";
        job.code = why;
        job.detail = detail;
        job.updatedAt = this.now();
        // A late response or a peer's turn cannot confirm this particular session or prompt.
        if (uncertain) {
          job.unconfirmed = true;
          job.unconfirmedStart = {
            role, agentId: role === "reviewer" ? job.reviewerId : job.implementerId,
            creating: !!job.pendingOp, code: why, detail,
            ...(job.instruction?.reviewDelivery ? { reviewDelivery: job.instruction.reviewDelivery } : {}),
          };
        }
        delete job.pendingOp;
        delete job.pendingRole;
        delete job.instruction;
        delete job.retryAt;
        return settle();
      };
      if (code === "agent_request_outcome_unknown" || message.includes("agent_request_outcome_unknown"))
        return waitForPerson("interrupted", "The daemon cannot confirm whether the instruction reached the provider. Check the session before resuming.", true);
      if (this.deps.handoff?.measure && poisonedSession(message) && !job.pendingOp && !job.rotation && !paused && activeAgent(job)) {
        if (!job.instruction) this.instruct(job, role, job.workInstructions?.[role]?.fresh ?? (role === "reviewer" && settings ? roundPrompt(job, settings) : opening(settings, true)), undefined, "retry");
        beginRotation(job, "history", this.now(), { forced: true });
        job.rotation!.policy = { rule: "R0", boundary: "followup", reason: "The conversation rejected its context and cannot safely continue." };
        job.state = role === "reviewer" ? "reviewing" : "working"; switched = true;
        return settle();
      }
      // A known rejected send is not evidence that its review prompt was presented.
      if (job.instruction) delete job.instruction.dispatched;
      const gone = error instanceof SessionGone;
      if (!gone && providerLimited(message) && settings && fallbackModel(settings, role) && !job.fallback?.[role] && !paused) {
        // A limit while creating or messaging the session: the role continues on its fallback model (§4.5).
        this.switchToFallback(board, job, role, settings, job.instruction?.role === role ? job.instruction : undefined, { keep: !!job.pendingOp });
        switched = true;
        return settle();
      }
      if (!gone && providerLimited(message)) {
        job.cooldowns = (job.cooldowns ?? 0) + 1;
        if (job.cooldowns > cooldownLimit) return waitForPerson("cooldown", message);
        job.state = "retry_wait";
        job.code = "cooldown";
        job.detail = message;
        job.retryAt = new Date(this.clock() + cooldownDelayMs(job.cooldowns)).toISOString();
        job.updatedAt = this.now();
        return settle();
      }
      // A host hiccup is not the card's failure: retried with the cooldown backoff, without provider gating (§4.4).
      if (!gone && hostTransient(message) && (job.cooldowns ?? 0) < cooldownLimit) {
        job.cooldowns = (job.cooldowns ?? 0) + 1;
        job.state = "retry_wait";
        job.role = role;
        job.code = "start_failed";
        job.detail = message;
        job.retryAt = new Date(this.clock() + cooldownDelayMs(job.cooldowns)).toISOString();
        job.updatedAt = this.now();
        this.store.event(board, {
          taskId: job.taskId, actor: "system", action: "automation_retry",
          note: `Could not reach the ${role} session (host, ${job.cooldowns} of ${cooldownLimit}); retrying in ${Math.round(cooldownDelayMs(job.cooldowns) / 60_000)} min: ${message}`,
        });
        return settle();
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
      } else if (!gone && safeRollback && job.rotation && !job.rotation.forced && !job.rotation.confirmed) {
        abandoned = { ...job, rotation: { ...job.rotation } };
        rollbackRotation(job, this.now());
        this.store.event(board, { taskId: job.taskId, actor: "system", action: "automation_rotation_abandoned", note: `The new ${role} could not start; its healthy previous session keeps the original instruction` });
      } else if (role === "reviewer") {
        job.role = "implementer";
        job.state = "delivered";
        job.verdict = "incomplete";
        job.reviewedEvent = job.deliveryEvent;
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
      return settle();
    });
    if (abandoned) await this.deps.handoff?.abandoned?.(rotationContext(abandoned));
    // The fallback session is created on the next pass.
    if (switched) void this.kick();
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
        await this.store.transaction((b) => {
          const j = jobOf(b, job.taskId);
          if (!j || j.generation !== job.generation || !isLive(j)) return { value: null, changed: false };
          this.close(j, "stopped", "ancestor_finished");
          this.store.event(b, { taskId: j.taskId, actor: "system", action: "automation_stopped", note: "An ancestor card was cancelled, archived or removed" });
          return { value: null, changed: true };
        });
        continue;
      }
      if (job.rotation?.confirmed) { await this.commitRotation(job); continue; }
      if (job.rotation && !this.unconfirmedFor(job) && job.state !== "retry_wait") { await this.deliver(job); continue; }
      if (job.state === "queued" || job.state === "retry_wait") continue;
      const initialTurn = job.implementerId && latestLifecycle(currentBoard, job.taskId, job.implementerId);
      if (job.launchKey && !job.launchConsumed && initialTurn && initialTurn.at >= job.queuedAt) await this.consumeLaunch(job, "implementer");
      if (!this.unconfirmedFor(job) && job.instruction?.role === job.role && ["starting", "working", "reviewing"].includes(job.state)) { await this.deliver(job); continue; }
      const stale = Date.parse(job.updatedAt) + (this.deps.staleStartMs ?? 120_000) <= this.clock();
      const agentId = activeAgent(job);
      // Only a job that drives a session is recovered here; one waiting for a person waits for them.
      if (!this.unconfirmedFor(job) && stale && ["starting", "working", "reviewing"].includes(job.state) && (job.state === "starting" || job.pendingOp || !agentId)) {
        const recovered = await this.store.transaction((b) => {
          const j = jobOf(b, job.taskId);
          if (!j || !isLive(j) || j.generation !== job.generation || !automationAllowed(b, j)) return { value: null, changed: false };
          const settings = automationOf(b.projects.find((p) => p.id === j.projectId))!;
          if (j.pendingRole && j.pendingRole !== j.role) { delete j.pendingOp; delete j.pendingRole; }
          this.instruct(j, j.role, j.role === "reviewer" ? roundPrompt(j, settings) : opening(settings, !!j.implementerId || !!j.retired?.length));
          if (j.role === "reviewer") j.instruction!.reviewDelivery = j.deliveryEvent;
          j.updatedAt = this.now();
          return { value: { ...j }, changed: true };
        });
        if (recovered) await this.deliver(recovered);
        continue;
      }
      if (!agentId) continue;
      const agent = await paseo.agents.ref(agentId).refresh().then((r) => r?.agent ?? null, () => undefined);
      if (agent === undefined) continue;
      // A session whose creation was never confirmed (a preparation left by an older version too) is not lost while
      // it does not exist: the job keeps waiting for a person (§4.4).
      if (!agent && (this.unconfirmedFor(job) || (job.state === "needs_human" && job.pendingOp))) continue;
      if (!agent || agent.archivedAt || agent.workspaceId !== task.workspaceId) {
        await this.sideEffectFailed(job, job.role, new SessionGone());
        continue;
      }
      if (job.unconfirmed) await this.confirmed(job);
      const last = latestLifecycle(currentBoard, job.taskId, agentId);
      if (last?.action === "agent.turn_ended" && (!job.turnAt || last.at > job.turnAt)) await this.judgeTurnEnd(agentId);
      else if ((agent.status === "running" || agent.activeTurn) && (job.state === "waiting" || (job.state === "needs_human" && job.code !== "permission"))) await this.turnStarted(agentId);
      else if (stale && ["working", "reviewing"].includes(job.state) && agent.status !== "running" && agent.status !== "initializing" && !agent.activeTurn && !agent.pendingPermissions?.length) {
        // The daemon's own record of the session (an error, the attention its turn raised) tells how the missed turn
        // ended: it is recorded as the hook would have, and judged the same way, so the card goes on (§4.4).
        const outcome = agent.status === "closed" ? null : recoveredOutcome(agent, job.turnAt);
        if (outcome) {
          // A late hook may have recorded the real turn end meanwhile.
          const hooked = (b: Board) => { const end = latestTurnEnd(b, job.taskId, agentId); return !!end && (!job.turnAt || end.at > job.turnAt); };
          const recorded = await this.store.transaction((b) => {
            const j = jobOf(b, job.taskId);
            if (!this.current(b, job, job.role) || !j || j.updatedAt !== job.updatedAt || hooked(b)) return { value: false, changed: false };
            this.store.event(b, {
              taskId: j.taskId, actor: "system", action: "agent.turn_ended", agentId, outcome: outcome.kind,
              note: outcome.kind === "failed" ? outcome.message : "Recovered from the session's state after a missed turn hook",
            });
            return { value: true, changed: true };
          });
          if (recorded) await this.judgeTurnEnd(agentId);
          continue;
        }
        // An idle, errored or closed session proves there is no running worker, not how its missing turn ended.
        const detail =
          agent.status === "error"
            ? `The session stopped with an error and its turn outcome was not recorded${agent.lastError ? `: ${agent.lastError}` : ""}. Check it before resuming.`
            : agent.status === "closed"
              ? "The session closed and its turn outcome was not recorded. Check it before resuming."
              : "The session is idle but its turn outcome was not recorded. Check it before resuming.";
        await this.store.transaction((b) => {
          const j = jobOf(b, job.taskId);
          if (!this.current(b, job, job.role) || !j || j.updatedAt !== job.updatedAt) return { value: null, changed: false };
          j.state = "needs_human";
          j.code = "interrupted";
          j.detail = clip(detail);
          j.updatedAt = this.now();
          return { value: null, changed: true };
        });
      }
    }
  }

  /** A failed job someone took back keeps that on the job, before the card's history drops the move (AUTOMATION-SPEC §6). */
  private async recordTakeBacks() {
    const due = (board: Board) => board.automation.filter((job) => !job.takenBack && failureTakenBack(job, board.events));
    if (!due(await this.store.read()).length) return;
    await this.store.transaction((board) => {
      const jobs = due(board);
      for (const job of jobs) job.takenBack = true;
      return { value: null, changed: jobs.length > 0 };
    });
  }

  /** A waiting parent whose sub-cards settled gets their summary and works again (SUB-CARDS-SPEC §5). */
  private async wake(seen: AutomationJob) {
    const board = await this.store.read();
    const motion = motionOf(board, this.clock());
    if (!parentShouldWake(board, seen, motion)) return;
    const place = await this.occupancy(seen);
    if (place === "unavailable") return void (await this.workspaceGone(seen));
    if (place !== "free") return;
    const project = board.projects.find((p) => p.id === seen.projectId);
    const lines = (await Promise.all(childrenOf(board.links, seen.taskId).map((id) => cardHandoff(board, id, this.api(), this.deps.continuity)))).filter((line): line is SubCardLine => !!line);
    const signature = subCardSignature(board, seen.taskId, motion);
    const woken = await this.store.transaction((b) => {
      const job = jobOf(b, seen.taskId);
      if (!job || job.generation !== seen.generation) return { value: null, changed: false };
      const moving = motionOf(b, this.clock());
      if (!parentShouldWake(b, job, moving) || subCardSignature(b, job.taskId, moving) !== signature) return { value: null, changed: false };
      job.state = "working";
      job.role = "implementer";
      job.subSeen = signature;
      job.turnAt = this.now();
      job.updatedAt = job.turnAt;
      job.nudges = 0;
      delete job.code;
      this.instruct(job, "implementer", childrenPrompt(lines), undefined, "wake");
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
    if (state === "stopped") delete job.rotation;
    delete job.rotateRequested;
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

const busyAgent = (agent: { status?: string; activeTurn?: unknown; pendingPermissions?: readonly unknown[] }) =>
  agent.status === "running" || agent.status === "initializing" || !!agent.activeTurn || !!agent.pendingPermissions?.length;

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

/** The plan of the job's current review round (§5.2); jobs recorded before review levels get today's Standard plan. */
function planOf(job: AutomationJob, settings: AutomationSettings): ReviewPlan {
  return job.review ?? { level: "standard", reason: { kind: "default" }, max: settings.maxReviewRounds, size: reviewersFor(settings, job.reviewRounds) };
}

/**
 * The reviewer's instruction for the job's current round, from its recorded plan: a resend never re-resolves the
 * level. It carries the risks earlier rounds reported (§5.2.4): the session taking this round may never have seen them.
 */
function roundPrompt(job: AutomationJob, settings: AutomationSettings) {
  const plan = planOf(job, settings);
  return reviewPrompt(job.reviewRounds, plan.max, plan.size, plan.level, {
    ...(plan.level === "standard" ? {} : { why: reasonText(plan.reason) }),
    ...(job.risks?.length ? { earlier: { round: job.risksFrom?.round, risks: job.risks } } : {}),
    unattended: !!settings.unattended,
    acceptance: !!settings.acceptance,
  });
}

/** The implementer's opening instruction under the project's settings: a reviewer to expect, nobody to ask (§5.3.4). */
const opening = (settings: AutomationSettings | null | undefined, again: boolean) =>
  startPrompt({ review: !!settings?.reviewer, again, unattended: !!settings?.unattended, acceptance: !!settings?.acceptance });

/** A reviewer session's title: the level of the round it was created for, else its model slot. */
function reviewTitle(job: AutomationJob) {
  if (job.review?.level === "deep") return "Deep review";
  if (job.review?.level === "light") return "Light review";
  return seatOf(job) === "panel" ? "Panel review" : "Review";
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
