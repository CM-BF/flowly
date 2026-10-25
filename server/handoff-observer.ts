import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentModel } from "../shared/agent-defaults";
import { automationSessionRole, isLive, jobOf } from "../shared/automation";
import { type CardHandoff, type HandoffSession } from "../shared/handoff";
import type { Board } from "../shared/model";
import type { SessionPolicyFacts } from "../shared/session-measurement";
import { handoffView } from "../shared/handoff-view";
import type { AutomationHandoffBridge, RotationContext } from "./automation-rotation";
import { captureHandoff, captureLimits, captureTimeline, locatedGapKinds, type CaptureBatch, type CaptureCursor, type CaptureGap, type CaptureSemantics } from "./handoff-capture";
import { personalLine } from "./handoff-capture-records";
import { handoffGitDirectories, handoffGitSnapshot, type HandoffGitSnapshot } from "./handoff-git";
import { handoffMessageSource, handoffSource } from "./handoff-source";
import { HandoffStore, HandoffError, type HandoffCapture } from "./handoff-store";
import { BoardService } from "./service";
import type { BoardStore } from "./store";
import { measureSessionPolicyFacts, type ProviderUsageOptions } from "./provider-usage";
import { claudeSidecarBytes } from "./provider-history";
import { redactCaptureText } from "./handoff-capture-records";

const flowly = { by: { kind: "flowly" as const } };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const entryId = (prefix: string, source: string) => `${prefix}:${digest(source).slice(0, 32)}`;
const time = (at: string | undefined) => at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : 0;
const nativeCursor = (value: unknown): CaptureCursor | undefined => value && typeof value === "object" && (value as CaptureCursor).version === 1 ? value as CaptureCursor : undefined;
const stripAt = <T extends { at: string }>(value: T) => { const { at: _, ...rest } = value; return rest; };
/** Stored records are JSON: compare what would be written, so an undefined-valued key is not a change (an idle poll writes nothing). */
const stored = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
const temporary = new Set(["partial_line", "backlog", "record_budget", "aborted", "background_handle_pending", "long_line_partial", "source_missing", "source_unreadable", "read_failed", "locator_budget", "unsupported_provider", "invalid_session"]);
const kinds = { async_shell: "async_shell", exec: "exec_session", browser: "browser_tab", terminal: "terminal", workspace_script: "script", agent: "subagent", schedule: "schedule", heartbeat: "heartbeat" } as const;
type SessionDraft = NonNullable<HandoffCapture["session"]>;
type Snapshot = NonNullable<NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"]>;
type NarrationCoverage = { nativeOmitted: number; nativeTrimmed: number; nativeRange?: string; hookOmitted: number; hookTrimmed: number; rolledOff: number };
/**
 * Occurrence counts per gap group (kind + type hint): provider batches add; the hook's whole timeline adds only rows whose
 * identity was not seen (`seen`, bounded digests per group; `rows`: that group's occurrences in the last hook).
 * `located`: location-bearing gaps written individually per kind, at most captureLimits.hints before they are grouped.
 */
type GapMarks = { provider: Record<string, number>; timeline: Record<string, number>; recent: string[]; seen?: Record<string, string[]>; rows?: Record<string, number>; located?: Record<string, number> };
/** `heard`: digests of narration already on the card (any source), so a provider copy of the hook's words is not kept twice. */
type ObserverState = { liveIds?: string[]; heard?: string[]; providerK?: number; timelineK?: number; compactIds?: string[]; usageId?: string; usageAt?: string; ttl?: number; lastTurn?: string; lastRequest?: string; activeMs?: number; lastTimeline?: string; lastEndedTurnId?: string; turnStart?: { id: string; at: string; observedAt?: string }; sentMessageIds?: string[]; automationTextHashes?: string[]; narration?: NarrationCoverage; gaps?: GapMarks; scripts?: { provider: number; timeline: number }; merged?: { epoch: number; count: number } };
type Resume = Partial<CaptureCursor> & { observer?: ObserverState };
export type HandoffObservation = { timeline?: readonly unknown[]; outcome?: "completed" | "failed" | "canceled"; received?: boolean; forceGit?: boolean };
export type HandoffSessionOptions = { role?: HandoffSession["role"]; reason?: string; model?: AgentModel; previousAgentId?: string };
export type ManagedHandoffSession = { taskId: string; agentId: string };
export type HandoffObserverDeps = {
  records: HandoffStore; board: BoardStore; paseo: PaseoApi | (() => PaseoApi);
  serial: <T>(taskId: string, action: () => Promise<T>) => Promise<T>;
  syncIndex: (taskId: string) => Promise<void>; clock?: () => number;
  onCompaction?: (taskId: string, agentId: string) => void;
  /** Deterministic seams for isolated tests; production uses native, bounded readers. */
  capture?: typeof captureHandoff;
  measure?: typeof measureSessionPolicyFacts;
  usageOptions?: ProviderUsageOptions;
  git?: (taskId: string, board: Board, at: string) => Promise<{ snapshots: HandoffGitSnapshot[]; unchecked: string[] }>;
};

