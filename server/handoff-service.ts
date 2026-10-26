import { createHash } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { automationOf, automationSessionRole, jobOf } from "../shared/automation";
import type { Board, HandoffBehind } from "../shared/model";
import type { ToolIdentity } from "../shared/tools";
import { handoffOpenIds, handoffUpdateSchema, type CardHandoff, type HandoffUpdate } from "../shared/handoff";
import { handoffView } from "../shared/handoff-view";
import type { HandoffContextView, HandoffInputRecord } from "../shared/handoff-api";
import type { BoardStore } from "./store";
import { BoardService } from "./service";
import { HandoffStore } from "./handoff-store";
import { handoffGitDirectories, handoffGitSnapshot } from "./handoff-git";
import { ToolError } from "./tool-error";
import { persistHandoffImages } from "./handoff-images";
import { historyBytes, locateProviderHistory } from "./provider-history";
import { redactCaptureText } from "./handoff-capture-records";
import { handoffMessageSource, handoffSource } from "./handoff-source";
import type { ReviewInput } from "../shared/automation-schema";
import type { AutomationService } from "./automation";
import type { AgentModel } from "../shared/agent-defaults";
import type { OutgoingImage } from "../shared/composer";
import type { CommentInput } from "../shared/comments";
import { addComment } from "./comments";
import { markHandoffCommitted } from "./handoff-commit";
import { linkedContinuity, type ContinuityKind } from "./handoff-links";
import { handoffRefusalFingerprint } from "./handoff-requirements";
import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

const flowly = { by: { kind: "flowly" as const } };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint = (record: CardHandoff) => digest(record.git.map(({ repo, sha, dirtyHash, error }) => ({ repo, sha, dirtyHash, error })));

