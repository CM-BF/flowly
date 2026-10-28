import type { HandoffService } from "./handoff-service";
import { assertActiveCardWriter } from "./handoff-guard";
import type { HandoffUpdate } from "../shared/handoff";
import { resolveReviewLevel } from "./review-levels";
import { linkExtras, type LinkHandoff } from "./automation-handoff";
import { resumeStage } from "./progress-rules";
import { authorizeCardActor, authorizeCardCreation, checkStartable, refuseAbandonedTree, type AgentCardActor } from "./agent-card-guard";
import { isSummarizer } from "../shared/summary";
import { agentComments, isComment } from "../shared/comments";
import { outputLanguage } from "../shared/ai-language";
import type { LocaleCode } from "../shared/i18n";
import { enabledStatuses, laneEnabled, laneName } from "../shared/lanes";
import type { PaseoApi } from "@getpaseo/client";
import { randomUUID } from "node:crypto";
import { ideaTitleKey } from "../shared/ideas";
import { nextMovesAction, noMovesNote } from "../shared/next-moves";
import { isResolved, linksOf } from "../shared/links";
import { absoluteTarget, artifactsOf } from "../shared/artifacts";
import { reviewerChecklist, turnChecklist } from "../shared/turn-checklist";
import { changeTags, normalizeTags, projectTagStats, tagChangeNote } from "../shared/tags";
import { setTags } from "./store";
import { fingerprintChanged } from "./connectors/fingerprint";
import { artifactRoots, dropArtifact, externalArtifact, missingArtifacts, normalizeTarget, putArtifact, type NewArtifact } from "./artifacts";
import { ArtifactReadStore } from "./artifact-reads";
import { ExternalError } from "./connectors/http";
import { ExternalReadStore, refKey, type ConnectorService } from "./connectors/service";
import { familyOf, itemTypeOf } from "../shared/connectors";
import { join } from "node:path";
import { hostname } from "node:os";
import type { Artifact, GitHead, NextMove, Workpad } from "../shared/model";
import { projectScripts } from "./workflow-insights";
import { mergeWorkpad, openItemLines, openItems, plansOf, validationFreshness, workpadEnabled, workpadNote, workpadOf, workpadUpdatedAction } from "../shared/workpad";
import { defaultGit, readHead, resolveCommit, type Git } from "./workpad";
import { deliveryReminders, outputsReminder, type DeliveryCall } from "./reminders";
import { DeliveryGate } from "./delivery-gate";
import { setupContext, setupIncompleteMessage, setupMissing, setupReminder, type SetupItem } from "../shared/card-setup";
import {
  agentStatuses,
  ideaInputSchema,
  ideaRemovalSchema,
  ideaUpdateInputSchema,
  rememberInputSchema,
  recallInputSchema,
  artifactInputSchema,
  artifactRemovalSchema,
  tagsInputSchema,
  typeInputSchema,
  metadataInputSchema,
  type MetadataInput,
  nextMovesInputSchema,
  workpadInputSchema,
  progressInputSchema,
  statusInputSchema,
  type ToolIdentity,
  type ToolContext,
  type ToolResult,
  type StatusInput,
  type ProgressInput,
  type IdeaInput,
  type IdeaRemovalInput,
  type IdeaUpdateInput,
  type RememberInput,
  type RecallInput,
  type ArtifactToolInput,
  type ArtifactRemovalInput,
  type TagsToolInput,
  type TypeToolInput,
  type NextMovesInput,
  type WorkpadInput,
  type ExternalContext,
  type ReadExternalInput,
} from "../shared/tools";
import { BoardStore } from "./store";
import { BoardService, preflightCardLinks } from "./service";
import { ToolSecrets, digest } from "./tool-context";
import { ToolError } from "./tool-error";
import { ideaLimits, isWorkStatus, legacyStatus, type Board, type Idea, type Receipt, type Status } from "../shared/model";
import { isLegacyScope } from "../shared/scope";
import { MemoryError, type MemoryService } from "./memory";
import type { AutomationService } from "./automation";
import type { AcceptanceService } from "./acceptance";
import type { TournamentService } from "./tournament";
import type { ReviewInput } from "../shared/automation-schema";
import { automationAllowed, automationOf, automationSessionRole, isLive, jobOf, reviewerOfCard, reviewsFor } from "../shared/automation";
import { parentOf } from "../shared/links";
import { createCardInputSchema, updateCardInputSchema, type CreateCardInput, type CreateCardResult, type UpdateCardInput } from "../shared/tools";
import { taskInput, type Task, type TaskInput } from "../shared/model";
import { reasonText, reviewLevelNote, type LevelBoard } from "../shared/review-levels";
import { existsSync } from "node:fs";
import type { SessionHistory } from "./session-history";
import type { SessionHistoryQuery } from "../shared/session-history";

/** A card's review level for get_task (AUTOMATION-SPEC §5.2.1): what it resolves to now, whether it is set on the card, and why. */
function levelContext(board: LevelBoard, task: Task) {
  const { level, reason } = resolveReviewLevel(board, task);
  return { level, set: !!task.reviewLevel, why: reasonText(reason) };
}
import { logFailure } from "./error-report";

/** A project-memory refusal as the tool error agents read (PROJECT-MEMORY-SPEC §4.1). */
/**
 * An unattended project's rule (AUTOMATION-SPEC §5.3.4): nobody answers questions from the sessions automation drives,
 * so a question or blocker from one is refused before anything is recorded and the session decides itself.
 */
function refuseUnattended(board: Board, identity: { agentId: string; taskId: string }) {
  const task = board.tasks.find((t) => t.id === identity.taskId);
  if (!automationOf(board.projects.find((p) => p.id === task?.projectId))?.unattended) return;
  // Replaced and handing-off sessions never get here (RETIRED_SESSION, FINALIZING): only the job's current sessions.
  const session = automationSessionRole(board, identity.agentId, identity.taskId);
  if (!session || !isLive(session.job)) return;
  throw new ToolError(
    "UNATTENDED",
    session.role === "reviewer"
      ? "Nobody answers questions in this project: agent automation runs it unattended, so nothing was recorded. Decide yourself and give your verdict now with flowly_submit_review: approve, or changes with your doubts as concrete findings the implementer can act on."
      : "Nobody answers questions in this project: agent automation runs it unattended, so nothing was recorded. Decide yourself: take the most reasonable reading of the card, write your assumption in the workpad and the delivery note, and continue to a delivery with flowly_update_status status=in_review. If part of the work cannot be done safely, deliver the rest and say in the note what you did not do and why.",
  );
}

function memoryToolError(e: unknown): unknown {
  return e instanceof MemoryError ? new ToolError(e.code, e.message) : e;
}

/** Cards the agents of one card may create before they have to ask the user (SUB-CARDS-SPEC §3). */
const requestReused = () =>
  new ToolError("REQUEST_REUSED", "Request already committed with different parameters. Each card needs its own request: call flowly_get_task again before the next flowly_create_card.");

/** Writes a reviewer session may not make (progress only with kind=result); metadata has its own guard. */
const reviewerWrites = new Set<string>(["status", "progress", "workpad", "type", "tags", "artifact", "artifact_remove", "idea_update", "idea_remove"]);

