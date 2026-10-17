import { isSummarizer } from "../shared/summary";
import { enabledStatuses, laneEnabled, laneName } from "../shared/lanes";
import type { PaseoApi } from "@getpaseo/client";
import { randomUUID } from "node:crypto";
import { ideaTitleKey } from "../shared/ideas";
import { isResolved, linksOf } from "../shared/links";
import { absoluteTarget, artifactsOf } from "../shared/artifacts";
import { changeTags, normalizeTags, projectTagStats, tagChangeNote } from "../shared/tags";
import { setTags } from "./store";
import { artifactRoots, dropArtifact, missingArtifacts, normalizeTarget, putArtifact } from "./artifacts";
import {
  agentStatuses,
  ideaInputSchema,
  artifactInputSchema,
  artifactRemovalSchema,
  tagsInputSchema,
  typeInputSchema,
  progressInputSchema,
  statusInputSchema,
  type ToolIdentity,
  type ToolContext,
  type ToolResult,
  type StatusInput,
  type ProgressInput,
  type IdeaInput,
  type ArtifactToolInput,
  type ArtifactRemovalInput,
  type TagsToolInput,
  type TypeToolInput,
} from "../shared/tools";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { ToolSecrets, digest } from "./tool-context";
import { ToolError } from "./tool-error";
import { ideaLimits, isWorkStatus, legacyStatus, type Board, type Idea, type Receipt, type Status } from "../shared/model";
import { isLegacyScope } from "../shared/scope";