/** Own-card, bounded observation. Automation retains sole ownership of replacement scheduling. */
export class HandoffObserver {
  private timer?: ReturnType<typeof setInterval>;
  private controller = new AbortController();
  private stopped = false;
  private workers = new Set<Promise<unknown>>();
  private gitAt = new Map<string, number>();
  private polling = false;
  private next = 0;
  readonly bridge: AutomationHandoffBridge;
  constructor(private readonly deps: HandoffObserverDeps) {
    this.bridge = {
      measure: (context) => this.measure(context),
      prepare: (context) => this.run(context.taskId, () => this.prepare(context)),
      seal: (context) => this.run(context.taskId, () => this.seal(context)),
      committed: (context) => this.run(context.taskId, () => this.committed(context)),
      abandoned: (context) => this.run(context.taskId, () => this.abandoned(context)),
    };
  }
  private now() { return new Date(this.clock()).toISOString(); }
  private clock() { return (this.deps.clock ?? Date.now)(); }
  private api() { return typeof this.deps.paseo === "function" ? this.deps.paseo() : this.deps.paseo; }
  private run<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Handoff observation has stopped."));
    const worker = this.deps.serial(taskId, async () => { this.check(); return action(); });
    this.workers.add(worker); void worker.finally(() => this.workers.delete(worker)).catch(() => undefined);
    return worker;
  }
  private check() { if (this.stopped || this.controller.signal.aborted) throw new Error("Handoff observation was canceled."); }
  private async card(taskId: string) {
    const board = await this.deps.board.read(); this.check();
    const task = board.tasks.find((task) => task.id === taskId), project = board.projects.find((project) => project.id === task?.projectId);
    if (!task || !project) throw new Error("The card is unavailable; handoff observation was not written.");
    if (board.handoffIndex.some((entry) => entry.taskId === taskId) && !(await this.deps.records.read(taskId)))
      throw new HandoffError("HANDOFF_UNAVAILABLE", "The known handoff file is missing. Observation and session registration were refused; recover the existing record before writing.");
    return { board, task, project };
  }
  private async session(record: CardHandoff, agentId: string): Promise<HandoffSession | undefined> {
    return record.ledger.find((item) => item.agentId === agentId) ?? (await this.deps.records.sessionRecord(record.taskId, agentId)) ?? undefined;
  }
  private registration(board: Board, record: CardHandoff, agentId: string, actor: Snapshot | undefined, options: HandoffSessionOptions = {}): SessionDraft {
    const job = jobOf(board, record.taskId), retired = job?.retired?.find((item) => item.agentId === agentId);
    const role = job?.implementerId === agentId ? "implementer" : job?.reviewerId === agentId || job?.reviewers?.includes(agentId) ? "reviewer"
      : retired?.role ?? (job?.rotation?.fromAgentId === agentId ? job.rotation.role : undefined);
    return { ...this.draft(record, agentId, actor, { ...options, ...(role ? { role } : {}) }),
      ...(retired ? { endedAt: retired.at, endReason: retired.reason, reason: "recovered" } : {}) };
  }
  private draft(record: CardHandoff, agentId: string, actor: Snapshot | undefined, options: HandoffSessionOptions = {}): SessionDraft {
    return { agentId, sourceId: handoffSource(`session:${agentId}`), n: Math.max(0, ...record.ledger.map((s) => s.n)) + 1,
      role: options.role ?? "manual", provider: actor?.provider ?? options.model?.provider ?? "unknown",
      ...(actor?.model ? { model: actor.model } : options.model ? { model: options.model.model } : {}), ...(options.model ? { launchModel: options.model } : {}),
      startedAt: actor?.createdAt ?? this.now(), reason: options.reason ?? (options.previousAgentId ? "replacement" : "launch"), finalized: false, turns: [], background: [], live: [] };
  }
  private async snapshot(agentId: string, workspaceId: string) {
    const actor = (await this.api().agents.ref(agentId).refresh())?.agent; this.check();
    if (actor && (actor.id !== agentId || actor.workspaceId !== workspaceId)) throw new Error("The session does not belong to this card's workspace.");
    return actor ?? undefined;
  }
  ensureSession(taskId: string, agentId: string, options: HandoffSessionOptions = {}) {
    return this.run(taskId, async () => {
      const { board, task, project } = await this.card(taskId), record = await this.deps.records.read(taskId, project.id);
      const existing = await this.session(record, agentId), job = jobOf(board, taskId);
      if (existing) {
        const role = isLive(job) && (job?.implementerId === agentId ? "implementer" : job?.reviewerId === agentId ? "reviewer" : undefined);
        if (existing.role === "manual" && existing.reason !== "human_take_back" && role) {
          this.check(); await this.deps.records.capture(taskId, project.id, { session: { ...existing, role } }, flowly); await this.deps.syncIndex(taskId);
        }
        return;
      }
      const actor = await this.snapshot(agentId, task.workspaceId);
      const draft = this.registration(board, record, agentId, actor, options);
      this.check(); await this.deps.records.capture(taskId, project.id, { session: draft }, flowly); await this.deps.syncIndex(taskId);
    });
  }
  observe(taskId: string, agentId: string, options: HandoffObservation = {}) { return this.run(taskId, () => this.observeNow(taskId, agentId, options)); }
  /** Pure reads deliberately bypass the service's per-card queue: comments may already hold it. */
  measure(context: { taskId: string; agentId: string }): Promise<SessionPolicyFacts> {
    const worker = (async () => {
      this.check();
      const { board, task, project } = await this.card(context.taskId);
      const record = await this.deps.records.read(task.id, project.id), session = await this.session(record, context.agentId);
      const role = automationSessionRole(board, context.agentId, task.id, session ? [session] : []);
      if (!session && !role) throw new Error("Only a managed session of this card can be measured.");
      let actor: Snapshot | undefined;
      try { actor = await this.snapshot(context.agentId, task.workspaceId); }
      catch (error) { this.check(); if (String(error).includes("does not belong")) throw error; }
      const facts = await (this.deps.measure ?? measureSessionPolicyFacts)(actor ?? { id: context.agentId, provider: session?.provider }, session,
        { ...this.deps.usageOptions, now: () => this.clock(), signal: this.controller.signal });
      this.check();
      const gaps = record.gaps.filter((gap) => gap.status === "open" && !gap.unconfirmed && (!gap.agentId || gap.agentId === context.agentId)).length
        + record.overflow.filter((item) => item.section === "gaps" && item.status === "open" && !item.unconfirmed).length;
      if (gaps) facts.coverage = { ...facts.coverage, gaps: Math.max(facts.coverage?.gaps ?? 0, gaps) };
      if (!actor) facts.unknown = [...facts.unknown ?? [], "session snapshot unavailable"];
      return facts;
    })();
    this.workers.add(worker); void worker.finally(() => this.workers.delete(worker)).catch(() => undefined);
    return worker;
  }
  private async git(taskId: string, board: Board, at: string) {
    if (this.deps.git) return this.deps.git(taskId, board, at);
    const context = await new BoardService(this.deps.board).context(taskId, this.api(), board);
    const locations = await handoffGitDirectories(context.directories.map((entry) => entry.directory));
    const snapshots = await Promise.all(locations.directories.map((path) => handoffGitSnapshot(path, undefined, at)));
    return { snapshots, unchecked: locations.unchecked };
  }
  private gap(agentId: string, source: string, text: string): NonNullable<HandoffCapture["entries"]>[number] {
    const sourceId = handoffSource(source);
    return { section: "gaps", value: { id: entryId("g", sourceId), sourceId, kind: "flowly", agentId, text: text.slice(0, 300), status: "open" } };
  }
  private async observeNow(taskId: string, agentId: string, options: HandoffObservation = {}) {
    const { board, task, project } = await this.card(taskId);
    if (task.archivedAt || project.archivedAt) return;
    const record = await this.deps.records.read(taskId, project.id), previous = await this.session(record, agentId);
    let actor: Snapshot | undefined, snapshotFailed = false;
    try { actor = await this.snapshot(agentId, task.workspaceId); } catch (error) { this.check(); if (String(error).includes("does not belong")) throw error; snapshotFailed = true; }
    const role = automationSessionRole(board, agentId, taskId, previous ? [previous] : [])?.role;
    const session = previous ?? this.registration(board, record, agentId, actor);
    const resume = session.through?.resume as Resume | undefined, state: ObserverState = { ...(resume?.observer ?? {}) };
    const job = jobOf(board, taskId);
    const instructions = [job?.instruction, job?.workInstructions?.implementer, job?.workInstructions?.reviewer, job?.rotation?.carry, job?.rotation?.finalize].filter((item) => !!item);
    const ids = [...(state.sentMessageIds ?? []), ...instructions.map((item) => item.id), ...board.events.filter((event) => event.taskId === taskId && event.agentId === agentId && event.actor === "system" && event.action === "automation_sent").flatMap((event) => event.operationId ? [event.operationId] : [])];
    const textHashes = [...(state.automationTextHashes ?? []), ...instructions.map((item) => digest(item.text))];
    state.sentMessageIds = [...new Set(ids)].slice(-128); state.automationTextHashes = [...new Set(textHashes)].slice(-128);
    const received = options.received !== false && role !== "retired" && role !== "finalizing" && !previous?.endedAt;
    let batch: CaptureBatch | undefined, captureFailed = false;
    if (actor) {
      try { batch = await (this.deps.capture ?? captureHandoff)(actor, nativeCursor(resume), { signal: this.controller.signal, now: () => this.clock(), sentMessageIds: state.sentMessageIds, automationTextHashes: state.automationTextHashes }); }
      catch { this.check(); captureFailed = true; }
    }
    this.check();
    const hook = options.timeline ? captureTimeline(agentId, options.timeline, { now: () => this.clock(), outcome: options.outcome, received, sentMessageIds: state.sentMessageIds, automationTextHashes: state.automationTextHashes }) : undefined;
    const semantics = [batch, hook].filter((value): value is CaptureSemantics => !!value);
    const entries: NonNullable<HandoffCapture["entries"]> = [];
    // Codex's own copy of a message has no Paseo id (§5.7): match it to the card's inputs by text, never store the same words twice.
    const normalized = (text: string) => digest(text.trim().replace(/\s+/g, " "));
    const sameText = (entry: { text?: string; sourceHash?: string; textRef?: string }, text: string) => entry.text !== undefined ? normalized(entry.text) === normalized(text) : (entry.sourceHash ?? entry.textRef) === digest(text);
    const providerCopy = (entry: { sourceId?: string }) => !!entry.sourceId?.startsWith(`provider-user:${agentId}:`);
    const pass: Record<string, unknown>[] = [];
    for (const source of semantics) for (const input of source.inputs) {
      const sourceId = input.messageId ? handoffMessageSource(agentId, input.messageId) : handoffSource(input.id);
      this.check();
      let old = record.inputs.find((value) => value.sourceId === sourceId) ?? await this.deps.records.inputRecord(taskId, sourceId), twin = false;
      if (!old && input.unlinked && [...record.inputs, ...pass].some((value) => sameText(value as { text?: string }, input.text))) continue;
      if (!old && input.messageId && !input.unlinked) {
        const queued = pass.find((value) => providerCopy(value) && (value.messageId === input.messageId || !value.messageId && sameText(value as { text?: string }, input.text)));
        if (queued) { queued.messageId = input.messageId; if (input.status === "received" && (received || input.via === "agent")) queued.status = "received"; continue; }
        old = record.inputs.find((value) => providerCopy(value) && value.messageId === input.messageId) ?? record.inputs.find((value) => providerCopy(value) && !value.messageId && sameText(value, input.text)) ?? null;
        twin = !!old;
      }
      const status = old && old.status !== "open" ? old.status : input.status === "received" && (received || input.via === "agent") ? "received" : "open";
      const mismatch = !twin && old?.atSource === "captured" && old.sourceHash && old.sourceHash !== digest(input.text);
      if (old && !mismatch && (old.status === status || status !== "received") && !(twin && !old.messageId)) continue;
      const value = old ? { ...old, ...(mismatch ? { text: input.text, textRef: undefined, firstLine: undefined, sourceHash: undefined, contentRef: undefined, characters: input.text.length } : {}), ...(twin ? { messageId: input.messageId } : {}), status } : { id: entryId("d", sourceId), sourceId, agentId, via: role === "retired" ? "retired_session" : input.via,
        atSource: "captured", text: input.text, characters: input.text.length, status, at: input.at, ...(input.redacted ? { redacted: true } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}), ...(input.senderId || input.senderTitle ? { from: { agentId: input.senderId, title: input.senderTitle?.slice(0, 120) } } : {}) };
      if (!old) pass.push(value);
      entries.push({ section: "inputs", value });
    }
    const meta = state;
    const gapUpdates = this.captureGaps(agentId, meta, batch, hook);
    const background = [...session.background];
    /**
     * The oldest evidence-free item of a kind (no handle was ever seen): a completion whose start was not itemized settles it. Exec placeholders are only the "completion not observed" ones.
     * A call in flight is not one: its own result is still to come, and it would come back on the next poll while the call runs.
     */
    const placeholder = (kind: HandoffSession["background"][number]["kind"]) => {
      const candidates = background.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.status !== "closed" && !entry.inFlight && entry.kind === kind && entry.ref.startsWith("unknown:") && (kind !== "exec_session" || /:exec(?::\d+)?$/.test(entry.callId ?? "")));
      return candidates.sort((a, b) => time(a.entry.startedAt) - time(b.entry.startedAt) || a.index - b.index)[0]?.index ?? -1;
    };
    for (const source of semantics) for (const item of source.background) {
      const outcome = item.outcome ? { outcome: item.outcome.slice(0, 120) } : {};
      if (item.closeOnly) {
        // A completion closes what was recorded (for any kind: a task id names one task); it never adds an entry.
        let index = background.findIndex((entry) => entry.id === entryId("bg", item.id) || item.callId && entry.callId === item.callId || item.handle && entry.ref === item.handle);
        if (index < 0 && item.late) index = placeholder(kinds[item.kind]);
        // An in-flight placeholder whose result started nothing that runs leaves nothing to hand over (SESSION-HANDOFF-SPEC §5.7).
        if (index >= 0 && background[index].inFlight) background.splice(index, 1);
        else if (index >= 0 && background[index].status !== "closed") background[index] = { ...background[index], status: "closed", ...outcome };
        // What a background notice said stays on the card, matched or not (SESSION-HANDOFF-SPEC §5.7, §9.3).
        if (item.note) {
          const sourceId = handoffSource(`capture-notice:${agentId}:${item.note.id}`);
          entries.push({ section: "notes", value: { id: entryId("nt", sourceId), sourceId, kind: item.note.kind, at: item.at, text: item.note.text.slice(0, 2000) } });
        }
        continue;
      }
      const kind = kinds[item.kind];
      let index = background.findIndex((entry) => entry.id === entryId("bg", item.id) || item.callId && entry.callId === item.callId || item.handle && entry.kind === kind && entry.ref === item.handle);
      if (index < 0 && item.late && item.status === "closed") index = placeholder(kind);
      const old = index >= 0 ? background[index] : undefined;
      if (old?.inFlight && item.status === "closed") { background.splice(index, 1); continue; }
      // A reprinted start never reopens what was proven ended; only new work (a sub-agent's follow-up task) does.
      if (old?.status === "closed" && item.status !== "closed" && !item.reopen) {
        // A placeholder settled before its result arrived learns the real handle, so later evidence about it finds it.
        if (old.ref.startsWith("unknown:") && item.handle && !item.inFlight) { const { inFlight: _, ...settled } = old; background[index] = { ...settled, ref: item.handle, ...(item.label && !item.keepLabel ? { label: item.label.slice(0, 120) } : {}) }; }
        continue;
      }
      const reopened = old?.status === "closed" && !!item.reopen;
      const next: HandoffSession["background"][number] = { id: old?.id ?? entryId("bg", item.id), ...(item.callId ? { callId: item.callId.slice(0, 200) } : old?.callId ? { callId: old.callId } : {}), kind,
        ref: item.handle ?? old?.ref ?? `unknown:${item.callId ?? item.id}`, label: ((item.keepLabel && old?.label) || item.label || old?.label || kind).slice(0, 120), startedAt: reopened ? item.at : old?.startedAt ?? item.at,
        status: item.status === "unknown" && old ? old.status : item.status, ...(item.outcome ? outcome : old?.outcome && !reopened ? { outcome: old.outcome } : {}), source: old?.source ?? (source === hook ? "hook" : "live"),
        // Still only the call, its result unread: the placeholder stays observation state until evidence arrives.
        ...(item.inFlight && (!old || old.inFlight) ? { inFlight: true as const } : {}) };
      if (index >= 0) background[index] = next; else background.push(next);
    }
    this.mergeBackground(agentId, session.n, background, meta, entries);
    if (background.length > 40) {
      background.sort((a, b) => Number(a.status !== "closed") - Number(b.status !== "closed"));
      background.splice(0, background.length - 40); // Only proven closed handles leave this bounded index.
    }
    const live = new Map<string, HandoffSession["live"][number]>();
    (meta.liveIds ?? []).forEach((id, index) => { if (session.live[index]) live.set(id, session.live[index]); });
    const originalLive = new Map(live);
    // The same words reach the card from the provider file and from the turn-end hook under different ids (§5.7): the hook's
    // copy replaces a provider copy (keeping the timeline's order), and a provider copy of words already heard is dropped.
    const words = (text: string) => normalized(text).slice(0, 12), heard = new Set(meta.heard ?? []), hookIds = new Set(hook?.live.map((item) => item.id) ?? []);
    for (const source of semantics) for (const item of source.live) {
      const old = originalLive.get(item.id), key = words(item.text);
      if (source === hook) { for (const [id, value] of live) if (id !== item.id && !hookIds.has(id) && words(value.text) === key) live.delete(id); }
      else if (!old && (heard.has(key) || [...live].some(([id, value]) => id !== item.id && words(value.text) === key))) continue;
      heard.add(key); live.delete(item.id);
      live.set(item.id, old && old.text === item.text ? { ...old, ...(item.truncated ? { truncated: true } : {}) } : { at: item.at, text: item.text.slice(0, 800), ...(item.truncated || item.text.length > 800 ? { truncated: true } : {}) });
    }
    meta.heard = [...heard].slice(-32);
    let rolledOff = 0;
    while (live.size > 8 || [...live.values()].reduce((sum, item) => sum + item.text.length, 0) > 4000) { live.delete(live.keys().next().value!); rolledOff++; }
    meta.liveIds = [...live.keys()];
    const measured = { turns: 0, ...(session.measured ?? {}) };
    const usage = semantics.flatMap((source) => source.usage);
    const initial = usage.find((entry) => entry.initialContextTokens !== undefined);
    if (measured.C0 === undefined && initial) measured.C0 = initial.initialContextTokens;
    const latest = usage.at(-1);
    if (latest && (meta.usageId !== latest.id) && (!meta.usageAt || time(latest.at) >= time(meta.usageAt))) {
      measured.C = latest.contextTokens; if (latest.windowTokens !== undefined) measured.W = latest.windowTokens;
      if (measured.C0 === undefined && latest.initialContextTokens !== undefined) measured.C0 = latest.initialContextTokens;
      measured.peakC = Math.max(measured.peakC ?? 0, latest.contextTokens); meta.usageId = latest.id; meta.usageAt = latest.at;
      if (latest.atSource === "provider" && Number.isFinite(Date.parse(latest.at))) meta.lastRequest = latest.at;
      if (latest.cacheTtlSeconds !== undefined) meta.ttl = latest.cacheTtlSeconds;
    }
    if (usage.length) measured.peakC = Math.max(measured.peakC ?? 0, ...usage.map((entry) => entry.contextTokens));
    const realUsage = actor?.lastUsage;
    if (!latest && realUsage?.contextWindowUsedTokens !== undefined && !batch?.coverage.backlogBytes) {
      measured.C = realUsage.contextWindowUsedTokens; measured.peakC = Math.max(measured.peakC ?? 0, measured.C);
      if (realUsage.contextWindowMaxTokens !== undefined) measured.W = realUsage.contextWindowMaxTokens;
    }
    const known = new Set(meta.compactIds ?? []);
    const newCompacts = batch?.compactions.filter((value) => !known.has(value.id)) ?? [];
    meta.providerK = (meta.providerK ?? 0) + newCompacts.length;
    meta.timelineK = Math.max(meta.timelineK ?? 0, hook?.compactions.length ?? 0);
    const priorK = measured.K ?? 0; measured.K = Math.max(priorK, meta.providerK, meta.timelineK);
    // A sharp observed drop refreshes the next card view, but never invents a confirmed K event.
    const compacted = measured.K > priorK || session.measured?.C !== undefined && measured.C !== undefined && measured.C < session.measured.C * 0.6;
    newCompacts.forEach((item) => known.add(item.id)); meta.compactIds = [...known].slice(-64);
    // A confirmed compaction is a fact about that session's memory, not missing card content: a note, never a gap.
    const fresh = meta.providerK >= measured.K ? newCompacts.slice(priorK - measured.K) : (hook?.compactions ?? []).slice(priorK, measured.K);
    for (let k = priorK + 1; k <= measured.K; k++) {
      const event = fresh[k - priorK - 1], when = event?.at ?? this.now(), sourceId = handoffSource(`compaction:${agentId}:${k}`);
      const tokens = event?.preTokens !== undefined ? ` (about ${event.preTokens} tokens before it)` : "";
      entries.push({ section: "notes", value: { id: entryId("nt", sourceId), sourceId, kind: "other", text: `Session #${session.n} (${agentId.slice(0, 8)}): its context was compacted ${event?.captured ? "by" : "at"} ${when}${tokens}. Details from before then may be missing from that session's memory; its raw session history is unchanged.` } });
    }
    if (batch?.coverage.fileBytes !== undefined) measured.B = batch.coverage.fileBytes;
    if (batch?.source?.provider === "claude") {
      const sidecars = await claudeSidecarBytes(batch.source, this.clock(), this.controller.signal); this.check();
      if (sidecars.bytes !== undefined) measured.S = sidecars.bytes;
      if (sidecars.bytes !== undefined && sidecars.bytes >= 512 * 2 ** 20) {
        const sourceId = handoffSource(`claude-sidecar-warning:${agentId}`);
        entries.push({ section: "notes", value: { id: entryId("nt", sourceId), sourceId, kind: "hazard", text: `Claude subagent/workflow files total ${Math.round(sidecars.bytes / 2 ** 20)} MiB${sidecars.limited ? " or more (stat budget reached)" : ""}. This is an observation only; these sidecars do not trigger replacement or interruption.` } });
      }
    }
    const growth = new Map((session.growth ?? []).map((item) => [item.kind, { ...item }]));
    for (const [kind, value] of Object.entries(batch?.cursor ? batch.growth : {})) {
      const key = growth.has(kind) || growth.size < 11 ? kind : "other", old = growth.get(key) ?? { kind: key, calls: 0, bytes: 0 };
      old.calls += value.lines; old.bytes += value.bytes; growth.set(key, old);
    }
    if (actor?.activeTurn?.startedAt) meta.turnStart = { id: actor.activeTurn.turnId, at: actor.activeTurn.startedAt, observedAt: this.now() };
    const timelineKey = hook && digest(JSON.stringify({ inputs: hook.inputs.map((m) => m.id), live: hook.live.map((m) => m.id), background: hook.background.map((m) => [m.id, m.status]), compactions: hook.compactions.map((m) => m.id), outcome: options.outcome }));
    const turns = [...session.turns];
    if (hook && options.outcome && (meta.turnStart ? meta.lastEndedTurnId !== meta.turnStart.id : meta.lastTimeline !== timelineKey)) {
      const last = hook.live.at(-1), stamp = this.now();
      // Native repeated turn-end deliveries have identical timelines. No invented start time.
      const startedAt = meta.turnStart?.at ?? stamp;
      const wroteHandoff = record.checkpoint?.agentId === agentId && time(record.checkpoint.at) >= time(startedAt);
      measured.turns++; turns.push({ n: measured.turns, startedAt, endedAt: stamp, outcome: options.outcome,
        ...(last ? { final: last.text.slice(0, 2000) } : {}), wroteHandoff });
      // Hook delivery can be late: only count the interval proven by an active snapshot, never all session age.
      if (meta.turnStart && time(meta.turnStart.at) > 0 && time(meta.turnStart.observedAt) >= time(meta.turnStart.at))
        meta.activeMs = (meta.activeMs ?? 0) + time(meta.turnStart.observedAt) - time(meta.turnStart.at);
      if (!wroteHandoff && time(stamp) - time(startedAt) >= 300_000) {
        const sourceId = handoffSource(`unwritten-turn:${agentId}:${timelineKey}`);
        entries.push({ section: "notes", value: { id: entryId("nt", sourceId), sourceId, kind: "hazard", text: "A work turn of at least five minutes ended without an agent handoff checkpoint. Its reasoning may exist only in the session; verify the captured narration and saved outputs before continuing." } });
      }
      if (meta.turnStart) meta.lastEndedTurnId = meta.turnStart.id;
      delete meta.turnStart;
      meta.lastTurn = stamp; meta.lastTimeline = timelineKey;
    }
    for (const source of semantics) for (const notice of source.notices) {
      const sourceId = handoffSource(`capture-notice:${agentId}:${notice.id}`);
      entries.push({ section: "notes", value: { id: entryId("nt", sourceId), sourceId, kind: notice.kind ?? "other", at: notice.at, text: notice.text.slice(0, 2000) } });
    }
    const scripts = { provider: (meta.scripts?.provider ?? 0) + (batch?.cursor ? batch.scriptCalls : 0), timeline: Math.max(meta.scripts?.timeline ?? 0, hook?.scriptCalls ?? 0) };
    if (scripts.provider || scripts.timeline) meta.scripts = scripts;
    const scriptCalls = Math.max(scripts.provider, scripts.timeline);
    const narration: NarrationCoverage = { nativeOmitted: 0, nativeTrimmed: 0, hookOmitted: 0, hookTrimmed: 0, rolledOff: 0, ...(meta.narration ?? {}) };
    const nativeRange = batch?.cursor && `${batch.cursor.fileId}:${batch.cursor.epoch}:${batch.coverage.from}:${batch.coverage.through}:${batch.narrationOmitted}:${batch.narrationTrimmedChars}`;
    if (nativeRange && nativeRange !== narration.nativeRange && (batch!.narrationOmitted || batch!.narrationTrimmedChars)) {
      narration.nativeOmitted += batch!.narrationOmitted; narration.nativeTrimmed += batch!.narrationTrimmedChars; narration.nativeRange = nativeRange;
    }
    if (hook) { narration.hookOmitted = hook.narrationOmitted; narration.hookTrimmed = hook.narrationTrimmedChars; }
    narration.rolledOff += rolledOff; meta.narration = narration;
    const narrationLoss = narration.nativeOmitted + narration.nativeTrimmed + narration.hookOmitted + narration.hookTrimmed + narration.rolledOff > 0;
    const narrationText = narrationLoss ? `Narration preview incomplete: native capture omitted ${narration.nativeOmitted} messages and trimmed ${narration.nativeTrimmed} characters; latest hook omitted ${narration.hookOmitted} messages and trimmed ${narration.hookTrimmed} characters; ${narration.rolledOff} older preview messages rolled off. The full narration is not preserved in this card excerpt.` : "";
    // A start call whose result is not written yet is its own in-flight background item; it is not missing coverage.
    const currentGaps = semantics.flatMap((source) => source.gaps).filter((gap) => temporary.has(gap.kind) && gap.kind !== "background_handle_pending");
    const unavailable = captureFailed ? ["Provider capture failed; the previous cursor is preserved."] : !actor ? [snapshotFailed ? "Session snapshot could not be refreshed." : "The managed session is unavailable; its uncaptured content is unknown."] : [];
    const coverageText = [...unavailable, ...(narrationText ? [narrationText] : []), ...currentGaps.map((gap) => `${gap.kind}${gap.bytes === undefined ? "" : ` (${gap.bytes} bytes)`}`), ...semantics.filter((source) => source.omittedGaps).map((source) => `${source.omittedGaps} additional capture gaps omitted`)].join("; ");
    const cursor = batch?.cursor ?? nativeCursor(resume);
    const through = { ...(session.through ?? { path: "", identity: `unavailable:${agentId}`, offset: 0, size: 0, at: this.now(), lagBytes: 0, gaps: 0 }),
      ...(cursor ? { path: cursor.path, identity: `${cursor.fileId}:${cursor.epoch}`, offset: cursor.offset } : {}),
      ...(batch?.coverage.fileBytes !== undefined ? { size: batch.coverage.fileBytes, lagBytes: batch.coverage.backlogBytes } : {}),
      gaps: currentGaps.length + unavailable.length + semantics.reduce((sum, source) => sum + source.omittedGaps, 0),
      resume: { ...(cursor ?? resume ?? {}), observer: meta } };
    const oldThrough = session.through && stripAt(session.through), changedThrough = !isDeepStrictEqual(stored(oldThrough), stored(stripAt(through)));
    if (changedThrough) through.at = this.now();
    const anchors = [...new Set([...(session.anchors ?? []), ...semantics.flatMap((source) => source.anchors)])].slice(-60);
    const scriptText = scriptCalls ? ` ${scriptCalls} script or workflow calls ran here; Flowly lists only background work they evidently left running, and their other inner tool calls remain in the session's raw history.` : "";
    const nextSession: SessionDraft = { ...session, ...(actor ? { provider: actor.provider, ...(actor.model ? { model: actor.model } : {}), ...(session.provider === "unknown" ? { startedAt: actor.createdAt } : {}) } : {}), sourceId: handoffSource(`session:${agentId}`), measured, growth: [...growth.values()], background,
      live: [...live.values()], turns: turns.slice(-10), through, ...(scriptCalls ? { scriptCalls } : {}), ...(anchors.length ? { anchors } : {}), ...(coverageText ? { skeleton: `Current capture coverage: ${coverageText}. Narration is a bounded excerpt, not the full transcript.${scriptText}`.slice(0, 2000) } : { skeleton: `Current capture reached the available source. Narration is a bounded excerpt, not the full transcript; skipped or unsupported content is listed separately in gaps.${scriptText}` }) };
    // Stable ids let the store deduplicate archived entries, but avoid even a no-op transaction for current records.
    const existingSources = new Set([...record.gaps, ...record.notes, ...record.overflow].map((entry) => entry.sourceId));
    const unique = new Map(entries.filter((entry) => entry.section === "inputs" || !existingSources.has(entry.value.sourceId as string)).map((entry) => [String(entry.value.sourceId), entry]));
    let git: HandoffGitSnapshot[] | undefined;
    // Repositories are polled for a session in a turn (SESSION-HANDOFF-SPEC §4 item 2), at most once per card every 2 minutes,
    // also when the read fails. An idle card is read at its turn ends, rotations and handoff writes (forceGit), and an ACK
    // reads the heads itself: polling it recorded every change other cards made in a shared project root (live: about one
    // revision per card every 2 minutes, each moving the revision a prepared ACK names).
    const inTurn = !!actor && (["running", "initializing"].includes(actor.status) || !!actor.activeTurn);
    if (options.forceGit || inTurn && this.clock() - (this.gitAt.get(taskId) ?? -Infinity) >= 120_000) {
      this.gitAt.set(taskId, this.clock());
      try {
        const observed = await this.git(taskId, board, this.now()); this.check();
        if (!isDeepStrictEqual(observed.snapshots.map(stripAt), record.git.map(stripAt))) git = observed.snapshots;
        if (observed.unchecked.length) {
          const source = `git-coverage:${taskId}:${digest(observed.unchecked.join())}`;
          if (!existingSources.has(source)) unique.set(source, this.gap(agentId, source, `${observed.unchecked.length} repository locations were not inspected. Git coverage is partial; verify the remaining directories.`));
        }
      } catch { this.check(); const source = `git-unavailable:${taskId}`; if (!existingSources.has(source)) unique.set(source, this.gap(agentId, source, "Repository state could not be observed. Do not assume the checkout is clean or unchanged.")); }
    }
    this.check();
    const changedSession = !previous || !isDeepStrictEqual(stored(this.comparable(previous)), stored(this.comparable(nextSession)));
    if (!changedSession && !unique.size && !git && !compacted && !gapUpdates.length) return;
    const written = await this.deps.records.capture(taskId, project.id, { ...(unique.size ? { entries: [...unique.values()] } : {}), ...(gapUpdates.length ? { gaps: gapUpdates } : {}), ...(changedSession ? { session: nextSession } : {}),
      ...(changedThrough ? { cursor: { agentId, through, capturedThrough: this.clock() } } : {}), ...(git ? { git } : {}), ...(compacted ? { forgetSeen: [agentId] } : {}),
      ...(hook?.live.length && options.outcome && meta.lastTimeline !== (resume?.observer?.lastTimeline) ? { lastWords: { agentId, at: this.now(), since: record.checkpoint?.at ?? session.startedAt, text: hook.live.at(-1)!.text.slice(0, 2000) } } : {}) }, flowly);
    if (compacted) this.deps.onCompaction?.(taskId, agentId);
    // Entries already stored (an archived gap observed again) change nothing; the store kept the revision and the index stands.
    if (written.handoffRevision === record.revision) return;
    this.check(); await this.deps.syncIndex(taskId);
  }
  /**
   * One open gap per session, kind and type hint, however many times it occurs (SESSION-HANDOFF-SPEC §5.7).
   * Counts are absolute and idempotent: a committed provider batch is never re-read, a cursorless batch is
   * deduplicated by occurrence id, and the hook's whole timeline adds only rows whose identity was not seen. Location-bearing
   * gaps (a skipped long paste, an unparsable line) are their own entries, the first captureLimits.hints per kind.
   */
  private captureGaps(agentId: string, meta: ObserverState, batch: CaptureBatch | undefined, hook: CaptureSemantics | undefined): NonNullable<HandoffCapture["gaps"]> {
    const marks: GapMarks = { provider: { ...(meta.gaps?.provider ?? {}) }, timeline: { ...(meta.gaps?.timeline ?? {}) }, recent: [...(meta.gaps?.recent ?? [])], seen: { ...(meta.gaps?.seen ?? {}) }, rows: { ...(meta.gaps?.rows ?? {}) }, located: { ...(meta.gaps?.located ?? {}) } };
    const total = (key: string) => Math.max(marks.provider[key] ?? 0, marks.timeline[key] ?? 0);
    const known = new Set([...Object.keys(marks.provider), ...Object.keys(marks.timeline)]), before = new Map([...known].map((key) => [key, total(key)]));
    // At most captureLimits.hints type hints per kind and session; further hints share one "other types" group.
    const groupKey = (gap: CaptureGap) => {
      const key = `${gap.kind}\0${gap.typeHint ?? ""}`;
      if (known.has(key) || gap.typeHint === undefined || [...known].filter((other) => other.startsWith(`${gap.kind}\0`) && !other.endsWith("\0")).length < captureLimits.hints) { known.add(key); return key; }
      known.add(`${gap.kind}\0*`); return `${gap.kind}\0*`;
    };
    const ranges = (gap: CaptureGap) => gap.ranges ?? (gap.from !== undefined ? [`${gap.from}–${gap.to ?? gap.from}`] : []);
    const span = (a: CaptureGap | undefined, b: CaptureGap): CaptureGap => ({ ...(a ?? b), count: (a?.count ?? 0) + (b.count ?? 1), at: [a?.at, b.at].filter((v): v is string => !!v).sort()[0], lastAt: [a?.lastAt, b.lastAt ?? b.at].filter((v): v is string => !!v).sort().at(-1), occurrences: [...(a?.occurrences ?? []), ...(b.occurrences ?? [])].slice(-512),
      ...(locatedGapKinds.has(b.kind) ? { ranges: [...(a ? ranges(a) : []), ...ranges(b)].slice(0, captureLimits.ranges) } : {}) });
    const grouped = (gaps: readonly CaptureGap[] = []) => {
      const result = new Map<string, CaptureGap>();
      for (const gap of gaps) if (!temporary.has(gap.kind) && !locatedGapKinds.has(gap.kind)) { const key = groupKey(gap); result.set(key, span(result.get(key), gap)); }
      return result;
    };
    const changed = new Map<string, CaptureGap>(), updates: NonNullable<HandoffCapture["gaps"]> = [];
    // Where skipped content that may be a person's words is (byte range, message id, length) stays with each occurrence: the
    // first few per kind are their own gaps. Tool output and other records that are not a person's words, and occurrences past
    // those few, are one gap per type hint, counted by occurrence, that lists where the first ones are.
    for (const gap of (batch?.gaps ?? []).filter((value) => locatedGapKinds.has(value.kind) && !temporary.has(value.kind))) {
      if (!batch?.cursor) { if (marks.recent.includes(gap.id)) continue; marks.recent = [...marks.recent, gap.id].slice(-32); }
      const written = marks.located![gap.kind] ?? 0, personal = !gap.kind.startsWith("long_line") || personalLine(gap.typeHint);
      if (!personal || (gap.count ?? 1) > 1 || written >= captureLimits.hints) { const key = `${gap.kind}\0${gap.typeHint ?? ""}`; marks.provider[key] = (marks.provider[key] ?? 0) + (gap.count ?? 1); changed.set(key, span(changed.get(key), { ...gap, count: 0 })); continue; }
      marks.located![gap.kind] = written + 1;
      const from = gap.from ?? gap.source?.offset, to = gap.to ?? gap.source?.end, messageId = gap.source?.messageId;
      const sourceId = handoffSource(`capture-gap:${agentId}:${gap.id}`);
      updates.push({ id: entryId("g", sourceId), sourceId, agentId, count: 1, ...(gap.at ? { firstAt: gap.at, lastAt: gap.at } : {}),
        text: `Capture gap (${gap.kind})${from === undefined ? "" : ` in bytes ${from}–${to ?? from}`}${gap.typeHint ? `: ${gap.typeHint}` : ""}${messageId ? `, message ${messageId}` : ""}${gap.bytes === undefined ? "" : `, ${gap.bytes} bytes`}. This content was not preserved; that range of the session's raw history holds it.`.slice(0, 300) });
    }
    if (updates.length) meta.gaps = marks;
    for (const [key, gap] of grouped(batch?.gaps)) {
      // A committed batch is new source text; a cursorless one (identity mismatch) repeats until resolved.
      if (!batch?.cursor) { if (marks.recent.includes(gap.id)) continue; marks.recent = [...marks.recent, gap.id].slice(-32); }
      marks.provider[key] = (marks.provider[key] ?? 0) + (gap.count ?? 1); changed.set(key, gap);
    }
    // The hook carries the whole in-memory timeline again at each turn end, rebuilt (shorter) after a daemon restart:
    // only rows whose identity was not seen are new. A legacy high-water mark counts as that many seen rows.
    for (const [key, gap] of grouped(hook?.gaps)) {
      const occurrences = gap.occurrences ?? [], ids = occurrences.map((value) => digest(value).slice(0, 10)), legacy = marks.seen![key] === undefined ? ids.slice(0, marks.timeline[key] ?? 0) : [];
      // Rows without an identity are known only by position: a shorter timeline is a rebuilt one, so those positions are new rows.
      const rebuilt = ids.length < (marks.rows![key] ?? 0), positional = new Set(ids.filter((_, index) => occurrences[index].startsWith("pos:")));
      const seen = new Set([...(marks.seen![key] ?? []), ...legacy].filter((value) => !(rebuilt && positional.has(value))));
      let fresh = [...new Set(ids)].filter((value) => !seen.has(value));
      // A window too small for a long replayed timeline: only growth past the last hook's rows is new.
      if (ids.length > 128 && ids.length >= (marks.rows![key] ?? 0)) fresh = fresh.slice(0, ids.length - (marks.rows![key] ?? 0));
      marks.rows![key] = ids.length;
      if (!fresh.length) { marks.seen![key] = [...seen].slice(-128); continue; }
      marks.timeline[key] = (marks.timeline[key] ?? 0) + fresh.length; marks.seen![key] = [...seen, ...fresh].slice(-128);
      changed.set(key, span(changed.get(key), { ...gap, count: 0 }));
    }
    if (changed.size || hook?.gaps.length) meta.gaps = marks;
    return [...updates, ...[...changed].filter(([key]) => total(key) > (before.get(key) ?? 0)).map(([key, gap]) => {
      const hint = key.endsWith("\0*") ? "other types" : gap.typeHint;
      const sourceId = handoffSource(`capture-gaps:${agentId}:${key}`);
      const where = ranges(gap).join(", ") || `${gap.source?.offset ?? "?"}–${gap.source?.end ?? "?"}`;
      const located = !locatedGapKinds.has(gap.kind) ? "." : gap.kind.startsWith("long_line") && !personalLine(gap.typeHint) ? ` (${/output|tool_result|CommandExecution|McpToolCall|FunctionCall|ImageView|Extension|FileChange/.test(hint ?? "") ? "tool output" : "not a person's words"}), first ones in bytes ${where}.`
        : `. More than ${captureLimits.hints} occurred; each earlier one is its own gap; these start in bytes ${where}.`;
      return { id: entryId("g", sourceId), sourceId, agentId, text: `Capture gap (${gap.kind})${hint ? `: ${hint}` : ""}${located} This content was not preserved; count, firstAt and lastAt cover every occurrence in this session.`.slice(0, 300), count: total(key), ...(gap.at ? { firstAt: gap.at } : {}), ...(gap.lastAt ? { lastAt: gap.lastAt } : {}) };
    })];
  }
  /**
   * At more than 40 active entries, the oldest ones (evidence-free placeholders first) are merged into one open entry per
   * session that counts them, and a note lists each merged item. Capture never stops for background capacity: refusing
   * the batch also refused the person's words, notes and compactions behind it (SESSION-HANDOFF-SPEC §5.7).
   */
  private mergeBackground(agentId: string, n: number, background: HandoffSession["background"], meta: ObserverState, entries: NonNullable<HandoffCapture["entries"]>) {
    const active = () => background.filter((item) => item.status !== "closed");
    if (active().length <= 40) return;
    const merge = meta.merged ?? { epoch: 0, count: 0 };
    let aggregateId = entryId("bg", `background-merged:${agentId}:${merge.epoch}`);
    if (background.some((item) => item.id === aggregateId && item.status === "closed")) { merge.epoch++; merge.count = 0; aggregateId = entryId("bg", `background-merged:${agentId}:${merge.epoch}`); }
    const aggregate = background.find((item) => item.id === aggregateId);
    // Calls in flight merge last: one still running comes back on the next poll as its own placeholder.
    const candidates = active().filter((item) => item.id !== aggregateId).sort((a, b) => Number(!!a.inFlight) - Number(!!b.inFlight) || Number(!a.ref.startsWith("unknown:")) - Number(!b.ref.startsWith("unknown:")) || time(a.startedAt) - time(b.startedAt));
    const merged = candidates.slice(0, active().length - 40 + (aggregate ? 0 : 1));
    for (const item of merged) background.splice(background.indexOf(item), 1);
    merge.count += merged.length; meta.merged = merge;
    const next: HandoffSession["background"][number] = { id: aggregateId, kind: aggregate?.kind ?? merged[0].kind, ref: `merged:${agentId}:${merge.epoch}`, label: `${merge.count} more background items merged at the 40-item capacity; Flowly notes list them`.slice(0, 120), startedAt: aggregate?.startedAt ?? merged[0].startedAt, status: "unknown", source: aggregate?.source ?? merged[0].source };
    if (aggregate) background[background.indexOf(aggregate)] = next; else background.push(next);
    const sourceId = handoffSource(`background-merged:${agentId}:${merge.epoch}:${merge.count}`);
    const list = merged.map((item) => `${item.kind} ${item.status} ${item.ref}: ${item.label} (since ${item.startedAt})`).join("; ");
    entries.push({ section: "notes", value: { id: entryId("nt", sourceId), sourceId, kind: "background", text: `Session #${n} (${agentId.slice(0, 8)}) had more than 40 active background items. ${merged.length} were merged into one entry ("${next.label}"); each may still be running: ${list}`.slice(0, 2000) } });
  }
  private comparable(session: SessionDraft) {
    const { rev: _, at: _at, by: _by, contentRef: _ref, ...rest } = session as HandoffSession;
    return { ...rest, ...(rest.through ? { through: stripAt(rest.through) } : {}) };
  }
  private stale(record: CardHandoff) {
    return !record.state || !record.next.length || !record.checkpoint || record.inputs.some((input) => input.status === "open" && !input.unconfirmed)
      || record.gaps.some((gap) => gap.status === "open") || record.reviews.some((review) => time(review.at) > time(record.checkpoint?.at))
      || record.notes.some((note) => ["incident", "hazard"].includes(note.kind) && time(note.at) > time(record.checkpoint?.at))
      || record.git.some((git) => git.error) || record.checkpoint?.dirtyHash !== digest(JSON.stringify(record.git.map(({ repo, sha, dirtyHash, error }) => ({ repo, sha, dirtyHash, error }))));
  }
  private async rotationGap(context: RotationContext, text: string) {
    const { project } = await this.card(context.taskId), record = await this.deps.records.read(context.taskId, project.id);
    const gap = this.gap(context.fromAgentId, `rotation-gap:${context.rotationId}`, text);
    if (!record.gaps.some((item) => item.sourceId === gap.value.sourceId) && !record.overflow.some((item) => item.sourceId === gap.value.sourceId))
      await this.deps.records.capture(context.taskId, project.id, { entries: [gap] }, flowly);
  }
  private async prepare(context: RotationContext) {
    await this.observeNow(context.taskId, context.fromAgentId, { forceGit: true });
    const { task, project } = await this.card(context.taskId), record = await this.deps.records.read(context.taskId, project.id), session = await this.session(record, context.fromAgentId);
    const actor = await this.snapshot(context.fromAgentId, task.workspaceId).catch(() => undefined); this.check();
    const meta = (session?.through?.resume as Resume | undefined)?.observer;
    const lastActive = Math.max(time(meta?.lastTurn), time(meta?.usageAt), time(actor?.lastUserMessageAt ?? undefined));
    const ttl = Math.min(meta?.ttl ?? 300, 300);
    const hot = lastActive > 0 && this.clock() >= lastActive && this.clock() - lastActive < ttl * 1000;
    const safe = context.allowFinalize && !!actor && !actor.archivedAt && actor.status === "idle" && !actor.activeTurn && !actor.pendingPermissions?.length
      && session?.measured?.B !== undefined && session.measured.B < 64 * 2 ** 20 && hot && !actor.lastError;
    if (safe && this.stale(record)) return { finalize: `[Flowly automation] Before a fresh session continues this card (${context.reason}), update the card handoff with flowly_update_handoff: state; ordered next steps; decisions and rejected approaches with reasons; problems, pitfalls, active background handles, output paths and environment facts. Preserve the original pending inputs and review requirements. Record validation and artifacts, then end this turn. Do not change files, start new work, or change card status. The successor's instruction starts: «${context.carry.text.slice(0, 1500)}». If a later notification wakes you, add a handoff note and end the turn.` };
    if (!safe) await this.rotationGap(context, "No demonstrably safe, recent handover turn was available. The successor must verify the captured card record and its current coverage gaps.");
    return {};
  }
  private async seal(context: RotationContext) {
    await this.observeNow(context.taskId, context.fromAgentId, { forceGit: true });
    if (context.continuation) {
      const { project } = await this.card(context.taskId);
      const sourceId = handoffSource(`rotation-continuation:${context.rotationId}:${context.continuation.id}`);
      const raw = JSON.stringify({ type: "pending_flowly_instruction", ...context.continuation }), text = redactCaptureText(raw);
      // This is an existing system work instruction, not a second human comment or a clipped direction note.
      this.check(); await this.deps.records.appendInput(context.taskId, project.id, { text, status: "received", atSource: "captured", via: "agent", agentId: context.fromAgentId, from: { title: "Flowly automation: pending work before this comment" }, ...(text !== raw ? { redacted: true } : {}) }, { ...flowly, sourceId, operationId: sourceId });
    }
    const { board, project } = await this.card(context.taskId), record = await this.deps.records.read(context.taskId, project.id), session = await this.session(record, context.fromAgentId);
    const rotation = jobOf(board, context.taskId)?.rotation;
    if (session && !session.endedAt) {
      const finalized = !!rotation?.finalize?.startedAt && record.checkpoint?.agentId === context.fromAgentId && time(record.checkpoint.at) >= time(rotation.finalize.startedAt);
      const lastWords = this.sealWords(record, session);
      this.check(); await this.deps.records.capture(context.taskId, project.id, { session: { ...session, endedAt: this.now(), endReason: context.reason, finalized, abandoned: undefined, handoffRevisionAtEnd: record.revision }, ...(lastWords ? { lastWords } : {}) }, flowly);
    }
    if (context.gap) await this.rotationGap(context, context.gap);
    this.check(); const sealed = await this.deps.records.seal(context.taskId, context.rotationId, project.id);
    await this.deps.syncIndex(context.taskId);
    const view = handoffView(sealed.record, { reviewer: context.role === "reviewer" });
    return { revision: sealed.revision, prompt: `Card handoff sealed at revision ${sealed.revision}. Read flowly_get_task with handoff:'full' and follow every nextCursor before continuing; this preview may be incomplete. ${context.role === "implementer" ? "Verify the repository HEADs, dirty state, unresolved inputs, review findings and active background work; acknowledge each pending id with flowly_update_handoff ack before delivery. Do not treat receipt as proof of understanding." : "Verify the pending review requirements and report missing handoff information in your review."}\n${JSON.stringify(view)}` };
  }
  /**
   * §5.8 at a seal: the sealed session's narration since the last handoff write (its turn finals and the live narration of a
   * turn whose hook never came, from passive capture), newest kept, when it is newer than the card's lastWords.
   */
  private sealWords(record: CardHandoff, session: HandoffSession): CardHandoff["lastWords"] {
    const spoken = session.live.filter((value) => !record.checkpoint || time(value.at) > time(record.checkpoint.at)), newest = Math.max(0, ...spoken.map((value) => time(value.at)));
    if (!spoken.length || record.lastWords?.agentId === session.agentId && newest <= time(record.lastWords.at)) return undefined;
    const joined = spoken.map((value) => value.text).join("\n");
    return { agentId: session.agentId, at: newest ? new Date(newest).toISOString() : this.now(), since: record.checkpoint?.at ?? session.startedAt, text: joined.length > 2000 ? `…${joined.slice(-1999)}` : joined };
  }
  private async committed(context: RotationContext & { toAgentId: string }) {
    const { task, project, board } = await this.card(context.taskId), record = await this.deps.records.read(context.taskId, project.id);
    const job = jobOf(board, context.taskId);
    if ((context.role === "implementer" ? job?.implementerId : job?.reviewerId) !== context.toAgentId) throw new Error("The replacement session is no longer the current card owner.");
    const previous = await this.session(record, context.toAgentId);
    if (!previous || previous.reason !== context.reason || previous.role !== context.role) {
      const actor = await this.snapshot(context.toAgentId, task.workspaceId);
      const next = { ...(previous ?? this.draft(record, context.toAgentId, actor, { previousAgentId: context.fromAgentId })), role: context.role, reason: context.reason, ...(context.model ? { launchModel: context.model, model: context.model.model } : {}) };
      this.check(); await this.deps.records.capture(context.taskId, project.id, { session: next }, flowly);
    }
    await this.deps.syncIndex(context.taskId);
  }
  private async abandoned(context: RotationContext) {
    const { project } = await this.card(context.taskId), record = await this.deps.records.read(context.taskId, project.id), session = await this.session(record, context.fromAgentId);
    if (session && session.abandoned !== context.rotationId) {
      const restored = { ...session, abandoned: context.rotationId, finalized: false, endedAt: undefined, endReason: undefined };
      this.check(); await this.deps.records.capture(context.taskId, project.id, { session: restored }, flowly); await this.deps.syncIndex(context.taskId);
    }
  }
  start(managedSessions: () => Promise<ManagedHandoffSession[]>) {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.poll(managedSessions), 60_000); this.timer.unref?.();
  }
  /** One bounded pass of the 60-second timer; a pass still running makes another one return at once. */
  async poll(managedSessions: () => Promise<ManagedHandoffSession[]>) {
    if (this.polling) return;
    this.polling = true;
    try {
      const sessions = await managedSessions(); this.check();
      // Round robin bounds each pass; large boards cannot trigger an unbounded Promise.all.
      for (let count = 0; count < Math.min(8, sessions.length) && !this.stopped; count++) {
        const session = sessions[(this.next + count) % sessions.length];
        await this.observe(session.taskId, session.agentId).catch(() => undefined);
      }
      this.next = sessions.length ? (this.next + 8) % sessions.length : 0;
    } catch { /* Connection failure is retried on the next bounded pass; per-session failures preserve cursors. */ }
    finally { this.polling = false; }
  }
  async stop() {
    this.stopped = true; this.controller.abort(); if (this.timer) clearInterval(this.timer); this.timer = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.workers]), new Promise<void>((resolve) => { timer = setTimeout(resolve, 900); timer.unref?.(); })]);
    if (timer) clearTimeout(timer);
  }
}