export class AgentService {
  private paseo?: PaseoApi;
  private deliveryGate = new DeliveryGate();
  /** Lifecycle reset, independent of the board's truncated event history. */
  turnStarted(identity: ToolIdentity) {
    this.deliveryGate.clear(`${identity.agentId}:${identity.taskId}:${identity.workspaceId}`);
  }
  readonly accesses = new Map<string, { at: string; action: string }>();
  async toolCalled(identity: ToolIdentity) {
    this.accesses.set(identity.agentId, { at: new Date(this.clock()).toISOString(), action: "tool" });
    const known = jobOf(await this.store.read(), identity.taskId);
    if (!known?.silentSince || (known.implementerId !== identity.agentId && known.reviewerId !== identity.agentId)) return;
    await this.store.transaction(board => {
      const job = jobOf(board, identity.taskId);
      if (!job?.silentSince || (job.implementerId !== identity.agentId && job.reviewerId !== identity.agentId)) return { value: undefined, changed: false };
      delete job.silentSince; return { value: undefined, changed: true };
    });
  }
  /** The Ideas setting; off refuses new proposals (IDEAS-INBOX-SPEC §10). Set by the plugin entry. */
  ideasOn: () => Promise<boolean> = async () => true;
  /** The Agent artifacts setting; off refuses artifact writes (CARD-ARTIFACTS-SPEC §4.3). */
  artifactsOn: () => Promise<boolean> = async () => true;
  /** The AI output language (AI-LANGUAGE-SPEC §5), returned by get_task as outputLanguage. */
  aiLanguage: () => Promise<LocaleCode> = async () => "en";
  /** Reads the workspace HEAD and verifies commits for the workpad (WORKPAD-SPEC §4.2, §5.1). */
  git: Git = defaultGit;
  constructor(
    readonly store: BoardStore,
    readonly secrets: ToolSecrets,
    readonly clock = () => Date.now(),
  ) {
    this.artifactReads = new ArtifactReadStore(store.directory);
    this.externalReads = new ExternalReadStore(join(store.directory, "connectors"));
  }
  /** Reads external inputs (CONNECTORS-SPEC §9); set by the plugin entry. */
  connectors?: ConnectorService;
  /** Project memory (PROJECT-MEMORY-SPEC); set by the plugin entry. */
  memory?: MemoryService;
  /** Agent automation (AUTOMATION-SPEC); set by the plugin entry. */
  automation?: AutomationService;
  /** Acceptance-test review (AUTOMATION-SPEC §5.4): what get_task shows of the card's acceptance tests. */
  acceptance?: Pick<AcceptanceService, "context">;
  /** Tournament mode (AUTOMATION-SPEC §5.5): the judge's tools. */
  tournament?: Pick<TournamentService, "isJudge" | "activate" | "submit">;
  /** Card continuity and durable source provenance; attached by the plugin entry. */
  handoffs?: HandoffService;
  sessionHistory?: SessionHistory;
  async readSessionHistory(identity: ToolIdentity, query: SessionHistoryQuery) {
    if (!this.sessionHistory || !this.handoffs) throw new ToolError("HANDOFF_UNAVAILABLE", "Session history excerpts are unavailable.");
    const { task, project, paseo } = await this.resources(identity);
    const available = await this.handoffs.context(task.id, identity.agentId, { recordAccess: false });
    if (available.unavailable) throw new ToolError("HANDOFF_UNAVAILABLE", available.unavailable);
    const record = await this.handoffs.records.read(task.id, project.id);
    const number = /^#?([1-9]\d*)$/.exec(query.session);
    const session = number ? record.ledger.find(s => s.n === Number(number[1])) : await this.handoffs.records.sessionRecord(task.id, query.session);
    if (!session) throw new ToolError("SESSION_MISMATCH", "Choose a session from this card's handoff ledger. For older archived entries, read the full handoff and use its exact agent ID.");
    const actor = (await paseo.agents.ref(session.agentId).refresh())?.agent;
    if (!actor || actor.workspaceId !== task.workspaceId) throw new ToolError("SESSION_MISMATCH", "The recorded session is missing or no longer belongs to this card's workspace.");
    return this.sessionHistory.read(actor, query);
  }
  async updateHandoff(identity: ToolIdentity, patch: HandoffUpdate) {
    if (!this.handoffs) throw new ToolError("HANDOFF_UNAVAILABLE", "Card continuity is unavailable in this Flowly build.");
    const result = await this.handoffs.update(identity, patch);
    this.accesses.set(identity.agentId, { at: new Date(this.clock()).toISOString(), action: "handoff" });
    return result;
  }
  private async handoffReminder(identity: ToolIdentity) {
    if (!this.handoffs) return {};
    try { const value = await this.handoffs.context(identity.taskId, identity.agentId, { recordAccess: false }); return value.due.length ? { handoffDue: value.due.join(" ") } : {}; }
    catch { return { handoffDue: "Card continuity could not be read; check the handoff before ending this turn." }; }
  }
  /** Creates a card with its workspace (BoardService.createTask); set by the plugin entry. */
  createTask?: (input: TaskInput, paseo: PaseoApi, agent: AgentCardActor) => Promise<Task>;
  /** What a status move by a person triggers (automation, wrap-up, memory review); set by the plugin entry. */
  onStatusChange?: (previous: string | undefined, task: Task, paseo: PaseoApi) => void;
  /** A signed request no older than 15 minutes (the same window as write()). */
  private fresh(issuedAt: string) {
    const age = this.clock() - Date.parse(issuedAt);
    if (age > 15 * 60 * 1000 || age < -30000) throw new ToolError("REQUEST_EXPIRED", "Request is expired. Re-read the task before a new update.");
  }
  /** Card creations in flight by request, so overlapping calls with one request make one card. */
  private readonly cardRequests = new Map<string, { operationId: string; result: Promise<CreateCardResult> }>();
  /**
   * flowly_create_card (SUB-CARDS-SPEC §3): a new card of this project, by default a sub-card of
   * this session's card, in its own workspace. One card per signed request: the same call again
   * returns it, other parameters are REQUEST_REUSED like any write. start=now queues it for agent
   * automation when the project has automation on.
   */
  async createCard(identity: ToolIdentity, raw: CreateCardInput): Promise<CreateCardResult> {
    const input = createCardInputSchema.parse(raw);
    await this.handoffs?.assertWriter(identity);
    const signed = this.secrets.validateRequest(identity, input.request, input.expectedRevision);
    const requestKey = `agent-card:${digest(input.request.id)}`;
    const operationId = `${requestKey}:${digest(JSON.stringify(input))}`;
    // Claimed before the first await: agents issue tool calls in parallel with the request they just read.
    const pending = this.cardRequests.get(requestKey);
    if (pending) {
      if (pending.operationId !== operationId) throw requestReused();
      return { ...(await pending.result), replayed: true, message: "This card was already created by this request." };
    }
    const result = this.newCard(identity, input, signed.issuedAt, requestKey, operationId);
    this.cardRequests.set(requestKey, { operationId, result });
    try {
      return await result;
    } finally {
      this.cardRequests.delete(requestKey);
    }
  }
  private async newCard(identity: ToolIdentity, input: ReturnType<typeof createCardInputSchema.parse>, issuedAt: string, requestKey: string, operationId: string): Promise<CreateCardResult> {
    const actor: AgentCardActor = { ...identity, expectedRevision: input.expectedRevision, key: `${identity.agentId}:${digest(input.request.id)}`, payloadHash: digest(JSON.stringify({ action: "create_card", input })), start: input.start };
    try {
      return await this.makeCard(identity, input, issuedAt, requestKey, operationId, actor);
    } catch (e) {
      // A workspace this request already made stays in every refusal until its card is saved (subcards-2).
      if (!(e instanceof ToolError)) throw e;
      const notice = (await this.store.read().catch(() => null))?.agentReceipts.find((rc) => rc.key === actor.key)?.notice;
      if (!notice || e.message.includes(notice)) throw e;
      throw new ToolError(e.code, `${e.message} ${notice}`, e.retryable);
    }
  }
  private async makeCard(identity: ToolIdentity, input: ReturnType<typeof createCardInputSchema.parse>, issuedAt: string, requestKey: string, operationId: string, actor: AgentCardActor): Promise<CreateCardResult> {
    const r = await this.resources(identity);
    await this.handoffs?.assertWriter(identity, r.board);
    assertActiveCardWriter(r.board, identity);
    const before = await this.store.read();
    const replay = before.tasks.find((t) => t.operationId.startsWith(`${requestKey}:`));
    if (replay) {
      if (replay.operationId !== operationId) throw requestReused();
      return { cardId: replay.id, title: replay.title, status: replay.status, ...(input.subCard ? { subCardOf: r.task.id } : {}), queued: isLive(jobOf(before, replay.id)), replayed: true, message: "This card was already created by this request." };
    }
    // A request an earlier call reserved passed its signed-revision check then. Retrying it is the same decision,
    // so a change since (often this card's own parallel write) cannot strand the workspace it made (subcards-2).
    const reserved = before.agentReceipts.find((rc) => rc.key === actor.key);
    if (reserved && (reserved.payloadHash !== actor.payloadHash || reserved.action !== "create_card")) throw requestReused();
    if (reserved?.cardId) throw new ToolError("REQUEST_REUSED", "This request already created a card, which was deleted since. Call flowly_get_task again before creating another card.");
    if (!reserved) this.fresh(issuedAt);
    if (r.task.archivedAt || r.project.archivedAt) throw new ToolError("ARCHIVED", "Task or project is archived.");
    if (["done", "cancelled"].includes(r.task.status)) throw new ToolError("TASK_FINISHED", "A finished card cannot manage cards.");
    if (!r.context.available) throw new ToolError("WORKSPACE_INCOMPATIBLE", r.context.reason || "Workspace is unavailable.");
    if (!this.createTask) throw new ToolError("TOOLS_UNAVAILABLE", "Card creation is unavailable in this Flowly build.", true);
    const preferred: Status = input.start === "later" ? "backlog" : "todo";
    const status = [preferred, preferred === "backlog" ? "todo" : "backlog"].find((s) => laneEnabled(r.project, s as Status)) as Status | undefined;
    if (!status) throw new ToolError("STATUS_UNAVAILABLE", "This project has neither a Backlog nor a Todo lane for new cards.");
    checkStartable(r.project, input.start);
    const mode = input.workspace ?? (existsSync(join(r.project.primaryPath, ".git")) ? "worktree" : "directory");
    let task: Task;
    try {
      const draft = taskInput.parse({
          projectId: r.project.id,
          operationId,
          title: input.title,
          description: input.description,
          status,
          priority: input.priority,
          ...(input.type ? { type: input.type } : {}),
          ...(input.tags?.length ? { tags: input.tags } : {}),
          mode,
          baseRef: input.baseRef ?? "",
          ...(input.subCard ? { subCardOf: r.task.id } : {}),
          ...(input.blockedBy.length ? { blockedBy: input.blockedBy } : {}),
          ...(input.review_level && input.review_level !== "auto" ? { reviewLevel: input.review_level } : {}),
        });
      authorizeCardCreation(before, actor, { revision: !reserved });
      preflightCardLinks(this.store, before, draft);
      await this.store.transaction((board) => {
        // A new reservation checks the signed revision; an existing one did when it was made.
        this.cardReceipt(board, actor, "create_card");
        authorizeCardCreation(board, actor, { revision: false });
        return { value: null, changed: true };
      });
      task = await this.createTask(draft,
        r.paseo,
        actor,
      );
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError("CARD_INVALID", e instanceof Error ? e.message : String(e));
    }
    const queued = isLive(jobOf(await this.store.read(), task.id));
    const note = input.start === "now" && !queued ? " Agent automation is off for this project, so a person starts it." : "";
    if (queued) void this.automation?.kick();
    const parentJob = jobOf(await this.store.read(), r.task.id);
    const supervised = input.subCard && parentJob?.implementerId === identity.agentId && isLive(parentJob) && automationOf(r.project);
    this.accesses.set(identity.agentId, { at: new Date(this.clock()).toISOString(), action: "create_card" });
    return {
      cardId: task.id,
      title: task.title,
      status: task.status,
      ...(input.subCard ? { subCardOf: r.task.id } : {}),
      queued,
      ...(await this.handoffReminder(identity)),
      message: queued
        ? `Created and queued for agent automation.${supervised ? " End your turn after dispatching; Flowly wakes this supervised parent when its sub-cards settle." : " This session is not a supervised parent; check the card yourself or ask the user to run its automation."}${mode === "directory" ? " Directory workspaces share the project root and have no isolated branch; order conflicting work." : " Worktree starts at the project root branch by default; pass baseRef explicitly for parent-dependent work."}`
        : input.start === "later"
          ? `Created in ${laneName(r.project, task.status)} (parked). ${input.subCard ? "Start it later with flowly_update_card action=start." : "A person starts it with Run with agent; this card's agent can start only its direct sub-cards."}${note}`
          : `Created in ${laneName(r.project, task.status)}.${note}`,
    };
  }
  /**
   * flowly_update_card (SUB-CARDS-SPEC §4): this session's card manages one of its direct
   * sub-cards: start (queue it), accept (In review → Done) or cancel. Repeats are acknowledged.
   */
  private cardReceipt(board: Board, actor: AgentCardActor, action: "create_card" | "update_card") {
    const previous = board.agentReceipts.find((r) => r.key === actor.key);
    if (previous) {
      if (previous.payloadHash !== actor.payloadHash || previous.action !== action) throw requestReused();
      return previous;
    }
    board.agentReceipts = board.agentReceipts.filter((r) => Date.parse(r.expiresAt) > this.clock());
    if (board.agentReceipts.length >= 5000) throw new ToolError("RECEIPTS_FULL", "Agent receipt capacity is full.", true);
    const { task, project } = authorizeCardActor(board, actor);
    const receipt: Receipt = { key: actor.key, agentId: actor.agentId, taskId: actor.taskId, payloadHash: actor.payloadHash, action, eventId: "", taskRevision: task.revision, projectRevision: project.revision, status: task.status, at: new Date(this.clock()).toISOString(), expiresAt: new Date(this.clock() + 7 * 86400000).toISOString() };
    board.agentReceipts.push(receipt);
    return receipt;
  }