export class AgentService {
  private paseo?: PaseoApi;
  readonly accesses = new Map<string, { at: string; action: string }>();
  /** The Ideas setting; off refuses new proposals (IDEAS-INBOX-SPEC §10). Set by the plugin entry. */
  ideasOn: () => Promise<boolean> = async () => true;
  /** The Agent artifacts setting; off refuses artifact writes (CARD-ARTIFACTS-SPEC §4.3). */
  artifactsOn: () => Promise<boolean> = async () => true;
  constructor(
    readonly store: BoardStore,
    readonly secrets: ToolSecrets,
    readonly clock = () => Date.now(),
  ) {}
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
    return { paseo, task, project, workspace, context };
  }
  async get(identity: ToolIdentity, recordAccess = true): Promise<ToolContext> {
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
    const value: ToolContext = {
      identity,
      task: r.task,
      project: r.project,
      revision,
      request: this.secrets.request(identity, revision),
      toolVersion: 1,
      writable: r.context.available && !finished,
      reason:
        r.context.reason ||
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
        nativeOwner: r.context.owner,
        status: r.workspace.status,
        repoPaths: r.context.workspaceRepoPaths,
      },
      sessions: { entries: entries.slice(0, 20), partial, unavailableReason },
      ...(await this.store.read().then(async (board) => ({
        activity: board.events.filter((e) => e.taskId === r.task.id).slice(-20),
        projectTags: projectTagStats(board.tasks, r.project.id).map(({ tag, count }) => ({ tag, count })),
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
          }));
        })(),
        links: linksOf(board, r.task.id)
          .filter((v) => v.other)
          .map(({ relation, other }) => ({
            relation,
            taskId: other!.id,
            title: other!.title,
            status: other!.status,
            laneName: laneName(r.project, other!.status),
            archived: !!other!.archivedAt,
            ...(relation === "blocked_by" ? { resolved: isResolved(other) } : {}),
          })),
      }))),
    };
    if (recordAccess)
      this.accesses.set(identity.agentId, {
        at: new Date(this.clock()).toISOString(),
        action: "get",
      });
    return value;
  }
  async write(
    identity: ToolIdentity,
    action: "status" | "progress" | "idea" | "artifact" | "artifact_remove" | "tags" | "type",
    raw: unknown,
  ): Promise<ToolResult> {
    const input: StatusInput | ProgressInput | IdeaInput | ArtifactToolInput | ArtifactRemovalInput | TagsToolInput | TypeToolInput =
      action === "status"
        ? statusInputSchema.parse(raw)
        : action === "idea"
          ? ideaInputSchema.parse(raw)
          : action === "artifact"
            ? artifactInputSchema.parse(raw)
            : action === "artifact_remove"
              ? artifactRemovalSchema.parse(raw)
              : action === "tags"
                ? tagsInputSchema.parse(raw)
                : action === "type"
                  ? typeInputSchema.parse(raw)
                  : progressInputSchema.parse(raw);
    const signed = this.secrets.validateRequest(
      identity,
      input.request,
      input.expectedRevision,
    );
    const resources = await this.resources(identity);
    const ideasOn = action === "idea" ? await this.ideasOn() : true;
    const artifactWrite = action === "artifact" || action === "artifact_remove";
    const artifactsOn = artifactWrite ? await this.artifactsOn() : true;
    // Paths are checked before the write; the transaction only records the result.
    const artifactTarget =
      action === "artifact" && artifactsOn
        ? await normalizeTarget(
            (input as ArtifactToolInput).target,
            artifactRoots(resources.task, resources.project, resources.workspace.workspaceDirectory),
          ).catch((e) => {
            throw new ToolError("ARTIFACT_INVALID", e instanceof Error ? e.message : String(e));
          })
        : undefined;
    // Tags are normalized before the write; one invalid value refuses the whole call (CARD-TAGS-SPEC §4.1).
    const tagEdit = action === "tags" || action === "idea" ? normalizeToolTags(action, input as TagsToolInput | IdeaInput) : undefined;
    const key = `${identity.agentId}:${digest(input.request.id)}`,
      payloadHash = digest(JSON.stringify({ action, input }));
    const result = await this.store.transaction((board) => {
      const existing = board.agentReceipts.find((r) => r.key === key);
      if (existing) {
        if (existing.payloadHash !== payloadHash)
          throw new ToolError(
            "REQUEST_REUSED",
            "Request already committed with different parameters.",
          );
        const idea = existing.eventId ? board.ideas.find((i) => i.eventId === existing.eventId) : undefined;
        return { value: { receipt: existing, replayed: true, ideaId: idea?.id, artifactId: existing.artifactId }, changed: false };
      }
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
      if (action === "idea" && !ideasOn)
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
      if (next !== previous) {
        task.status = next;
        task.revision++;
        task.updatedAt = new Date(this.clock()).toISOString();
      }
      let artifactId: string | undefined;
      const artifactEvent = artifactWrite
        ? (() => {
            try {
              if (action === "artifact") {
                const a = input as ArtifactToolInput;
                const put = putArtifact(
                  this.store,
                  board,
                  { taskId: task.id, role: a.role, ...artifactTarget!, title: a.title, note: a.note, createdBy: "agent", agentId: identity.agentId },
                  new Date(this.clock()).toISOString(),
                );
                artifactId = put.artifact.id;
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
      const event =
        artifactEvent ??
        tagsEvent ??
        typeEvent ??
        (action === "idea"
          ? this.store.event(board, {
              taskId: task.id,
              agentId: identity.agentId,
              actor: "agent",
              action: "idea_proposed",
              note: (input as IdeaInput).title,
            })
          : this.store.event(board, {
              taskId: task.id,
              agentId: identity.agentId,
              actor: "agent",
              action: next !== previous ? "status_changed" : "progress_reported",
              note: (input as StatusInput | ProgressInput).note,
              reportKind:
                action === "progress" ? (input as ProgressInput).kind : "progress",
              ...(next !== previous ? { from: previous, to: next } : {}),
            }));
      let ideaId: string | undefined;
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
        ...(artifactId ? { artifactId } : {}),
        taskRevision: task.revision,
        projectRevision: project.revision,
        status: task.status,
        at: event.at,
        expiresAt: new Date(this.clock() + 7 * 86400000).toISOString(),
      };
      board.agentReceipts.push(receipt);
      return { value: { receipt, replayed: false, ideaId, artifactId }, changed: true };
    });
    const {
      key: _key,
      payloadHash: _hash,
      expiresAt: _expires,
      ...receipt
    } = result.receipt;
    try {
      const current = await this.get(identity);
      this.accesses.set(identity.agentId, {
        at: new Date(this.clock()).toISOString(),
        action,
      });
      return { receipt, replayed: result.replayed, ...ideaField(result.ideaId), ...(result.artifactId ? { artifactId: result.artifactId } : {}), current };
    } catch (e) {
      return {
        receipt,
        replayed: result.replayed,
        ...ideaField(result.ideaId), ...(result.artifactId ? { artifactId: result.artifactId } : {}),
        current: null,
        contextError: e instanceof Error ? e.message : "Re-read the task.",
      };
    }
  }
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

/** Keeps at most `keptPerTask` ideas per card, dropping the oldest closed ones first. */
export function pruneIdeas(board: Board, taskId: string) {
  const own = board.ideas.filter((i) => i.taskId === taskId);
  const excess = own.length - ideaLimits.keptPerTask;
  if (excess <= 0) return;
  const drop = new Set<Idea>(own.filter((i) => i.status !== "open").slice(0, excess));
  board.ideas = board.ideas.filter((i) => !drop.has(i));
}