/** The semantic record is separate from the board; callers retain pending sources across the two writes. */
export class HandoffService {
  readonly records: HandoffStore;
  private paseo?: PaseoApi;
  private seen = new Map<string, number>();
  private mutations = new Map<string, Promise<unknown>>();
  private stopped = false;
  automation?: AutomationService;
  constructor(readonly board: BoardStore, readonly clock = () => Date.now()) { this.records = new HandoffStore(board.directory); }
  attach(paseo: PaseoApi) { this.paseo = paseo; }
  async linkSummary(taskId: string, kind: ContinuityKind) {
    try {
      const record = await this.records.read(taskId);
      return record ? linkedContinuity(record, kind) : undefined;
    } catch { return "Card continuity is unavailable; do not infer that its pitfalls or incidents are absent."; }
  }
  forgetRead(taskId: string, agentId: string) { this.seen.delete(`${taskId}:${agentId}`); }
  private sweepWait?: { timer: ReturnType<typeof setTimeout>; wake: () => void };
  /**
   * Plugin start: the store's one-time collection of every card's unreferenced bodies (SESSION-HANDOFF-SPEC §5.1), after the
   * first polls and `pauseMs` apart per card, so it never holds them up. A stop ends it; the next start then sweeps again.
   */
  async sweepBodies(options: { delayMs?: number; pauseMs?: number } = {}) {
    await new Promise<void>((wake) => { const timer = setTimeout(wake, options.delayMs ?? 90_000); timer.unref?.(); this.sweepWait = { timer, wake }; });
    this.sweepWait = undefined;
    if (this.stopped) return;
    await this.syncAll(options.pauseMs ?? 100);
    await this.records.sweep({ pauseMs: options.pauseMs ?? 100, stopped: () => this.stopped }).catch((error) => console.error("Flowly handoff body cleanup failed:", error instanceof Error ? error.message : String(error)));
  }
  /**
   * Plugin start syncs every index entry once (SESSION-HANDOFF-SPEC §12, §21.16): a record lost or unreadable while the
   * daemon was down reaches the card face, and an entry written by an older version (before `behind`) reads by the
   * current rules. An entry that agrees with its record is not rewritten.
   */
  private async syncAll(pauseMs: number) {
    const ids = (await this.board.read()).handoffIndex.map((entry) => entry.taskId);
    for (const taskId of ids) {
      if (this.stopped) return;
      await this.serial(taskId, () => this.syncIndex(taskId)).catch((error) => console.error("Flowly handoff index sync failed:", error instanceof Error ? error.message : String(error)));
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
  stop() { this.stopped = true; if (this.sweepWait) { clearTimeout(this.sweepWait.timer); this.sweepWait.wake(); } }
  private now() { return new Date(this.clock()).toISOString(); }
  /**
   * The card's queue. A job that meets a lost or unreadable record (HANDOFF_UNAVAILABLE: the observer's poll, an agent's
   * or a person's write) brings the card's index entry up to date before the next job, so the card face warns without
   * waiting for a drawer read (SESSION-HANDOFF-SPEC §12, §21.16); an entry already `unverified` is left alone.
   */
  serial<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const job = (this.mutations.get(taskId) ?? Promise.resolve()).then(async () => {
      if (this.stopped) throw new ToolError("HANDOFF_UNAVAILABLE", "The handoff service is stopping. Keep the unsent draft.");
      try { return await action(); }
      catch (error) { await this.indexLoss(taskId, error); throw error; }
    });
    const tail = job.catch(() => undefined);
    this.mutations.set(taskId, tail);
    void tail.finally(() => { if (this.mutations.get(taskId) === tail) this.mutations.delete(taskId); });
    return job;
  }
  private async indexLoss(taskId: string, error: unknown) {
    if (!(error instanceof ToolError) || error.code !== "HANDOFF_UNAVAILABLE" || this.stopped) return;
    const entry = (await this.board.read().catch(() => undefined))?.handoffIndex.find((item) => item.taskId === taskId);
    if (entry && entry.behind !== "unverified") await this.syncIndex(taskId).catch((failure) => console.error("Flowly handoff index sync failed:", failure instanceof Error ? failure.message : String(failure)));
  }
  private api() {
    if (!this.paseo) throw new ToolError("PASEO_UNAVAILABLE", "Handoff observation is waiting for the local Paseo connection.", true);
    return this.paseo;
  }
  private async card(taskId: string, writable = false) {
    const board = await this.board.read();
    const task = board.tasks.find((task) => task.id === taskId);
    const project = board.projects.find((project) => project.id === task?.projectId);
    if (!task || !project) throw new ToolError("NOT_FOUND", "Card not found.");
    if (writable && (task.archivedAt || project.archivedAt)) throw new ToolError("ARCHIVED", "This card or its project is archived.");
    if (writable && board.handoffIndex.some((entry) => entry.taskId === task.id) && !(await this.records.read(task.id))) throw new ToolError("HANDOFF_UNAVAILABLE", "The known handoff file is missing. Recover it before writing; it was not replaced with an empty record.");
    return { board, task, project };
  }
  private async session(identity: ToolIdentity, writable = false, allowRestore = false) {
    const found = await this.card(identity.taskId, writable);
    if (found.task.workspaceId !== identity.workspaceId) throw new ToolError("SESSION_MISMATCH", "Card workspace changed.");
    const actor = (await this.api().agents.ref(identity.agentId).refresh())?.agent;
    if (!actor || actor.workspaceId !== identity.workspaceId || (actor.archivedAt && !allowRestore)) throw new ToolError("SESSION_MISMATCH", "Session is unavailable, archived or belongs to another workspace.");
    const context = await new BoardService(this.board).context(identity.taskId, this.api(), found.board);
    if (!context.available) throw new ToolError("WORKSPACE_INCOMPATIBLE", context.reason || "Card workspace is unavailable.");
    return { ...found, actor, context };
  }
  /** Old retired identities remain governed even after leaving the board's bounded recent list. */
  async role(identity: ToolIdentity, board?: Board) {
    const found = board ?? (await this.card(identity.taskId)).board;
    const task = found.tasks.find((task) => task.id === identity.taskId);
    if (!task || task.workspaceId !== identity.workspaceId) throw new ToolError("SESSION_MISMATCH", "Card binding changed.");
    const record = await this.records.read(task.id, task.projectId);
    const sessions = [...record.ledger];
    if (!sessions.some((entry) => entry.agentId === identity.agentId)) {
      const archived = await this.records.sessionRecord(task.id, identity.agentId);
      if (archived) sessions.push(archived);
    }
    const prior = sessions.find((session) => session.agentId === identity.agentId);
    return automationSessionRole(found, identity.agentId, task.id, sessions) ?? (prior?.endedAt && ["implementer", "reviewer"].includes(prior.role) ? { role: "retired" as const, job: undefined } : null);
  }
  async assertWriter(identity: ToolIdentity, board?: Board) {
    const role = (await this.role(identity, board))?.role;
    if (role === "retired") throw new ToolError("RETIRED_SESSION", "This session was replaced. Only handoff notes and its own running work may be updated; continue in the current session.");
    if (role === "finalizing") throw new ToolError("FINALIZING", "Finish the handoff and end the turn; normal card writes and sub-card actions are disabled during finalization.");
  }
  async syncIndex(taskId: string) {
    const { board, task, project } = await this.card(taskId);
    let summary: { fresh: boolean; open: number; sessions?: number; behind?: HandoffBehind };
    try {
      await this.reconcile(taskId, board);
      // A known record whose file is missing is a warning for the person, not an empty record no agent wrote.
      const existing = await this.records.read(task.id), missing = !existing && board.handoffIndex.some((entry) => entry.taskId === task.id);
      const record = existing ?? await this.records.read(task.id, project.id), status = this.due(record, board);
      summary = { fresh: !status.due.length, open: handoffOpenIds(record).length, sessions: Math.max(0, ...record.ledger.map((entry) => entry.n)), ...(missing ? { behind: "unverified" as const } : status.behind ? { behind: status.behind } : {}) };
      if (missing) summary.fresh = false;
    } catch (error) {
      // An unreadable or invalid record is preserved for recovery and is a warning on the card face, not a failed sync.
      if (!(error instanceof ToolError) || error.code !== "HANDOFF_UNAVAILABLE") throw error;
      const old = board.handoffIndex.find((entry) => entry.taskId === task.id);
      summary = { fresh: false, open: old?.open ?? 0, behind: "unverified" };
    }
    await this.board.transaction((current) => {
      if (!current.tasks.some((card) => card.id === task.id && card.projectId === project.id)) return { value: undefined, changed: false };
      const old = current.handoffIndex.find((entry) => entry.taskId === task.id);
      // A call caught in flight is not an open id, so catching one does not rewrite board.json.
      const next = { taskId: task.id, fresh: summary.fresh, ...(!summary.fresh ? { staleSince: old?.staleSince ?? this.now() } : {}), open: summary.open, sessions: summary.sessions ?? old?.sessions ?? 0, ...(summary.behind ? { behind: summary.behind } : {}) };
      if (JSON.stringify(old) === JSON.stringify(next)) return { value: undefined, changed: false };
      current.handoffIndex = [...current.handoffIndex.filter((entry) => entry.taskId !== task.id), next];
      return { value: undefined, changed: true };
    });
  }
  private refreshing = new Set<string>();
  /**
   * The drawer's read brings the card's index entry up to date when it disagrees with the record it just read (or could
   * not read), so the card face and the folded summary agree with the body even on a quiet card that nobody writes to
   * (SESSION-HANDOFF-SPEC §12, §21.15). Serialized with the card's writes; the read waits for it only briefly.
   */
  private async refreshIndex(taskId: string, wait = true) {
    if (this.refreshing.has(taskId) || this.stopped) return;
    this.refreshing.add(taskId);
    const job = this.serial(taskId, () => this.syncIndex(taskId)).catch((error) => console.error("Flowly handoff index refresh failed:", error instanceof Error ? error.message : String(error))).finally(() => this.refreshing.delete(taskId));
    if (!wait) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([job, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1500); timer.unref?.(); })]);
    if (timer) clearTimeout(timer);
  }
  /**
   * What the next agent must check (`due`, agent-facing English), and for the person what the record is behind on
   * (SESSION-HANDOFF-SPEC §12): `changes` are the lines about activity after the agent's checkpoint; `behind` is `ack`
   * when only the successor's acknowledgement is missing, `activity` when every other line is such a change, `unwritten`
   * when no agent checkpoint exists yet, and `unverified` when anything else is due.
   */
  private due(record: CardHandoff, board: Board, agentId?: string) {
    const due: string[] = [], changes: string[] = [];
    let unverified = false;
    const add = (text: string, kind: "change" | "unwritten" | "check") => { due.push(text); if (kind === "change") changes.push(text); if (kind === "check") unverified = true; };
    const checkpoint = record.checkpoint;
    if (!record.state || !record.next.length) add("Write the current state and next step.", checkpoint ? "check" : "unwritten");
    if (!checkpoint) add("There is no agent checkpoint yet.", "unwritten");
    if (record.inputs.some((input) => input.status === "open" && !input.unconfirmed) || record.overflow.some((entry) => entry.section === "inputs" && entry.status === "open" && !entry.unconfirmed)) add("Original inputs still need a disposition.", "check");
    if (record.pendingOperations.length) add("Some source records are not yet confirmed by their board operation.", "check");
    // A delivery (`prepareDelivery`'s placeholder, verdict "incomplete") by the agent that wrote the checkpoint is that
    // agent's own note: the turn checklist writes the handoff first, so it is not news (SESSION-HANDOFF-SPEC §21.15).
    const after = checkpoint ? record.reviews.filter((review) => !review.unconfirmed && review.at > checkpoint.at) : [];
    if (after.some((review) => review.verdict !== "incomplete")) add("A review arrived after the last checkpoint.", "change");
    if (after.some((review) => review.verdict === "incomplete" && review.reviewerId !== checkpoint!.agentId)) add("Another session delivered after the last checkpoint.", "change");
    if (checkpoint && record.notes.some((note) => ["incident", "hazard"].includes(note.kind) && note.at > checkpoint.at)) add("New incident or hazard information needs to be checked.", "change");
    if (checkpoint && checkpoint.dirtyHash !== fingerprint(record)) add("Repository state changed after the checkpoint.", "change");
    if (record.git.some((repo) => repo.error)) add("Some repository state could not be verified.", "check");
    if (record.gaps.some((gap) => gap.status === "open")) add("Information coverage has unresolved gaps.", "check");
    if (record.ledger.some((session) => !session.endedAt && session.through && (session.through.gaps > 0 || session.through.lagBytes > 0))) add("The current session's passive capture is incomplete; check its coverage before relying on the handoff.", "check");
    const job = jobOf(board, record.taskId);
    const reader = agentId ?? job?.implementerId;
    const pendingCheckpoint = job?.checkpoint;
    if (pendingCheckpoint && pendingCheckpoint.agentId === reader && Date.parse(pendingCheckpoint.at) > (checkpoint && checkpoint.agentId === reader ? Date.parse(checkpoint.at) : -Infinity))
      add(`${pendingCheckpoint.reason}: update the handoff now (state, next and running work).`, "change");
    const current = record.ledger.find((session) => session.agentId === reader);
    const ackRequired = !!(reader && automationOf(board.projects.find((project) => project.id === record.projectId)) && job?.implementerId === reader && current?.role === "implementer" && current.reason !== "launch" && !current.ack?.complete);
    if (ackRequired) due.push("The successor must read the full pending record, verify the workspace and acknowledge it.");
    const behind: HandoffBehind | undefined = !due.length ? undefined : unverified ? "unverified" : !checkpoint ? "unwritten" : changes.length ? "activity" : "ack";
    return { due, ackRequired, changes, behind };
  }
  /**
   * `person`: the drawer's read, which also gets what the record is behind on (`behind`, `changes`); `status`: without the
   * record (a folded Handoff section).
   */
  async context(taskId: string, agentId?: string, options: { full?: boolean; cursor?: string; recordAccess?: boolean; forGate?: boolean; person?: boolean; status?: boolean } = {}): Promise<HandoffContextView> {
    const { board, task, project } = await this.card(taskId);
    let record: CardHandoff;
    try {
      await this.reconcile(task.id, board);
      const existing = await this.records.read(task.id);
      if (!existing && board.handoffIndex.some((entry) => entry.taskId === task.id)) throw new ToolError("HANDOFF_UNAVAILABLE", "The known handoff file is missing; recover it before continuing.");
      record = existing ?? await this.records.read(task.id, project.id);
    }
    catch (error) {
      // Any read that meets the loss brings the index up to date; only the person's drawer waits for it (briefly).
      if (board.handoffIndex.find((entry) => entry.taskId === taskId)?.behind !== "unverified") await this.refreshIndex(taskId, !!options.person);
      return { revision: 0, fresh: false, due: ["The durable handoff is unavailable; do not guess missing requirements."], unavailable: error instanceof Error ? error.message : String(error) };
    }
    const { changes, behind, ...status } = this.due(record, board, agentId);
    if (options.person) {
      const entry = board.handoffIndex.find((item) => item.taskId === taskId);
      if (entry && (entry.fresh !== !status.due.length || entry.open !== handoffOpenIds(record).length || entry.behind !== behind || entry.sessions !== Math.max(0, ...record.ledger.map((session) => session.n)))) await this.refreshIndex(taskId);
    }
    const key = `${taskId}:${agentId ?? "ui"}`;
    const role = agentId && automationSessionRole(board, agentId, taskId)?.role;
    const base = { revision: record.revision, fresh: !status.due.length, ...status, ...(options.person ? { changes, ...(behind ? { behind } : {}) } : {}), ...(options.forGate ? { requirementsFingerprint: handoffRefusalFingerprint(record) } : {}), staleSince: board.handoffIndex.find((entry) => entry.taskId === taskId)?.staleSince, currentAgentId: jobOf(board, taskId)?.implementerId, attachmentRoot: join(this.records.root, taskId) };
    if (options.status) return base;
    if (options.full) return { ...base, page: await this.records.page(taskId, { cursor: options.cursor, scope: "all" }) };
    const previousRead = agentId ? this.seen.get(key) : undefined;
    if (agentId && (previousRead === record.revision || options.recordAccess === false)) return { ...base, unchanged: previousRead === record.revision };
    const view = handoffView(record, { reviewer: role === "reviewer", ...(previousRead === undefined ? {} : { max: 4000 }) });
    // Reload sends a fresh default view again; it never assumes a successor read an old process's view.
    if (agentId && options.recordAccess !== false) this.seen.set(key, record.revision);
    return { ...base, view };
  }
  update(identity: ToolIdentity, raw: HandoffUpdate) { return this.serial(identity.taskId, () => this.updateNow(identity, raw)); }
  private async updateNow(identity: ToolIdentity, raw: HandoffUpdate) {
    const patch = handoffUpdateSchema.parse(raw);
    const { board, task, project, context } = await this.session(identity, true);
    const role = (await this.role(identity, board))?.role;
    if (role === "reviewer") throw new ToolError("REVIEWER_ONLY", "Report handoff gaps with the review; reviewers do not rewrite the implementer's continuity record.");
    if (["done", "cancelled"].includes(task.status) && Object.keys(patch).some((key) => !["handoffRevision", "operationId", "note"].includes(key))) throw new ToolError("TASK_FINISHED", "Only a note can be added to a finished card.");
    if (role === "retired") {
      const forbidden = Object.keys(patch).some((key) => !["handoffRevision", "operationId", "note", "set"].includes(key));
      if (forbidden || patch.set?.some((entry) => entry.section !== "running" || entry.owner !== identity.agentId)) throw new ToolError("RETIRED_SESSION", "A replaced session may only add a note or update its own running work.");
      for (const entry of patch.set ?? []) if (entry.id) {
        const previous = await this.records.runningRecord(task.id, entry.id);
        if (previous && previous.owner !== identity.agentId) throw new ToolError("RETIRED_SESSION", "This running item belongs to another session; its owner and work must be preserved.");
      }
    }
    const locations = await handoffGitDirectories(context.directories.map((entry) => entry.directory));
    const git = await Promise.all(locations.directories.map((directory) => handoffGitSnapshot(directory)));
    const before = await this.records.read(task.id, project.id), refresh = fingerprint({ ...before, git }) !== fingerprint(before);
    let result;
    try {
      // The heads Flowly read are written with the update, in one revision: a separate refresh would move the revision a
      // prepared ACK names, whenever the repository changed since the card's last turn end (SESSION-HANDOFF-SPEC §5.1, §7.5).
      result = await this.records.update(task.id, project.id, patch, { by: { kind: "agent", agentId: identity.agentId } }, { agentId: identity.agentId, actualHeads: git.map(({ repo, sha, dirty }) => ({ repo, sha, dirty })), dirtyHash: fingerprint({ ...before, git }), turnStartedAt: jobOf(board, task.id)?.turnAt, ...(refresh ? { git } : {}) });
    } catch (error) {
      // A refused write still records what Flowly read, so the reread it asks for shows the current heads. Its own failure
      // must not hide the refusal. Git is observation state: an in-place write without a receipt (a fresh id would only
      // fill ops/ with one nothing can replay).
      if (refresh) await this.records.capture(task.id, project.id, { git }, flowly).catch(() => undefined);
      throw error;
    }
    await this.syncIndex(task.id);
    return result;
  }
  recordInput(input: HandoffInputRecord) { return this.serial(input.taskId, () => this.recordInputNow(input)); }
  send(input: HandoffInputRecord, mode: "steer" | "interrupt" = "steer", sender?: (running: boolean) => Promise<void>) {
    return this.serial(input.taskId, async () => {
      const result = await this.recordInputNow(input);
      // The same mutex covers recording, this final authority check and send. Rotation's
      // prepare/seal waits here; once a rotation is requested, this path refuses the old target.
      const { board, actor } = await this.session(input, true, true);
      await this.assertWriter(input, board);
      if (jobOf(board, input.taskId)?.rotation) throw new ToolError("HANDOFF_PENDING", "The card is handing over. The instruction is saved; send it to the successor after it starts.");
      const running = ["running", "initializing"].includes(actor.status);
      if (this.stopped) throw new ToolError("HANDOFF_UNAVAILABLE", "The handoff service stopped before sending. The original instruction was saved.");
      if (sender) await sender(running);
      else await this.api().agents.ref(input.agentId).send(input.text, { messageId: input.messageId, ...(running ? { activeTurnBehavior: mode } : {}), ...(input.images?.length ? { images: input.images } : {}) });
      return result;
    });
  }
  private async recordInputNow(input: HandoffInputRecord) {
    const identity = { taskId: input.taskId, workspaceId: input.workspaceId, agentId: input.agentId };
    const { task, project, board, actor } = await this.session(identity, true, true);
    const role = (await this.role(identity, board))?.role;
    if (role === "retired" || role === "finalizing") throw new ToolError("RETIRED_SESSION", "This session is being replaced. The draft is kept; send it to the current session after the handoff.");
    const bytes = await historyBytes(actor);
    if (bytes !== null && bytes >= 200 * 2 ** 20) throw new ToolError("HISTORY_TOO_LARGE", "This session is too large for Paseo to load safely. Keep the draft and continue in a fresh session.");
    const sourceId = handoffMessageSource(input.agentId, input.messageId);
    const original = redactCaptureText(input.text);
    const previous = await this.records.inputRecord(task.id, sourceId);
    if (previous?.atSource === "typed" && (previous.sourceHash !== createHash("sha256").update(original).digest("hex") || (previous.images?.length ?? 0) + (previous.imagesLost ?? 0) !== (input.images?.length ?? 0)))
      throw new ToolError("OPERATION_REUSED", "This instruction identity already has different text or attachments. The original is preserved.");
    const saved = await persistHandoffImages(this.records.root, task.id, sourceId, input.images ?? []);
    if (previous?.atSource !== "typed")
      await this.records.appendInput(task.id, project.id, { text: original, ...(original !== input.text ? { redacted: true } : {}), via: input.via, atSource: "typed", status: "open", agentId: input.agentId, messageId: input.messageId, ...(input.commentId ? { commentId: input.commentId } : {}), ...(saved.images.length ? { images: saved.images } : {}), ...(saved.lost ? { imagesLost: saved.lost } : {}) }, { by: { kind: "human" }, sourceId, operationId: sourceId });
    if (saved.lost) await this.records.appendGap(task.id, project.id, { text: `${saved.lost} attached image(s) exceeded this card's 20-file/20-MiB retention budget; inspect the original attachment before continuing.`, status: "open", kind: "flowly" }, { ...flowly, sourceId: `image-budget:${sourceId}` });
    await this.syncIndex(task.id);
    return { ok: true as const, messageId: input.messageId, agentId: input.agentId };
  }
  async confirmInput(input: { taskId: string; workspaceId: string; agentId: string; messageId: string }) {
    const { task, project } = await this.session(input, true);
    // The accepted send is not evidence that the agent has processed the instruction.
    const sourceId = handoffMessageSource(input.agentId, input.messageId);
    const record = await this.records.read(task.id, project.id);
    if (record.pendingOperations.some((operation) => operation.sourceId === sourceId))
      await this.confirmSource(task.id, sourceId);
    return { ok: true as const };
  }
  note(input: { taskId: string; operationId: string; kind: "direction" | "incident" | "environment" | "other"; text: string }) { return this.serial(input.taskId, async () => {
    const { task, project } = await this.card(input.taskId, true);
    await this.records.appendNote(task.id, project.id, { kind: input.kind, text: input.text }, { by: { kind: "human" }, operationId: input.operationId, sourceId: `human-note:${input.operationId}` });
    await this.syncIndex(task.id);
    return { ok: true as const };
  }); }
  markInput(input: { taskId: string; id: string; operationId: string; handoffRevision: number; status?: "open" | "done" | "answered" | "superseded" | "declined"; standing?: boolean; note?: string }) { return this.serial(input.taskId, async () => {
    const { task, project } = await this.card(input.taskId, true);
    await this.records.update(task.id, project.id, { handoffRevision: input.handoffRevision, operationId: input.operationId, inputs: [{ id: input.id, status: input.status, standing: input.standing, note: input.note }] }, { by: { kind: "human" } });
    await this.syncIndex(task.id);
    return { ok: true as const };
  }); }
  private sourceContext(sourceId: string, agentId?: string) {
    const source = handoffSource(sourceId);
    return { sourceId: source, operationId: source, unconfirmed: true, by: agentId ? { kind: "agent" as const, agentId } : { kind: "human" as const } };
  }
  private async sourceCard(identity: ToolIdentity, snapshot?: Board) {
    if (!snapshot) return this.card(identity.taskId, true);
    const task = snapshot.tasks.find((t) => t.id === identity.taskId && t.workspaceId === identity.workspaceId);
    const project = snapshot.projects.find((p) => p.id === task?.projectId);
    if (!task || !project || task.archivedAt || project.archivedAt) throw new ToolError("SESSION_MISMATCH", "Card binding changed.");
    return { board: snapshot, task, project };
  }
  /** In a board transaction, these only acquire the handoff-file lock, never a board/service lock. */
  async prepareQuestion(identity: ToolIdentity, sourceId: string, kind: "question" | "blocker", text: string, snapshot?: Board) {
    const { task, project } = await this.sourceCard(identity, snapshot);
    await this.records.appendQuestion(task.id, project.id, { kind, text: redactCaptureText(text), askedBy: identity.agentId, status: "open" }, this.sourceContext(sourceId, identity.agentId));
    if (snapshot) markHandoffCommitted(snapshot, task.id, sourceId);
  }
  async prepareDelivery(identity: ToolIdentity, sourceId: string, text: string, snapshot?: Board) {
    const { task, project, board } = await this.sourceCard(identity, snapshot);
    const ctx = this.sourceContext(sourceId, identity.agentId), existing = await this.records.read(task.id, project.id);
    if ([...existing.reviews, ...existing.overflow].some((entry) => entry.sourceId === ctx.sourceId)) { if (snapshot) markHandoffCommitted(snapshot, task.id, sourceId); return; }
    const job = jobOf(board, task.id);
    await this.records.appendReview(task.id, project.id, { cycle: job?.cycle ?? job?.generation ?? 0, round: Math.max(1, job?.reviewRounds ?? 1), reviewerId: identity.agentId, verdict: "incomplete", summary: "Implementer delivery; review has not been completed.", findings: [], delivery: { text: redactCaptureText(text) } }, ctx);
    if (snapshot) markHandoffCommitted(snapshot, task.id, sourceId);
  }
  async prepareReview(identity: ToolIdentity, sourceId: string, input: ReviewInput, snapshot?: Board) {
    const { task, project, board } = await this.sourceCard(identity, snapshot);
    const ctx = this.sourceContext(sourceId, identity.agentId), existing = await this.records.read(task.id, project.id);
    if ([...existing.reviews, ...existing.overflow].some((entry) => entry.sourceId === ctx.sourceId)) { if (snapshot) markHandoffCommitted(snapshot, task.id, sourceId); return; }
    const job = jobOf(board, task.id);
    const delivery = board.events.find((event) => event.id === job?.deliveryEvent);
    await this.records.appendReview(task.id, project.id, {
      cycle: job?.cycle ?? job?.generation ?? 0, round: Math.max(1, job?.reviewRounds ?? 1),
      ...(job?.review?.level ? { level: job.review.level } : {}), ...(job?.panel !== undefined ? { panel: job.panel } : {}),
      reviewerId: identity.agentId, verdict: input.verdict, summary: redactCaptureText(input.summary),
      findings: (input.findings ?? []).map(redactCaptureText), risks: (input.risks ?? []).map(redactCaptureText),
      gaps: (input.handoff?.gaps ?? []).map(redactCaptureText),
      ...(delivery?.note ? { delivery: { event: delivery.id, text: redactCaptureText(delivery.note) } } : {}),
    }, ctx);
    if (snapshot) markHandoffCommitted(snapshot, task.id, sourceId);
  }
  /** The durable board outbox, rather than the old writer's availability, proves acceptance. */
  async reconcile(taskId: string, snapshot?: Board) {
    const board = snapshot ?? await this.board.read();
    const task = board.tasks.find((task) => task.id === taskId);
    const markers = board.handoffConfirmations?.filter((entry) => entry.taskId === taskId) ?? [];
    if (!task || !markers.length) return;
    for (const marker of markers) {
      const record = await this.records.read(task.id);
      if (!record) throw new ToolError("HANDOFF_UNAVAILABLE", "The board confirms a source write but its handoff file is missing. Recover the record; the confirmation is preserved.");
      if (record.pendingOperations.some((operation) => operation.sourceId === marker.sourceId))
        await this.records.confirmSource(task.id, task.projectId, marker.sourceId, { ...flowly, operationId: handoffSource(`confirm:${marker.sourceId}`) });
    }
    await this.board.transaction((current) => {
      const prior = current.handoffConfirmations ?? [];
      const remaining = prior.filter((entry) => !markers.some((known) => known.taskId === entry.taskId && known.sourceId === entry.sourceId));
      if (remaining.length === prior.length) return { value: undefined, changed: false };
      if (remaining.length) current.handoffConfirmations = remaining; else delete current.handoffConfirmations;
      return { value: undefined, changed: true };
    });
  }
  async confirmSource(taskId: string, sourceId: string) {
    const { task, project } = await this.card(taskId);
    const source = handoffSource(sourceId), record = await this.records.read(task.id, project.id);
    if (record.pendingOperations.some((operation) => operation.sourceId === source))
      await this.records.confirmSource(task.id, project.id, source, { ...flowly, operationId: handoffSource(`confirm:${source}`) });
    await this.syncIndex(task.id);
  }
  withdrawQueued(taskId: string, agentId: string, messageId: string) { return this.serial(taskId, async () => {
    const { task, project } = await this.card(taskId, true);
    const entry = await this.records.inputRecord(task.id, handoffMessageSource(agentId, messageId));
    if (!entry || entry.status !== "open") return;
    const current = await this.records.read(task.id, project.id);
    await this.records.update(task.id, project.id, { handoffRevision: current.revision, operationId: handoffSource(`withdraw:${agentId}:${messageId}`), inputs: [{ id: entry.id, status: "declined", note: "The user removed this queued instruction before it was sent." }] }, { by: { kind: "human" } });
    await this.syncIndex(task.id);
  }); }
  comment(input: CommentInput) { return this.serial(input.taskId, async () => {
    const { task, project } = await this.card(input.taskId, true);
    const sourceId = handoffSource(`comment:${input.operationId}`);
    const text = redactCaptureText(input.text);
    await this.records.appendInput(task.id, project.id, { text, via: "comment", atSource: "typed", status: "open", messageId: `comment:${input.operationId}`, ...(text !== input.text ? { redacted: true } : {}) }, this.sourceContext(sourceId));
    const event = await addComment(this.board, input, sourceId);
    await this.confirmSource(task.id, sourceId);
    return event;
  }); }
  /** Prepared ids are already authorized by ToolServer; no native session exists yet. */
  launch(taskId: string, agentId: string, launch: { messageId: string; text: string; model?: AgentModel; images?: OutgoingImage[]; role?: "manual" | "implementer" }) {
    return this.serial(taskId, async () => {
      const { task, project } = await this.card(taskId, true);
      const sourceId = handoffMessageSource(agentId, launch.messageId), text = redactCaptureText(launch.text);
      const saved = await persistHandoffImages(this.records.root, task.id, sourceId, launch.images ?? []);
      await this.records.appendInput(task.id, project.id, { text, via: "launch", atSource: "typed", status: "open", agentId, messageId: launch.messageId, images: saved.images, ...(saved.lost ? { imagesLost: saved.lost } : {}), ...(text !== launch.text ? { redacted: true } : {}) }, { by: { kind: "human" }, sourceId, operationId: sourceId });
      const record = await this.records.read(task.id, project.id);
      if (!(await this.records.sessionRecord(task.id, agentId))) await this.records.setSession(task.id, project.id, { agentId, n: Math.max(0, ...record.ledger.map((entry) => entry.n)) + 1, role: launch.role ?? "manual", provider: launch.model?.provider ?? "unknown", model: launch.model?.model, launchModel: launch.model, startedAt: this.now(), reason: "launch", finalized: false, turns: [], background: [], live: [] }, { ...flowly, sourceId: `session:${agentId}` });
      await this.syncIndex(task.id);
    });
  }
  async continue(input: { taskId: string; agentId?: string; fresh: boolean }) {
    const { board, task } = await this.card(input.taskId, true);
    const job = jobOf(board, task.id);
    if (input.fresh) {
      if (job && !["stopped", "delivered"].includes(job.state) && this.automation) { await this.automation.requestFresh(task.id); return { ok: true as const, automation: true }; }
      return { ok: true as const, automation: false };
    }
    if (!input.agentId) throw new ToolError("SESSION_MISMATCH", "Choose the session to take back.");
    return this.serial(task.id, async () => {
      const { board: current, actor } = await this.session({ taskId: task.id, workspaceId: task.workspaceId, agentId: input.agentId! }, true);
      const before = jobOf(current, task.id);
      if (before?.rotation?.forced) throw new ToolError("HISTORY_TOO_LARGE", "This replacement is required for safety; the old session cannot be taken back.");
      if (before?.instruction || before?.unconfirmed || before?.pendingOp || actor.providerUnavailable || actor.lastError) throw new ToolError("SESSION_BUSY", "A dispatch or provider recovery is still pending. Wait for it to settle, then choose the session again.");
      const ids = [...new Set([input.agentId!, before?.implementerId, before?.reviewerId].filter((id): id is string => !!id))];
      for (const id of ids) {
        const state = id === actor.id ? actor : (await this.api().agents.ref(id).refresh())?.agent;
        if (!state || ["running", "initializing"].includes(state.status) || state.activeTurn || state.pendingPermissions?.length) throw new ToolError("SESSION_BUSY", "Wait for the card's sessions and pending permissions before taking a session back.");
      }
      let cursor: string | undefined, inspected = 0;
      do {
        const page = await this.api().agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor } });
        for (const { agent } of page.entries) if (agent.workspaceId === task.workspaceId && (["running", "initializing"].includes(agent.status) || agent.activeTurn || agent.pendingPermissions?.length)) throw new ToolError("SESSION_BUSY", "Another session of this workspace is still running or waiting for a permission.");
        inspected += page.entries.length; cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor && inspected < 2000);
      if (cursor) throw new ToolError("SESSION_BUSY", "The workspace's active sessions could not be checked completely; try again after its other work settles.");
      const source = await locateProviderHistory(actor);
      const bytes = source.file ? await stat(source.file.path).then((entry) => entry.size, () => null) : null;
      if (bytes === null || bytes >= 64 * 2 ** 20) throw new ToolError("HISTORY_TOO_LARGE", "The session's history cannot be verified below the safe take-back limit.");
      await this.board.transaction((latest) => {
        const active = jobOf(latest, task.id);
        if (digest(active) !== digest(before)) throw new ToolError("HANDOFF_CONFLICT", "The card changed while the session was checked.");
        if (active) { active.state = "stopped"; active.code = "taken_over"; active.updatedAt = this.now(); active.implementerId = input.agentId; active.role = "implementer"; delete active.reviewerId; delete active.rotation; delete active.instruction; delete active.pendingOp; delete active.unconfirmed; active.retired = active.retired?.filter((s) => s.agentId !== input.agentId); active.reviewers = active.reviewers?.filter((id) => id !== input.agentId); }
        this.board.event(latest, { taskId: task.id, actor: "human", action: "handoff_session_taken_back", agentId: input.agentId });
        return { value: undefined, changed: true };
      });
      const record = await this.records.read(task.id, task.projectId), old = await this.records.sessionRecord(task.id, input.agentId!);
      await this.records.setSession(task.id, task.projectId, { ...old, agentId: input.agentId!, n: old?.n ?? Math.max(0, ...record.ledger.map((s) => s.n)) + 1, provider: actor.provider, role: "manual", reason: "human_take_back", startedAt: old?.startedAt ?? this.now(), endedAt: undefined, finalized: false, turns: old?.turns ?? [], live: old?.live ?? [], background: old?.background ?? [] }, { by: { kind: "human" }, sourceId: `session:${input.agentId}` });
      await this.syncIndex(task.id);
      return { ok: true as const, automation: false };
    });
  }
  /** Locks are ordered, and kept until both the backup and the board deletion have committed. */
  removeWithBackup<T>(taskIds: readonly string[], remove: () => Promise<T>): Promise<T> {
    const ids = [...new Set(taskIds)].sort();
    const run = async (index: number): Promise<T> => {
      if (index < ids.length) return this.serial(ids[index], () => run(index + 1));
      for (const id of ids) await this.reconcile(id);
      return remove();
    };
    return run(0).then(async (result) => { for (const id of ids) await this.records.removeCard(id); return result; });
  }
  withCards<T>(taskIds: readonly string[], action: () => Promise<T>): Promise<T> {
    const ids = [...new Set(taskIds)].sort();
    const run = (index: number): Promise<T> => index < ids.length ? this.serial(ids[index], () => run(index + 1)) : action();
    return run(0);
  }
  async restoreLocal(taskIds: readonly string[], locked = false) {
    const folder = join(this.board.directory, "removed");
    const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const candidates = names.filter((name) => name.endsWith(".json")).sort().reverse();
    for (const taskId of taskIds) {
      const restore = async () => {
      const { task, project } = await this.card(taskId);
      if ((await this.records.read(task.id)) !== null) return;
      for (const name of candidates.filter((name) => name.startsWith(project.id + "-") || name.startsWith(`task-${task.id}-`))) {
        const raw = JSON.parse(await readFile(join(folder, name), "utf8")) as { tasks?: { id: string; projectId: string }[] };
        if (!raw.tasks?.some((saved) => saved.id === task.id && saved.projectId === project.id)) continue;
        const source = join(folder, name + ".handoffs", task.id);
        if (!(await stat(join(source, "complete.json")).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; }))) continue;
        await this.records.restoreCard(task.id, source); await this.syncIndex(task.id); return;
      }
      await this.records.appendGap(task.id, project.id, { kind: "flowly", text: "No local handoff backup was available for this restored card. Read the project artifacts and verify missing instructions before continuing.", status: "open" }, { ...flowly, sourceId: `restore-missing:${task.id}` });
      await this.syncIndex(task.id);
      };
      if (locked) await restore(); else await this.serial(taskId, restore);
    }
  }

}