  async updateCard(identity: ToolIdentity, raw: UpdateCardInput) {
    const input = updateCardInputSchema.parse(raw);
    await this.handoffs?.assertWriter(identity);
    // A review level goes alone or with start (AUTOMATION-SPEC §5.2.1); refused before anything is recorded.
    if (!input.action && !input.review_level) throw new ToolError("INVALID_INPUT", "Give an action, a review_level, or both (review_level only with action=start).");
    if (input.review_level && input.action && input.action !== "start") throw new ToolError("INVALID_INPUT", `review_level goes alone or with action=start, not with action=${input.action}; nothing was changed.`);
    const signed = this.secrets.validateRequest(identity, input.request, input.expectedRevision);
    const r = await this.resources(identity);
    const actor: AgentCardActor = { ...identity, expectedRevision: input.expectedRevision, key: `${identity.agentId}:${digest(input.request.id)}`, payloadHash: digest(JSON.stringify({ action: "update_card", input })), start: "later" };
    type Answer = { cardId: string; status: Status; queued: boolean; replayed?: boolean; message: string; previous?: Status; moved?: Task };
    const result = await this.store.transaction<Answer>((board) => {
      assertActiveCardWriter(board, identity);
      // A retry after a lost response gets its recorded result, also once this card has finished since.
      const existing = board.agentReceipts.find((receipt) => receipt.key === actor.key);
      if (existing) {
        if (existing.payloadHash !== actor.payloadHash || existing.action !== "update_card") throw requestReused();
        return { value: { cardId: existing.cardId!, status: existing.status === "in_progress" ? "development" : existing.status, queued: !!existing.queued, replayed: true, message: "This sub-card action was already recorded." }, changed: false };
      }
      if (r.task.archivedAt || r.project.archivedAt) throw new ToolError("ARCHIVED", "Task or project is archived.");
      if (["done", "cancelled"].includes(r.task.status)) throw new ToolError("TASK_FINISHED", "A finished card cannot manage cards.");
      if (!r.context.available) throw new ToolError("WORKSPACE_INCOMPATIBLE", r.context.reason || "Workspace is unavailable.");
      this.fresh(signed.issuedAt);
      const { task: parent, project } = authorizeCardActor(board, actor);
      const child = board.tasks.find((t) => t.id === input.cardId);
      if (!child || child.projectId !== project.id || parentOf(board.links, child.id) !== parent.id) throw new ToolError("NOT_PARENT", "Only direct sub-cards of this session's card can be managed.");
      if (child.archivedAt) throw new ToolError("ARCHIVED", "That sub-card is archived.");
      if (!input.action) {
        // Only the review level (§5.2): no move, no queue; it applies from the sub-card's next review round.
        if (["done", "cancelled"].includes(child.status)) throw new ToolError("TASK_FINISHED", "That sub-card is already finished.");
        const changed = this.setReviewLevel(board, child, input.review_level!, identity.agentId);
        const queued = isLive(jobOf(board, child.id));
        const receipt = this.cardReceipt(board, actor, "update_card");
        receipt.cardId = child.id; receipt.status = child.status; receipt.queued = queued;
        return { value: { cardId: child.id, status: child.status, queued, message: changed ? `Review level set to ${input.review_level}; it applies from the sub-card's next review round.` : `The review level already is ${input.review_level}; nothing changed.` }, changed: true };
      }
      // Automation never runs work under a cancelled or archived ancestor; cancelling stays possible.
      if (input.action === "start") refuseAbandonedTree(board, parent.id, "start sub-cards");
      const job = jobOf(board, child.id);
      if (input.action === "start" && job?.state === "failed") throw new ToolError("NEEDS_PERSON", "This job failed. A person must choose Run again.");
      if (input.action === "start" && job?.state === "stopped") throw new ToolError("TAKEN_BY_PERSON", "This job was stopped or moved. A person must choose Run again.");
      // A live job has no turn to take a note (or a rework of its delivery): refused, never acknowledged and dropped.
      if (input.action === "start" && job && isLive(job) && (input.note || child.status === "in_review")) {
        const dropped = input.note ? " and the note was not delivered" : "";
        const liveWords: Partial<Record<string, string>> = { waiting: "waiting for its own sub-cards", retry_wait: "waiting to retry a turn", reviewing: "reviewing its delivery" };
        if (job.state === "needs_human") throw new ToolError("NEEDS_PERSON", `This sub-card waits for a person (${job.code ?? "needs_human"}); a person answers it in its own session. Nothing was changed${dropped}.`);
        throw new ToolError("CHILD_BUSY", `This sub-card's automation is still ${liveWords[job.state] ?? job.state}. Nothing was changed${dropped}; wait until it settles, then start it again with the note.`);
      }
      const noop = (input.action === "accept" && child.status === "done") || (input.action === "cancel" && child.status === "cancelled") || (input.action === "start" && isLive(job));
      const levelSet = !!input.review_level && !["done", "cancelled"].includes(child.status) && this.setReviewLevel(board, child, input.review_level, identity.agentId);
      // `replayed` means nothing changed: a start that finds the job live still changed the level (AUTOMATION-SPEC §5.2.1).
      const replayed = noop && !levelSet;
      if (!noop && ["done", "cancelled"].includes(child.status)) throw new ToolError("TASK_FINISHED", "That sub-card is already finished.");
      if (!noop && input.action === "accept" && child.status !== "in_review") throw new ToolError("NOT_DELIVERED", "Only a delivered sub-card in In review can be accepted.");
      // The parent accepts a settled delivery, after the sub-card's own review; a person can still move it to Done directly.
      if (!noop && input.action === "accept" && job && isLive(job) && automationAllowed(board, job)) {
        const after = "Nothing was changed; a supervised parent is woken when it settles, other sessions check again later.";
        if (job.role === "reviewer" || job.reopened)
          throw new ToolError("REVIEW_RUNNING", `This sub-card's review is still ${job.state === "needs_human" ? "waiting for a person" : "open"}: wait for its verdict, then accept it or request changes. ${after}`);
        if (job.state === "needs_human") throw new ToolError("NEEDS_PERSON", `This sub-card waits for a person (${job.code ?? "needs_human"}); a person answers it in its own session. ${after}`);
        throw new ToolError("CHILD_BUSY", `This sub-card's automation is still running (${job.state}): its delivery is not settled, and a review may follow. ${after}`);
      }
      if (input.action === "start" && child.status === "in_review" && !input.note?.trim()) throw new ToolError("FEEDBACK_REQUIRED", "Describe the changes required when restarting a delivered sub-card.");
      const target: Status = noop ? child.status : input.action === "accept" ? "done" : input.action === "cancel" ? "cancelled" : child.status === "in_review" ? resumeStage(board, child, project) ?? child.status : child.status === "backlog" && laneEnabled(project, "todo") ? "todo" : child.status;
      if (!laneEnabled(project, target)) throw new ToolError("STATUS_UNAVAILABLE", "The target lane is disabled.");
      const previous = child.status;
      if (!noop && (target !== previous || input.note)) {
        child.status = target;
        child.revision++;
        child.updatedAt = new Date(this.clock()).toISOString();
        this.store.event(board, { taskId: child.id, actor: "agent", agentId: identity.agentId, action: target !== previous ? "status_changed" : "progress_reported", from: previous, to: target, note: input.note || `Parent card ${input.action}: ${parent.title}` });
      }
      if (!noop && input.action === "start" && this.automation && automationOf(project)) this.automation.queueIn(board, child.id, { agentId: identity.agentId }, input.note);
      const queued = isLive(jobOf(board, child.id));
      const receipt = this.cardReceipt(board, actor, "update_card");
      receipt.cardId = child.id; receipt.status = child.status; receipt.queued = queued;
      const level = levelSet ? `Review level set to ${input.review_level}` : "";
      const message = replayed
        ? input.action === "start" ? "This sub-card is already queued or running; nothing changed." : "This sub-card is already in the requested state."
        : noop
          ? `${level}; the sub-card is already queued or running, so nothing else changed and the level applies from its next review round.`
          : `${level ? `${level}. ` : ""}${queued ? "Queued for automation. End your turn only if this parent is supervised; otherwise check progress yourself." : "Agent automation is off; a person starts the card."}`;
      return { value: { cardId: child.id, status: child.status, queued, ...(replayed ? { replayed: true } : {}), message: input.action === "accept" && !noop ? "Accepted: the sub-card is Done." : input.action === "cancel" && !noop ? "Cancelled." : message, previous, moved: { ...child } }, changed: true };
    });
    if (result.moved && result.previous !== result.status) this.onStatusChange?.(result.previous, result.moved, r.paseo);
    void this.automation?.kick();
    this.accesses.set(identity.agentId, { at: new Date(this.clock()).toISOString(), action: "update_card" });
    const { previous: _previous, moved: _moved, ...answer } = result;
    return { ...answer, ...(await this.handoffReminder(identity)) };
  }
  /** A parent's agent sets its sub-card's review level (AUTOMATION-SPEC §5.2.1); whether it changed. `auto` removes it. */
  private setReviewLevel(board: Board, child: Task, value: NonNullable<UpdateCardInput["review_level"]>, agentId: string) {
    const next = value === "auto" ? undefined : value;
    if (child.reviewLevel === next) return false;
    if (next) child.reviewLevel = next;
    else delete child.reviewLevel;
    child.revision++;
    child.updatedAt = new Date(this.clock()).toISOString();
    this.store.event(board, { taskId: child.id, actor: "agent", agentId, action: "review_level_set", note: `${reviewLevelNote(next)} (set by the parent card's agent)` });
    return true;
  }
  /** flowly_submit_review (AUTOMATION-SPEC §5): the verdict of the reviewer session automation started for this card. */
  async review(identity: ToolIdentity, input: ReviewInput) {
    await this.resources(identity);
    await this.handoffs?.assertWriter(identity);
    if (!this.automation) throw new ToolError("NOT_REVIEWER", "Agent automation is unavailable in this Flowly build.");
    const result = await this.automation.submitReview(identity, input, this.handoffs ? async (board, sourceId) => {
      assertActiveCardWriter(board, identity);
      await this.handoffs!.prepareReview(identity, sourceId, input, board);
    } : undefined);
    if (result.handoffSourceId) await this.handoffs?.confirmSource(identity.taskId, result.handoffSourceId);
    const { handoffSourceId: _source, ...answer } = result;
    this.accesses.set(identity.agentId, { at: new Date(this.clock()).toISOString(), action: "review" });
    return answer;
  }
  /** flowly_recall (PROJECT-MEMORY-SPEC §6.4): read-only. */
  async recall(identity: ToolIdentity, raw: RecallInput) {
    const input = recallInputSchema.parse(raw);
    const r = await this.resources(identity);
    if (!this.memory) throw new ToolError("MEMORY_DISABLED", "Project memory is unavailable in this Flowly build.");
    const found = await this.memory.recall(r.project, r.task.id, input).catch((e) => {
      throw memoryToolError(e);
    });
    this.accesses.set(identity.agentId, { at: new Date(this.clock()).toISOString(), action: "recall" });
    return found;
  }
  /** Per-session external content last seen, for external `unread`. */
  readonly externalReads: ExternalReadStore;
  /**
   * Current summaries of the card's external inputs and whether their content
   * changed since this session last saw it. A service being unreachable never
   * fails get_task: the cached values come back marked stale.
   */
  private async externalInfo(agentId: string, list: readonly Artifact[]) {
    const out = new Map<string, { external: ExternalContext; changed: boolean; fingerprint: string }>();
    if (!this.connectors || !list.some((a) => a.external)) return out;
    const connectors = this.connectors;
    const located = await connectors.locate(list).catch(() => new Map<string, null>());
    const refs = [...located.values()].filter((r): r is NonNullable<typeof r> => !!r);
    const [summaries, seen] = await Promise.all([
      refs.length ? connectors.summaries(refs).catch(() => new Map()) : new Map(),
      this.externalReads.seen(agentId).catch(() => ({}) as Record<string, string>),
    ]);
    for (const a of list) {
      if (!a.external) continue;
      const ref = located.get(a.id);
      const hit = ref ? summaries.get(refKey(ref)) : undefined;
      const fingerprint = hit?.fingerprint || "";
      out.set(a.id, {
        external: {
          provider: a.external.provider,
          itemType: hit?.summary.itemType || itemTypeOf(a.external),
          key: hit?.summary.key || a.external.key,
          summary: hit?.summary.summary || a.title,
          status: hit?.summary.status || "",
          type: hit?.summary.type || "",
          priority: hit?.summary.priority || "",
          assignee: hit?.summary.assignee || "",
          container: hit?.summary.container || "",
          updated: hit?.summary.updated || "",
          stale: !hit || hit.stale,
          connection: ref ? "ok" : "removed",
        },
        changed: fingerprintChanged(a.role, seen[a.id], fingerprint),
        fingerprint,
      });
    }
    return out;
  }
  /** flowly_read_external, alias flowly_read_ticket (CONNECTORS-SPEC §9): one of this card's external inputs, read-only. */
  async readExternal(identity: ToolIdentity, input: ReadExternalInput) {
    const r = await this.resources(identity);
    const board = await this.store.read();
    const artifact = board.artifacts.find((a) => a.id === input.artifactId && a.taskId === r.task.id);
    if (!artifact) throw new ToolError("EXTERNAL_NOT_FOUND", "No artifact with that id on this card. Use an id from get_task artifacts.");
    if (!artifact.external)
      throw new ToolError("EXTERNAL_NOT_FOUND", "This artifact is not an external input. Read files through absolutePath and other links with your web tool.");
    if (!this.connectors) throw new ToolError("CONNECTORS_DISABLED", "Connectors are unavailable in this Flowly build.");
    const service = serviceName(artifact.external.provider);
    const ref = (await this.connectors.locate([artifact])).get(artifact.id);
    if (!ref)
      throw new ToolError(
        "EXTERNAL_UNAVAILABLE",
        `The user removed this ${service} connection in Flowly settings, so the item can't be read. Tell the user and ask them to add the connection again (Settings → Connections) or paste what you need; don't guess the content.`,
      );
    try {
      const detail = await this.connectors.detail(ref, input.refresh ?? false);
      if (detail.fingerprint)
        await this.externalReads.mark(identity.agentId, { [artifact.id]: detail.fingerprint }).catch(() => undefined);
      this.accesses.set(identity.agentId, { at: new Date(this.clock()).toISOString(), action: "external" });
      return {
        artifactId: artifact.id,
        key: detail.summary.key,
        url: detail.summary.url,
        status: detail.summary.status,
        markdown: detail.markdown,
        truncated: detail.truncated,
        stale: detail.stale,
        fetchedAt: detail.fetchedAt,
      };
    } catch (error) {
      if (error instanceof ExternalError)
        throw new ToolError(
          error.code === "EXTERNAL_INVALID" ? "EXTERNAL_UNAVAILABLE" : error.code,
          error.code === "EXTERNAL_AUTH"
            ? `The ${service} connection's token was refused. Ask the user to update it in Flowly settings → Connections; don't guess the content.`
            : error.message,
          error.code === "EXTERNAL_UNAVAILABLE",
        );
      throw error;
    }
  }
  /** Per-session last read of the card's artifacts, for `unread` (CARD-ARTIFACTS-SPEC §4.2). */
  readonly artifactReads: ArtifactReadStore;
  attach(paseo: PaseoApi) {
    this.paseo = paseo;
  }
  get sdkReady() {
    return !!this.paseo;
  }
  private api() {
    if (!this.paseo)
      throw new ToolError(
        "PASEO_UNAVAILABLE",
        "Paseo context is not ready after startup/reload. Refresh the drawer or start the next session turn, then re-read.",
        true,
      );
    return this.paseo;
  }
  private async resources(identity: ToolIdentity) {
    const paseo = this.api();
    const actor = await paseo.agents.ref(identity.agentId).refresh();
    if (
      !actor?.agent ||
      actor.agent.archivedAt ||
      actor.agent.workspaceId !== identity.workspaceId
    )
      throw new ToolError(
        "SESSION_MISMATCH",
        "Session is unavailable, archived, or belongs to another workspace.",
      );
    const board = await this.store.read(),
      task = board.tasks.find((t) => t.id === identity.taskId),
      project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project || task.workspaceId !== identity.workspaceId)
      throw new ToolError(
        "SESSION_MISMATCH",
        "Card is missing or no longer bound to this workspace.",
      );
    const workspace = await paseo.workspaces
      .ref(identity.workspaceId)
      .refresh();
    if (!workspace || workspace.archivingAt)
      throw new ToolError(
        "RESOURCE_UNAVAILABLE",
        "Workspace is unavailable or being archived.",
      );
    const context = await new BoardService(this.store).context(
      task.id,
      paseo,
      board,
    );
    if (!context.workspaceRepoPaths.length)
      throw new ToolError(
        "WORKSPACE_INCOMPATIBLE",
        "Workspace is outside the board project's repositories.",
      );
    return { paseo, task, project, workspace, context, board };
  }
  /**
   * `markArtifacts`: this call is the session reading its card (flowly_get_task),
   * so artifacts and comments it returns stop being unread for that session. The context
   * returned after a write shows the flags without clearing them.
   * `handoffs: false` (the context returned after a write): links without handoffs or branches,
   * so a write never pays for reading linked workspaces; get_task has them.
   */
  async get(identity: ToolIdentity, recordAccess = true, markArtifacts = recordAccess, { handoffs: withHandoffs = true, handoff, handoffCursor }: { handoffs?: boolean; handoff?: "full"; handoffCursor?: string } = {}): Promise<ToolContext> {
    // Taken before reading the board: an artifact added meanwhile stays unread.
    const readAt = new Date(Math.max(Date.now(), this.clock())).toISOString();
    const lastRead = await this.artifactReads.lastRead(identity.agentId).catch(() => undefined);
    const r = await this.resources(identity);
    const entries: { id: string; title: string; status: string }[] = [];
    let cursor: string | undefined,
      scanned = 0,
      unavailableReason = "",
      partial = false;
    try {
      do {
        const page = await r.paseo.agents.list({
          filter: { includeArchived: true },
          page: { limit: 200, cursor },
        });
        scanned += page.entries.length;
        entries.push(
          ...page.entries
            .map((e) => e.agent)
            .filter((a) => a.workspaceId === identity.workspaceId && !isSummarizer(a))
            .map((a) => ({
              id: a.id,
              title: a.title || a.id,
              status: a.archivedAt ? "archived" : a.status,
            })),
        );
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor && entries.length < 20 && scanned < 2000);
      partial = !!cursor || entries.length > 20;
    } catch {
      partial = true;
      unavailableReason = "Session summary is currently unavailable.";
    }
    const revision = { task: r.task.revision, project: r.project.revision };
    const finished = ["done", "cancelled"].includes(r.task.status);
    const role = ((await this.handoffs?.role(identity, r.board)) ?? automationSessionRole(r.board, identity.agentId, identity.taskId))?.role;
    const retired = role === "retired", finalizing = role === "finalizing";
    const continuity = await this.handoffs?.context(identity.taskId, identity.agentId, { full: handoff === "full", cursor: handoffCursor, recordAccess });
    // The project's paseo.json scripts, so agents run them instead of retyping (WORKFLOW-INSIGHTS-SPEC §5.4).
    const scripts = await projectScripts(r.project).catch(() => []);
    let externals = new Map<string, { changed: boolean; fingerprint: string; external: ExternalContext }>();
    let setup: ToolContext["setup"];
    const built: ToolContext = {
      identity,
      ...(continuity ? { handoff: continuity } : {}),
      // A reviewer session gets its own rules: the implementer's stage, workpad and delivery steps are not its job (AUTOMATION-SPEC §7).
      turnChecklist: [...(reviewerOfCard(r.board, r.task.id, identity.agentId) ? reviewerChecklist : turnChecklist)],
      task: r.task,
      project: r.project,
      revision,
      request: this.secrets.request(identity, revision),
      toolVersion: 1,
      writable: r.context.available && !finished && !retired && !finalizing,
      reason:
        (retired ? "RETIRED_SESSION: this session was replaced; read the handoff and continue in the current session." : finalizing ? "FINALIZING: update the handoff and end the turn; normal card writes are disabled." : r.context.reason) ||
        (finished ? "Task is finished; only a human can reopen it." : ""),
      // Agents may only use agent statuses that are lanes of this project.
      allowedStatuses: agentStatuses.filter((status) => laneEnabled(r.project, status)),
      lanes: enabledStatuses(r.project).map((status) => ({ status, name: laneName(r.project, status) })),
      scope: {
        mode: isLegacyScope(r.task, r.project) ? "selected" : "all",
        repoPaths: r.context.directories.map((p) => p.repo),
        directories: r.context.directories,
      },
      workspace: {
        id: r.workspace.id,
        directory: r.workspace.workspaceDirectory,
        kind: r.workspace.workspaceKind,
        nativeOwner: r.context.owner,
        status: r.workspace.status,
        repoPaths: r.context.workspaceRepoPaths,
      },
      sessions: { entries: entries.slice(0, 20), partial, unavailableReason },
      ...(await this.store.read().then(async (board) => {
        const { handoffs, branches } = withHandoffs ? await linkExtras(board, r.task.id, r.paseo, this.git, this.handoffs?.linkSummary.bind(this.handoffs)) : { handoffs: new Map<string, LinkHandoff>(), branches: new Map<string, string>() };
        const emittedHandoffs = new Set<string>();
        setup = setupContext(setupMissing(r.task, workpadOf(board.workpads, r.task.id), workpadEnabled(r.project)), r.task.status);
        // The reviewer also sees the holdout suite and the requirement table; implementers never do (§5.4.2).
        const acceptance = automationOf(r.project)?.acceptance && this.acceptance
          ? await this.acceptance.context(r.task.id, reviewerOfCard(board, r.task.id, identity.agentId), r.workspace.workspaceDirectory).catch(() => null)
          : null;
        return {
          ...(acceptance ? { acceptance } : {}),
          reviewLevel: levelContext(board, r.task),
          // Comments come in `comments` only, with their own unread flag and bound (CARD-COMMENTS-SPEC §3).
          activity: board.events.filter((e) => e.taskId === r.task.id && !isComment(e)).slice(-20),
          comments: agentComments(board.events, r.task.id, lastRead),
          projectTags: projectTagStats(board.tasks, r.project.id).map(({ tag, count }) => ({ tag, count })),
          outputLanguage: outputLanguage(await this.aiLanguage()),
          ideas: board.ideas
            .filter((i) => i.taskId === r.task.id)
            .map((i) => ({
              id: i.id,
              title: i.title,
              status: i.status,
              ...(i.scope ? { scope: i.scope } : {}),
              ...(i.acceptedTaskId ? { acceptedTaskId: i.acceptedTaskId } : {}),
              ...(i.acceptedAgentId ? { acceptedAgentId: i.acceptedAgentId } : {}),
            })),
          artifacts: await (async () => {
            const list = artifactsOf(board.artifacts, r.task.id).slice(0, 100);
            const where = artifactRoots(r.task, r.project, r.workspace.workspaceDirectory);
            const missing = await missingArtifacts(list, where);
            externals = await this.externalInfo(identity.agentId, list);
            return list.map((a) => ({
              id: a.id,
              role: a.role,
              kind: a.kind,
              target: a.target,
              ...(a.kind === "file" ? { absolutePath: absoluteTarget(a.target, where.workspace) } : {}),
              title: a.title,
              note: a.note,
              createdBy: a.createdBy,
              missing: missing.has(a.id),
              // Added or edited since this session last read the card; its own additions never count.
              unread:
                (!(a.createdBy === "agent" && a.agentId === identity.agentId) && (!lastRead || a.updatedAt > lastRead)) ||
                !!externals.get(a.id)?.changed,
              ...(externals.has(a.id) ? { external: externals.get(a.id)!.external } : {}),
              // Sessions started with the older skill look for `ticket` (CONNECTORS-SPEC §3.3).
              ...(externals.has(a.id) && familyOf(a.external!.provider) === "jira" ? { ticket: externals.get(a.id)!.external } : {}),
            }));
          })(),
          ...(workpadEnabled(r.project)
            ? { workpadEnabled: true, ...workpadContext(board.workpads, board.plans, r.task.id, identity.agentId) }
            : { workpadEnabled: false, workpad: null, plan: [] }),
          ...(this.memory ? { memory: await this.memory.taskContext(r.task, r.project).catch(() => ({ enabled: false, total: 0, entries: [], candidates: [] })) } : {}),
          ...(scripts.length ? { projectScripts: scripts } : {}),
          links: linksOf(board, r.task.id)
            .filter((v) => v.other)
            .map(({ relation, other }) => {
              const handoff = handoffs.get(other!.id);
              const emitHandoff = !!handoff && !emittedHandoffs.has(other!.id);
              if (emitHandoff) emittedHandoffs.add(other!.id);
              return {
                relation,
                taskId: other!.id,
                title: other!.title,
                status: other!.status,
                laneName: laneName(r.project, other!.status),
                archived: !!other!.archivedAt,
                ...(branches.has(other!.id) ? { branch: branches.get(other!.id)! } : {}),
                // A parent reads which sub-cards it set to which level, and what Auto picks for the rest (AUTOMATION-SPEC §5.2.1).
                ...(relation === "sub_card" ? { reviewLevel: levelContext(board, other!) } : {}),
                ...(emitHandoff ? { handoff } : {}),
                ...(relation === "blocked_by" ? { resolved: isResolved(other) } : {}),
              };
            }),
        };
      })),
    };
    // `setup` right after identity, so it is the first thing the agent reads (CARD-SETUP-SPEC §3.1).
    const { identity: _identity, ...rest } = built;
    const value: ToolContext = { identity, setup, ...rest };
    if (recordAccess)
      this.accesses.set(identity.agentId, {
        at: new Date(this.clock()).toISOString(),
        action: "get",
      });
    if (markArtifacts && (value.artifacts.length || value.comments.length))
      await this.artifactReads.mark(identity.agentId, readAt).catch((e) =>
        logFailure("Kanban artifact reads not saved:", e),
      );
    const seenExternals = Object.fromEntries([...externals].filter(([, v]) => v.fingerprint).map(([id, v]) => [id, v.fingerprint]));
    if (markArtifacts && Object.keys(seenExternals).length)
      await this.externalReads.mark(identity.agentId, seenExternals).catch((e) =>
        logFailure("Kanban external reads not saved:", e),
      );
    return value;
  }
  /** Each commit the agent named, verified in the workspace repository (WORKPAD-SPEC §5.1). */
  private async commits(input: WorkpadInput, dir: string, head: GitHead | null) {
    const given = [...new Set(input.validation.flatMap((v) => (v.sha && v.state !== "unrun" ? [v.sha] : [])))];
    const resolved = new Map<string, string>();
    if (given.length && !head)
      throw new ToolError("WORKPAD_INVALID", "This workspace is not a git repository (or git is unavailable); omit sha.");
    for (const sha of given) {
      const value = await resolveCommit(dir, sha, this.git);
      if (!value) throw new ToolError("WORKPAD_INVALID", `"${sha}" is not a commit in this workspace's repository.`);
      resolved.set(sha, value);
    }
    return resolved;
  }
  async write(
    identity: ToolIdentity,
    action: "status" | "progress" | "idea" | "idea_update" | "idea_remove" | "remember" | "artifact" | "artifact_remove" | "tags" | "type" | "metadata" | "next_moves" | "workpad",
    raw: unknown,
  ): Promise<ToolResult> {
    const input: MetadataInput | StatusInput | ProgressInput | IdeaInput | IdeaUpdateInput | IdeaRemovalInput | RememberInput | ArtifactToolInput | ArtifactRemovalInput | TagsToolInput | TypeToolInput | NextMovesInput | WorkpadInput =
      action === "metadata" ? metadataInputSchema.parse(raw) : action === "status"
        ? statusInputSchema.parse(raw)
        : action === "remember"
          ? rememberInputSchema.parse(raw)
          : action === "idea"
          ? ideaInputSchema.parse(raw)
          : action === "idea_update"
          ? ideaUpdateInputSchema.parse(raw)
          : action === "idea_remove"
          ? ideaRemovalSchema.parse(raw)
          : action === "artifact"
            ? artifactInputSchema.parse(raw)
            : action === "artifact_remove"
              ? artifactRemovalSchema.parse(raw)
              : action === "tags"
                ? tagsInputSchema.parse(raw)
                : action === "type"
                  ? typeInputSchema.parse(raw)
                  : action === "next_moves"
                    ? nextMovesInputSchema.parse(raw)
                    : action === "workpad"
                      ? workpadInputSchema.parse(raw)
                      : progressInputSchema.parse(raw);
    const signed = this.secrets.validateRequest(
      identity,
      input.request,
      input.expectedRevision,
    );
    const resources = await this.resources(identity);
    await this.handoffs?.assertWriter(identity, resources.board);
    assertActiveCardWriter(resources.board, identity);
    // Reviewer sessions report findings; they never work the card (AUTOMATION-SPEC §7). Refused before anything is recorded.
    if (
      reviewerWrites.has(action) &&
      !(action === "progress" && (input as ProgressInput).kind !== "result") &&
      reviewerOfCard(resources.board, resources.task.id, identity.agentId)
    )
      throw new ToolError(
        "REVIEWER_ONLY",
        "A reviewer reports findings with flowly_submit_review or kind=question; it does not change the card's status, workpad, type, tags, ideas or artifacts, or report results.",
      );
    // Read for the idea tools, and for a delivery whose result may remind of ideas (IDEAS-SPEC §4.1).
    const ideaWrite = action === "idea" || action === "idea_update" || action === "idea_remove";
    const ideasOn =
      ideaWrite || (action === "status" && (input as StatusInput).status === "in_review") ? await this.ideasOn() : true;
    const outputDelivery =
      (action === "status" && (input as StatusInput).status === "in_review") ||
      (action === "progress" && (input as ProgressInput).kind === "result");
    const outputs = action === "status" || action === "progress" ? (input as StatusInput | ProgressInput).outputs : undefined;
    if (outputs !== undefined && !outputDelivery)
      throw new ToolError("INVALID_INPUT", "outputs is only valid for status=in_review or kind=result.");
    const artifactWrite = action === "artifact" || action === "artifact_remove";
    const artifactsOn = artifactWrite || outputDelivery ? await this.artifactsOn() : true;
    const key = `${identity.agentId}:${digest(input.request.id)}`,
      payloadHash = digest(JSON.stringify({ action, input }));
    // Exact replays must survive a missing file, disconnected connector or a changed artifacts setting.
    const priorReceipt = outputs?.length ? (await this.store.read()).agentReceipts.find((r) => r.key === key) : undefined;
    if (priorReceipt && priorReceipt.payloadHash !== payloadHash)
      throw new ToolError("REQUEST_REUSED", "Request already committed with different parameters.");
    const outputTargets: (Omit<NewArtifact, "taskId" | "role" | "createdBy" | "agentId"> & { notice?: string })[] = [];
    if (outputs?.length && !priorReceipt) {
      if (!artifactsOn)
        throw new ToolError("ARTIFACTS_DISABLED", "Agent artifacts are turned off in Flowly settings. List your deliverables in your reply and deliver with outputs=[] instead.");
      for (const output of outputs) {
        try {
          let external;
          let notice: string | undefined;
          try {
            external = await externalArtifact(this.connectors, output.target);
          } catch (e) {
            // Saving an explicit link does not require permission to read its private metadata.
            // Bare keys still require recognition; invalid URLs and programmer errors still refuse.
            if (!(e instanceof ExternalError) || !/^https?:\/\//i.test(output.target)) throw e;
            notice = "External details could not be read; no external status or content was verified.";
          }
          const target = external ?? await normalizeTarget(output.target, artifactRoots(resources.task, resources.project, resources.workspace.workspaceDirectory));
          outputTargets.push({ ...output, ...target, title: output.title || external?.title, ...(notice ? { notice } : {}) });
        } catch (e) {
          throw new ToolError("ARTIFACT_INVALID", e instanceof Error ? e.message : String(e));
        }
      }
    }
    // Paths are checked before the write; the transaction only records the result.
    // An item link or key of a configured connection becomes an external input (CONNECTORS-SPEC §3.1).
    const externalTarget =
      action === "artifact" && artifactsOn
        ? await externalArtifact(this.connectors, (input as ArtifactToolInput).target).catch((e) => {
            throw new ToolError("ARTIFACT_INVALID", e instanceof Error ? e.message : String(e));
          })
        : null;
    const artifactTarget =
      action === "artifact" && artifactsOn
        ? externalTarget
          ? { kind: externalTarget.kind, target: externalTarget.target, external: externalTarget.external, externalTitle: externalTarget.title }
          : await normalizeTarget(
              (input as ArtifactToolInput).target,
              artifactRoots(resources.task, resources.project, resources.workspace.workspaceDirectory),
            ).catch((e) => {
              throw new ToolError("ARTIFACT_INVALID", e instanceof Error ? e.message : String(e));
            })
        : undefined;
    // Git runs outside the transaction: the workpad's HEAD stamp and commits (WORKPAD-SPEC §4.2, §5.1),
    // and the HEAD the delivery check compares checks against (§5.3).
    const delivering = action === "status" && (input as StatusInput).status === "in_review";
    const head: GitHead | null | undefined =
      action === "workpad" || delivering
        ? await readHead(resources.workspace.workspaceDirectory, this.git, new Date(this.clock()).toISOString())
        : undefined;
    const commits = action === "workpad" ? await this.commits(input as WorkpadInput, resources.workspace.workspaceDirectory, head ?? null) : undefined;
    // Tags are normalized before the write; one invalid value refuses the whole call (CARD-TAGS-SPEC §4.1).
    const tagEdit =
      action === "tags" || action === "idea" || (action === "idea_update" && (input as IdeaUpdateInput).tags)
        ? normalizeToolTags(action === "tags" ? "tags" : "idea", input as TagsToolInput | IdeaInput)
        : undefined;
    // A memory candidate (PROJECT-MEMORY-SPEC §4.1): its refusals come before the card write, so they leave no receipt.
    const memoryInput =
      action === "remember"
        ? (() => {
            const m = input as RememberInput;
            try {
              return { ...m, tags: normalizeTags(m.tags) };
            } catch (e) {
              throw new ToolError("TAG_INVALID", e instanceof Error ? e.message : String(e));
            }
          })()
        : undefined;
    if (memoryInput) {
      if (!this.memory) throw new ToolError("MEMORY_DISABLED", "Project memory is unavailable in this Flowly build.");
      const { kind, title, body, tags, keywords, supersedes } = memoryInput;
      const isReplay = (await this.store.read()).agentReceipts.some((r) => r.key === `${identity.agentId}:${digest(input.request.id)}`);
      if (!isReplay)
        await this.memory.precheck(resources.project, resources.task.id, { kind, title, body, tags, keywords, supersedes }).catch((e) => {
          throw memoryToolError(e);
        });
    }
    // What this call left out (NEXT-MOVES-SPEC §9): read from the board as it is after the write, also on a replay
    // (the first response may have been lost), and only while the card still takes writes.
    const call: DeliveryCall | undefined =
      action === "status"
        ? { action, status: (input as StatusInput).status }
        : action === "progress"
          ? { action, kind: (input as ProgressInput).kind }
          : undefined;
    // Missing card setup rides on every write (CARD-SETUP-SPEC §3.3), after the delivery reminders. Not a
    // reviewer's: setup writes return REVIEWER_ONLY, so it reports missing setup as a finding (AUTOMATION-SPEC §5).
    const reminders = (board: Board): string[] => {
      const task = board.tasks.find((t) => t.id === identity.taskId);
      if (!task || task.archivedAt || ["done", "cancelled"].includes(task.status)) return [];
      const project = board.projects.find((p) => p.id === task.projectId);
      if (project?.archivedAt) return [];
      const out = call ? deliveryReminders(board, { taskId: task.id, agentId: identity.agentId }, call, ideasOn) : [];
      if (outputDelivery && outputs === undefined && artifactsOn) out.push(outputsReminder);
      const missing = reviewerOfCard(board, task.id, identity.agentId) ? [] : setupMissing(task, workpadOf(board.workpads, task.id), workpadEnabled(project));
      if (missing.length) out.push(setupReminder(missing));
      return out;
    };
    const handoffBoundary = (action === "status" && ["in_review", "blocked"].includes((input as StatusInput).status)) || (action === "progress" && ["question", "blocker"].includes((input as ProgressInput).kind));
    const continuity = handoffBoundary && this.handoffs && automationOf(resources.project) && !reviewerOfCard(resources.board, resources.task.id, identity.agentId) ? await this.handoffs.context(identity.taskId, identity.agentId, { recordAccess: false, forGate: true }) : undefined;
    const handoffGap = continuity && !continuity.fresh ? continuity.due : [];
    const questionKind = action === "progress" && ["question", "blocker"].includes((input as ProgressInput).kind) ? (input as ProgressInput).kind as "question" | "blocker" : action === "status" && (input as StatusInput).status === "blocked" ? "blocker" : undefined;
    const semanticSource = questionKind ? `question:${key}` : delivering ? `delivery:${key}` : undefined;
    const result = await this.store.transaction(async (board) => {
      assertActiveCardWriter(board, identity);
      const existing = board.agentReceipts.find((r) => r.key === key);
      if (existing) {
        if (existing.payloadHash !== payloadHash)
          throw new ToolError(
            "REQUEST_REUSED",
            "Request already committed with different parameters.",
          );
        const idea = existing.eventId ? board.ideas.find((i) => i.eventId === existing.eventId) : undefined;
        const managed = action === "idea_update" || action === "idea_remove" ? (input as IdeaUpdateInput).id : undefined;
        return {
          value: { receipt: existing, replayed: true, ideaId: existing.ideaId ?? managed ?? idea?.id, artifactId: existing.artifactId, reminders: reminders(board) },
          changed: false,
        };
      }
      if (questionKind) refuseUnattended(board, identity);
      const age = this.clock() - Date.parse(signed.issuedAt);
      if (age > 15 * 60 * 1000 || age < -30000)
        throw new ToolError(
          "REQUEST_EXPIRED",
          "Request is expired. Re-read the task before a new update.",
        );
      const task = board.tasks.find((t) => t.id === identity.taskId),
        project = board.projects.find((p) => p.id === task?.projectId);
      if (!task || !project || task.workspaceId !== identity.workspaceId)
        throw new ToolError("SESSION_MISMATCH", "Card binding changed.");
      if (task.archivedAt || project.archivedAt)
        throw new ToolError("ARCHIVED", "Task or project is archived.");
      if (["done", "cancelled"].includes(task.status))
        throw new ToolError(
          "TASK_FINISHED",
          "Only a human can reopen or change a finished task.",
        );
      if (
        task.revision !== input.expectedRevision.task ||
        project.revision !== input.expectedRevision.project
      )
        throw new ToolError(
          "REVISION_CONFLICT",
          `Card/project changed (current task=${task.revision}, project=${project.revision}). Re-read before deciding whether to retry.`,
        );
      if (
        !resources.context.workspaceRepoPaths.some((p) =>
          project.repos.includes(p),
        )
      )
        throw new ToolError(
          "WORKSPACE_INCOMPATIBLE",
          "Project repositories changed; re-read context.",
        );
      board.agentReceipts = board.agentReceipts.filter(
        (r) => Date.parse(r.expiresAt) > this.clock(),
      );
      if (board.agentReceipts.length >= 5000)
        throw new ToolError(
          "RECEIPTS_FULL",
          "Agent receipt capacity is full; no unexpired receipt was removed. Try after expiry or use the human board UI.",
          true,
        );
      if (ideaWrite && !ideasOn)
        throw new ToolError("IDEAS_DISABLED", "Ideas are turned off in Flowly settings. Mention follow-up suggestions in your reply instead.");
      if (action === "idea") checkIdea(board, task.id, (input as IdeaInput).title);
      if (artifactWrite && !artifactsOn)
        throw new ToolError(
          "ARTIFACTS_DISABLED",
          "Agent artifacts are turned off in Flowly settings. List your deliverables in your reply instead.",
        );
      const previous = task.status,
        next = action === "status" ? resolveAgentStatus((input as StatusInput).status, previous) : previous;
      if (next !== previous && !laneEnabled(project, next))
        throw new ToolError(
          "STATUS_UNAVAILABLE",
          `${laneName(project, next)} is not a lane in this project. Use one of allowedStatuses from get_task.`,
        );
      // Next moves that ride on a status or report (NEXT-MOVES-SPEC §8.2): a Done move is only offered with a delivery.
      const carried = action === "status" || action === "progress" ? (input as StatusInput | ProgressInput).nextMoves : undefined;
      if (carried?.some((m) => m.moveTo === "done") && next !== "in_review")
        throw new ToolError(
          "INVALID_INPUT",
          "A moveTo=\"done\" move is only offered together with a delivery to In review (status in_review). Leave it out, or deliver first.",
        );
      // Soft delivery gate (WORKPAD-SPEC §5.3): open items need an explicit acknowledgement.
      // Off for the project (WORKPAD-SPEC §9): no gate, and the stored workpad stays as it is.
      const deliveryPad =
        next === "in_review" && next !== previous && workpadEnabled(project) ? board.workpads.find((w) => w.taskId === task.id) : undefined;
      if (deliveryPad && head !== undefined) deliveryPad.head = head;
      const delivered = deliveryPad ? openItems(deliveryPad) : undefined;
      // Missing card setup is part of the same soft gate (CARD-SETUP-SPEC §3.4): one refusal lists everything.
      const setupGap: SetupItem[] =
        next === "in_review" && next !== previous ? setupMissing(task, workpadOf(board.workpads, task.id), workpadEnabled(project)) : [];
      const binding = `${identity.agentId}:${identity.taskId}:${identity.workspaceId}`;
      const hasOpen = !!delivered?.total || setupGap.length > 0 || handoffGap.length > 0;
      const fingerprint = digest(JSON.stringify({
        revision: input.expectedRevision,
        pad: deliveryPad?.revision,
        open: delivered,
        setupGap,
        handoff: handoffGap.length ? { requirements: continuity?.requirementsFingerprint, unavailable: continuity?.unavailable } : undefined,
        head: head ? { sha: head.sha, branch: head.branch, dirty: head.dirty } : null,
      }));
      const acknowledged = hasOpen && this.deliveryGate.acknowledge(binding, fingerprint, !!(input as StatusInput | ProgressInput).acknowledgeOpen, this.clock());
      if (deliveryPad && delivered!.total > 0 && !acknowledged)
        throw new ToolError(
          "WORKPAD_OPEN",
          `${handoffGap.length ? `HANDOFF_STALE: ${handoffGap.join(" ")} Update the handoff with flowly_update_handoff, then retry with acknowledgeOpen=true.\n` : ""}${setupGap.length ? `${setupIncompleteMessage(setupGap)}\n` : ""}${delivered!.total} workpad item${delivered!.total === 1 ? " is" : "s are"} still open:\n${openItemLines(deliveryPad).join("\n")}\nThe first attempt is always refused, even with acknowledgeOpen=true. Review this list, rerun out-of-date checks and finish what you can. Then retry with acknowledgeOpen=true and a note explaining every remaining item. A changed card/workpad/HEAD or a new turn requires a new refusal.`,
        );
      if (setupGap.length && !acknowledged) throw new ToolError("SETUP_INCOMPLETE", `${setupIncompleteMessage(setupGap)}${handoffGap.length ? `\nHANDOFF_STALE: ${handoffGap.join(" ")} Update the handoff with flowly_update_handoff, then retry with acknowledgeOpen=true.` : ""}`);
      if (handoffGap.length && !acknowledged) throw new ToolError("HANDOFF_STALE", `${handoffGap.join(" ")} Update the handoff with flowly_update_handoff, finish what you can, then retry with acknowledgeOpen=true and explain every remaining gap. The first attempt is always refused, even with acknowledgeOpen=true; new requirements or information gaps, changed card/workpad/HEAD, or a new turn require a new refusal. Checkpoint and observation-only updates do not reset an existing acknowledgement.`);
      if (semanticSource && this.handoffs) {
        if (questionKind) await this.handoffs.prepareQuestion(identity, semanticSource, questionKind, (input as StatusInput | ProgressInput).note, board);
        else await this.handoffs.prepareDelivery(identity, semanticSource, (input as StatusInput).note, board);
      }
      if (next !== previous) {
        task.status = next;
        task.revision++;
        task.updatedAt = new Date(this.clock()).toISOString();
      }
      let artifactId: string | undefined;
      let notice: string | undefined;
      const artifactIds: string[] = [];
      for (const output of outputTargets) {
        try {
          const put = putArtifact(this.store, board, {
            taskId: task.id, role: "output", kind: output.kind, target: output.target,
            title: output.title, note: output.note, createdBy: "agent", agentId: identity.agentId,
            ...("external" in output ? { external: output.external } : {}),
          }, new Date(this.clock()).toISOString());
          if (!artifactIds.includes(put.artifact.id)) artifactIds.push(put.artifact.id);
          if (output.notice) notice = [notice, `${output.target}: ${output.notice}`].filter(Boolean).join("\n");
          if (put.notice) notice = [notice, `${output.target}: ${put.notice}`].filter(Boolean).join("\n");
        } catch (e) {
          throw new ToolError("ARTIFACT_INVALID", e instanceof Error ? e.message : String(e));
        }
      }
      const artifactEvent = artifactWrite
        ? (() => {
            try {
              if (action === "artifact") {
                const a = input as ArtifactToolInput;
                const put = putArtifact(
                  this.store,
                  board,
                  {
                    taskId: task.id,
                    role: a.role,
                    kind: artifactTarget!.kind,
                    target: artifactTarget!.target,
                    title: a.title || ("externalTitle" in artifactTarget! ? artifactTarget.externalTitle : undefined),
                    note: a.note,
                    createdBy: "agent",
                    agentId: identity.agentId,
                    ...("external" in artifactTarget! ? { external: artifactTarget.external } : {}),
                  },
                  new Date(this.clock()).toISOString(),
                );
                artifactId = put.artifact.id;
                notice = put.notice;
                return { id: put.eventId ?? "", at: new Date(this.clock()).toISOString() };
              }
              const dropped = dropArtifact(this.store, board, (input as ArtifactRemovalInput).id, {
                createdBy: "agent",
                agentId: identity.agentId,
                taskId: task.id,
              });
              artifactId = dropped.artifact.id;
              return { id: dropped.eventId, at: new Date(this.clock()).toISOString() };
            } catch (e) {
              if (e instanceof ToolError) throw e;
              const text = e instanceof Error ? e.message : String(e);
              throw new ToolError(text.startsWith("Only the user") ? "ARTIFACT_FORBIDDEN" : "ARTIFACT_INVALID", text);
            }
          })()
        : undefined;
      const tagsEvent =
        action === "tags"
          ? (() => {
              const at = new Date(this.clock()).toISOString();
              let change;
              try {
                change = changeTags(task.tags || [], tagEdit!, { actor: "agent", agentId: identity.agentId, at });
              } catch (e) {
                const text = e instanceof Error ? e.message : String(e);
                throw new ToolError(text.startsWith("Only the user") ? "TAG_FORBIDDEN" : "TAG_INVALID", text);
              }
              if (!change.added.length && !change.removed.length) return { id: "", at };
              setTags(task, change.tags);
              return this.store.event(board, {
                taskId: task.id,
                agentId: identity.agentId,
                actor: "agent",
                action: "tags_changed",
                note: tagChangeNote(change),
              });
            })()
          : undefined;
      // An agent only fills in a missing type; any existing type stays (CARD-TYPE-SPEC §2).
      const typeEvent =
        action === "type"
          ? (() => {
              const type = (input as TypeToolInput).type;
              if (task.type === type) return { id: "", at: new Date(this.clock()).toISOString() };
              if (task.type)
                throw new ToolError(
                  "TYPE_ALREADY_SET",
                  `This card already has type ${task.type}; only the user changes an existing type.`,
                );
              task.type = type;
              task.revision++;
              task.updatedAt = new Date(this.clock()).toISOString();
              return this.store.event(board, {
                taskId: task.id,
                agentId: identity.agentId,
                actor: "agent",
                action: "type_set",
                note: type,
              });
            })()
          : undefined;
      const metadataEvent = action === "metadata" ? (() => {
        if (board.automation.some((job) => job.taskId === task.id && reviewsFor(job, identity.agentId)))
          throw new ToolError("REVIEWER_ONLY", "A reviewer reports findings; the implementer organizes this card.");
        const fields = input as MetadataInput;
        if (task.brief && !task.intakeOrganized && fields.description !== undefined && !fields.description.trim())
          throw new ToolError("INVALID_INPUT", "Organize task.brief into a non-empty, faithful description before confirming card setup.");
        const changed = (["title", "description", "priority"] as const).filter((key) => fields[key] !== undefined && fields[key] !== task[key]);
        const organized = !!task.brief && !task.intakeOrganized && fields.title !== undefined && fields.description !== undefined;
        const at = new Date(this.clock()).toISOString();
        if (!changed.length && !organized) return { id: "", at };
        if (fields.title !== undefined) task.title = fields.title;
        if (fields.description !== undefined) task.description = fields.description;
        if (fields.priority !== undefined) task.priority = fields.priority;
        if (organized) task.intakeOrganized = true;
        task.revision++;
        task.updatedAt = at;
        return this.store.event(board, { taskId: task.id, agentId: identity.agentId, actor: "agent", action: "edited", note: `Organized card: ${changed.join(", ") || "confirmed title and description"}` });
      })() : undefined;
      let workpadRevision: number | undefined;
      // Full replacement guarded by the workpad's own revision (WORKPAD-SPEC §2.4, §3).
      const workpadEvent =
        action === "workpad"
          ? (() => {
              const w = input as WorkpadInput;
              if (!workpadEnabled(project))
                throw new ToolError(
                  "WORKPAD_DISABLED",
                  "The workpad is turned off for this project. List acceptance criteria and checks (passed, failed, not run) in your progress and delivery notes instead; do not retry.",
                );
              const current = board.workpads.find((x) => x.taskId === task.id);
              if ((current?.revision ?? 0) !== w.workpadRevision)
                throw new ToolError(
                  "WORKPAD_CONFLICT",
                  `Workpad changed (current revision=${current?.revision ?? 0}), possibly by the user. Re-read get_task, keep their checks, then retry.`,
                );
              const now = new Date(this.clock()).toISOString();
              let merged;
              try {
                merged = mergeWorkpad(current, w, { now, head: head ?? null, resolved: commits! });
              } catch (e) {
                throw new ToolError("WORKPAD_INVALID", e instanceof Error ? e.message : String(e));
              }
              const env = { host: hostname(), path: resources.workspace.workspaceDirectory, head: head ?? null };
              const value: Workpad = {
                ...(current ?? {}),
                taskId: task.id,
                projectId: project.id,
                revision: (current?.revision ?? 0) + 1,
                ...merged,
                env,
                head: head ?? null,
                updatedAt: now,
                updatedBy: "agent",
                agentId: identity.agentId,
              };
              if (current) board.workpads[board.workpads.indexOf(current)] = value;
              else board.workpads.push(value);
              workpadRevision = value.revision;
              return this.store.event(board, {
                taskId: task.id,
                agentId: identity.agentId,
                actor: "agent",
                action: workpadUpdatedAction,
                note: workpadNote(value),
              });
            })()
          : undefined;
      // A session's candidate next messages; the latest of a turn wins (NEXT-MOVES-SPEC §2-3). An empty list is
      // recorded too: the agent's explicit "nothing for the user this turn" (§8.3).
      const recordMoves = (moves: readonly NextMove[]) =>
        this.store.event(board, {
          taskId: task.id,
          agentId: identity.agentId,
          actor: "agent",
          action: nextMovesAction,
          note: moves.length ? moves.map((m) => m.label).join(" · ") : noMovesNote,
          moves: [...moves],
        });
      const movesEvent = action === "next_moves" ? recordMoves((input as NextMovesInput).moves) : undefined;
      // Managing an idea of this card (IDEAS-SPEC §3.1).
      const ideaEvent =
        action === "idea_update" || action === "idea_remove"
          ? manageIdea(board, task.id, action, input as IdeaUpdateInput | IdeaRemovalInput, tagEdit?.add, new Date(this.clock()).toISOString(), (e) =>
              this.store.event(board, { taskId: task.id, agentId: identity.agentId, actor: "agent", ...e }),
            )
          : undefined;
      const event =
        ideaEvent ??
        artifactEvent ??
        tagsEvent ??
        typeEvent ??
        metadataEvent ??
        movesEvent ??
        workpadEvent ??
        (action === "idea" || action === "remember"
          ? this.store.event(board, {
              taskId: task.id,
              agentId: identity.agentId,
              actor: "agent",
              action: action === "idea" ? "idea_proposed" : "memory_proposed",
              note: (input as IdeaInput | RememberInput).title,
            })
          : this.store.event(board, {
              taskId: task.id,
              agentId: identity.agentId,
              actor: "agent",
              action: next !== previous ? "status_changed" : "progress_reported",
              note: (input as StatusInput | ProgressInput).note,
              reportKind:
                action === "progress" ? (input as ProgressInput).kind : next === "blocked" ? "blocker" : "progress",
              ...(action === "status" ? { from: previous, to: next } : {}),
              ...(deliveryPad ? { workpad: { ...delivered!, revision: deliveryPad.revision } } : {}),
              ...(setupGap.length ? { setup: { missing: setupGap } } : {}),
            }));
      if (deliveryPad) deliveryPad.delivery = { ...delivered!, revision: deliveryPad.revision, eventId: event.id, at: event.at };
      // The suggestion follows the status change or report it rode on, in the same write (NEXT-MOVES-SPEC §8.3).
      if (carried) recordMoves(carried);
      let ideaId = action === "idea_update" || action === "idea_remove" ? (input as IdeaUpdateInput).id : undefined;
      if (action === "idea") {
        const idea = input as IdeaInput;
        ideaId = randomUUID();
        board.ideas.push({
          id: ideaId,
          taskId: task.id,
          projectId: project.id,
          agentId: identity.agentId,
          eventId: event.id,
          title: idea.title,
          detail: idea.detail,
          rationale: idea.rationale,
          context: idea.context,
          ...(idea.type ? { type: idea.type } : {}),
          ...(idea.priority ? { priority: idea.priority } : {}),
          ...(tagEdit?.add.length ? { tags: tagEdit.add } : {}),
          scope: idea.scope,
          status: "open",
          createdAt: event.at,
          updatedAt: event.at,
        });
        pruneIdeas(board, task.id);
      }
      const receipt: Receipt = {
        key,
        agentId: identity.agentId,
        taskId: task.id,
        payloadHash,
        action,
        eventId: event.id,
        ...(ideaId ? { ideaId } : {}),
        ...(artifactId ? { artifactId } : {}),
        ...(outputs !== undefined ? { artifactIds } : {}),
        ...(notice ? { notice } : {}),
        ...(workpadRevision ? { workpadRevision } : {}),
        taskRevision: task.revision,
        projectRevision: project.revision,
        status: task.status,
        at: event.at,
        expiresAt: new Date(this.clock() + 7 * 86400000).toISOString(),
      };
      board.agentReceipts.push(receipt);
      return { value: { receipt, replayed: false, ideaId, artifactId, reminders: reminders(board) }, changed: true };
    });
    if (semanticSource) await this.handoffs?.confirmSource(identity.taskId, semanticSource);
    if (handoffBoundary && !result.replayed) this.deliveryGate.clear(`${identity.agentId}:${identity.taskId}:${identity.workspaceId}`);
    const {
      key: _key,
      payloadHash: _hash,
      expiresAt: _expires,
      notice,
      ...receipt
    } = result.receipt;
    // The candidate is stored after the card write, keyed by its event: a replay stores it if the first write was lost.
    let memoryId: string | undefined;
    if (memoryInput && this.memory) {
      const { kind, title, body, tags, keywords, supersedes } = memoryInput;
      const entry = await this.memory
        .propose({ projectId: resources.project.id, taskId: resources.task.id, agentId: identity.agentId, eventId: result.receipt.eventId, by: "agent", kind, title, body, tags, keywords, ...(supersedes ? { supersedes } : {}) })
        .catch((e) => {
          throw memoryToolError(e);
        });
      memoryId = entry.id;
    }
    const memoryField = memoryId ? { memoryId } : {};
    try {
      const current = await this.get(identity, true, false, { handoffs: false });
      this.accesses.set(identity.agentId, {
        at: new Date(this.clock()).toISOString(),
        action,
      });
      return { receipt, replayed: result.replayed, ...remindersField(result.reminders), ...ideaField(result.ideaId), ...memoryField, ...(result.artifactId ? { artifactId: result.artifactId } : {}), ...(notice ? { notice } : {}), current };
    } catch (e) {
      return {
        receipt,
        replayed: result.replayed,
        ...remindersField(result.reminders),
        ...ideaField(result.ideaId), ...memoryField, ...(result.artifactId ? { artifactId: result.artifactId } : {}),
        ...(notice ? { notice } : {}),
        current: null,
        contextError: e instanceof Error ? e.message : "Re-read the task.",
      };
    }
  }
}

