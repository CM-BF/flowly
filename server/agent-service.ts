import type { PaseoApi } from "@getpaseo/client";
import {
  agentStatuses,
  progressInputSchema,
  statusInputSchema,
  type ToolIdentity,
  type ToolContext,
  type ToolResult,
  type StatusInput,
  type ProgressInput,
} from "../shared/tools";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { ToolSecrets, digest } from "./tool-context";
import { ToolError } from "./tool-error";
import type { Receipt } from "../shared/model";
import { isLegacyScope } from "../shared/scope";

export class AgentService {
  private paseo?: PaseoApi;
  readonly accesses = new Map<string, { at: string; action: string }>();
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
            .filter((a) => a.workspaceId === identity.workspaceId)
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
      allowedStatuses: [...agentStatuses],
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
      activity: (await this.store.read()).events
        .filter((e) => e.taskId === r.task.id)
        .slice(-20),
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
    action: "status" | "progress",
    raw: unknown,
  ): Promise<ToolResult> {
    const input: StatusInput | ProgressInput =
      action === "status"
        ? statusInputSchema.parse(raw)
        : progressInputSchema.parse(raw);
    const signed = this.secrets.validateRequest(
      identity,
      input.request,
      input.expectedRevision,
    );
    const resources = await this.resources(identity);
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
        return { value: { receipt: existing, replayed: true }, changed: false };
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
      const previous = task.status,
        next = action === "status" ? (input as StatusInput).status : previous;
      if (next !== previous) {
        task.status = next;
        task.revision++;
        task.updatedAt = new Date(this.clock()).toISOString();
      }
      const event = this.store.event(board, {
        taskId: task.id,
        agentId: identity.agentId,
        actor: "agent",
        action: next !== previous ? "status_changed" : "progress_reported",
        note: input.note,
        reportKind:
          action === "progress" ? (input as ProgressInput).kind : "progress",
        ...(next !== previous ? { from: previous, to: next } : {}),
      });
      const receipt: Receipt = {
        key,
        agentId: identity.agentId,
        taskId: task.id,
        payloadHash,
        action,
        eventId: event.id,
        taskRevision: task.revision,
        projectRevision: project.revision,
        status: task.status,
        at: event.at,
        expiresAt: new Date(this.clock() + 7 * 86400000).toISOString(),
      };
      board.agentReceipts.push(receipt);
      return { value: { receipt, replayed: false }, changed: true };
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
      return { receipt, replayed: result.replayed, current };
    } catch (e) {
      return {
        receipt,
        replayed: result.replayed,
        current: null,
        contextError: e instanceof Error ? e.message : "Re-read the task.",
      };
    }
  }
}