/** get_task's workpad and plans (WORKPAD-SPEC §4.1). */
function workpadContext(workpads: readonly Workpad[], plans: Board["plans"], taskId: string, agentId: string) {
  const w = workpadOf(workpads, taskId);
  const own = plansOf(plans, taskId).map((p) => ({ agentId: p.agentId, own: p.agentId === agentId, items: p.items, at: p.at }));
  return {
    workpad: w
      ? {
          revision: w.revision,
          acceptance: w.acceptance,
          validation: w.validation.map((v) => ({ ...v, fresh: validationFreshness(v, w.head) })),
          confusions: w.confusions,
          env: w.env,
          head: w.head,
          open: openItems(w),
        }
      : null,
    plan: [...own.filter((p) => p.own), ...own.filter((p) => !p.own)],
  };
}

/** Maps the retired in_progress alias onto a work stage (WORKFLOW-STAGES-SPEC §4). */
export function resolveAgentStatus(requested: StatusInput["status"], current: Status): Status {
  if (requested !== legacyStatus) return requested;
  return isWorkStatus(current) ? current : "development";
}

/** Normalized add/remove lists of a tags call, or an idea's suggested tags as `add`. */
function normalizeToolTags(action: "tags" | "idea", input: TagsToolInput | IdeaInput) {
  try {
    if (action === "idea") return { add: normalizeTags((input as IdeaInput).tags || []), remove: [] };
    const t = input as TagsToolInput;
    const edit = { add: normalizeTags(t.add), remove: normalizeTags(t.remove) };
    if (!edit.add.length && !edit.remove.length) throw new Error("Add or remove at least one tag.");
    return edit;
  } catch (e) {
    throw new ToolError("TAG_INVALID", e instanceof Error ? e.message : String(e));
  }
}

const ideaField = (ideaId: string | undefined) => (ideaId ? { ideaId } : {});
/** `reminders` only when there are some, so other calls' results stay as they were (NEXT-MOVES-SPEC §9.5). */
const remindersField = (reminders: string[] | undefined) => (reminders?.length ? { reminders } : {});

/** Rejects a duplicate open title or an eleventh open idea on the card (IDEAS-SPEC §3). */
export function checkIdea(board: Board, taskId: string, title: string) {
  const open = board.ideas.filter((i) => i.taskId === taskId && i.status === "open");
  const duplicate = open.find((i) => ideaTitleKey(i.title) === ideaTitleKey(title));
  if (duplicate)
    throw new ToolError("IDEA_DUPLICATE", `This card already has an open idea with that title (${duplicate.id}).`);
  if (open.length >= ideaLimits.openPerTask)
    throw new ToolError(
      "IDEA_LIMIT",
      `This card already has ${ideaLimits.openPerTask} open ideas. Stop proposing until the user accepts or dismisses some.`,
    );
}

const ideaFields = ["title", "detail", "rationale", "context", "type", "priority", "scope"] as const;

/**
 * An agent edits, dismisses or removes an idea of its own card (IDEAS-SPEC §3.1). Accepted ideas are final;
 * a dismissed one can only be removed (only the user restores it). Returns the event, or an empty one when
 * nothing changed.
 */
export function manageIdea(
  board: Board,
  taskId: string,
  action: "idea_update" | "idea_remove",
  input: IdeaUpdateInput | IdeaRemovalInput,
  tags: string[] | undefined,
  at: string,
  record: (e: { action: string; note: string }) => { id: string; at: string },
) {
  const idea = board.ideas.find((i) => i.id === input.id && i.taskId === taskId);
  if (!idea) throw new ToolError("IDEA_NOT_FOUND", `No idea ${input.id} on this card. Use an id from get_task ideas.`);
  if (idea.status === "accepted")
    throw new ToolError("IDEA_CLOSED", "This idea was already accepted by the user; it can no longer be changed or removed.");
  if (action === "idea_remove") {
    board.ideas = board.ideas.filter((i) => i !== idea);
    return record({ action: "idea_removed", note: idea.title });
  }
  const edit = input as IdeaUpdateInput;
  const changes: Partial<Idea> = {};
  for (const k of ideaFields) if (edit[k] !== undefined && edit[k] !== idea[k]) Object.assign(changes, { [k]: edit[k] });
  if (tags && JSON.stringify(tags) !== JSON.stringify(idea.tags ?? [])) changes.tags = tags;
  const dismiss = edit.status === "dismissed" && idea.status !== "dismissed";
  if (!Object.keys(changes).length && !dismiss) {
    if (edit.status === undefined && !ideaFields.some((k) => edit[k] !== undefined) && !edit.tags)
      throw new ToolError("INVALID_INPUT", "Give at least one field to change, or status=dismissed.");
    return { id: "", at };
  }
  if (Object.keys(changes).length && idea.status !== "open")
    throw new ToolError("IDEA_CLOSED", "Only open ideas can be edited. The user can restore a dismissed idea.");
  if (changes.title && board.ideas.some((i) => i !== idea && i.taskId === taskId && i.status === "open" && ideaTitleKey(i.title) === ideaTitleKey(changes.title!)))
    throw new ToolError("IDEA_DUPLICATE", "This card already has another open idea with that title.");
  Object.assign(idea, changes);
  if (changes.tags && !changes.tags.length) delete idea.tags;
  if (dismiss) idea.status = "dismissed";
  idea.updatedAt = at;
  const edited = Object.keys(changes).length ? record({ action: "idea_edited", note: idea.title }) : undefined;
  return dismiss ? record({ action: "idea_dismissed", note: idea.title }) : edited!;
}

/** Keeps at most `keptPerTask` ideas per card, dropping the oldest closed ones first. */
export function pruneIdeas(board: Board, taskId: string) {
  const own = board.ideas.filter((i) => i.taskId === taskId);
  const excess = own.length - ideaLimits.keptPerTask;
  if (excess <= 0) return;
  const drop = new Set<Idea>(own.filter((i) => i.status !== "open").slice(0, excess));
  board.ideas = board.ideas.filter((i) => !drop.has(i));
}

/** "GitLab", for agent-facing messages. */
const serviceName = (provider: Parameters<typeof familyOf>[0]) => ({ jira: "Jira", confluence: "Confluence", github: "GitHub", gitlab: "GitLab", azure: "Azure DevOps" })[familyOf(provider)];
