import {
  mkdir,
  readFile,
  writeFile,
  rename,
  copyFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import {
  nativeAttentionToken,
  sessionReadStateSchema,
  manualUnreadToken,
  markSessionReadInput,
  markSessionUnreadInput,
  type MarkSessionReadInput,
  type MarkSessionUnreadInput,
  type SessionReadReceipt,
} from "../shared/session-attention";

export class SessionReadStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "session-reads.json");
  }
  private async load() {
    try {
      return sessionReadStateSchema.parse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1 as const, receipts: [] as SessionReadReceipt[] };
      throw new Error(
        `Session read data is invalid; preserved at ${this.path}. Restore a valid backup before continuing.`,
      );
    }
  }
  async read() {
    await this.tail;
    return this.load();
  }
  /** Serialized read-modify-write with backup and atomic replacement. */
  private update<T>(
    operation: (state: { version: 1; receipts: SessionReadReceipt[] }) => Promise<{ value: T; changed: boolean }>,
  ): Promise<T> {
    const job = this.tail.then(async () => {
      const state = await this.load();
      const { value, changed } = await operation(state);
      if (!changed) return value;
      sessionReadStateSchema.parse(state);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), {
          mode: 0o600,
        });
        try {
          await copyFile(this.path, `${this.path}.bak`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      return value;
    });
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  /**
   * Acknowledges the current attention (and clears a manual unread mark).
   * Returns null when there was nothing to record.
   */
  mark(
    input: MarkSessionReadInput,
    validate: () => Promise<{ workspaceId: string; token: string | null }>,
  ): Promise<SessionReadReceipt | null> {
    const parsed = markSessionReadInput.parse(input);
    return this.update(async (state) => {
      const current = await validate();
      const existing = state.receipts.find(
        (r) =>
          r.taskId === parsed.taskId &&
          r.agentId === parsed.agentId &&
          r.workspaceId === current.workspaceId,
      );
      if (!current.token) {
        // Nothing native to acknowledge: only a manual unread mark can be cleared.
        if (existing?.token !== manualUnreadToken) return { value: existing ?? null, changed: false };
        state.receipts = state.receipts.filter((r) => r !== existing);
        return { value: null, changed: true };
      }
      if (parsed.token && current.token !== parsed.token && parsed.token !== manualUnreadToken)
        throw new Error(
          "Session attention changed. Refresh before marking it as read.",
        );
      if (existing?.token === current.token) return { value: existing, changed: false };
      if (!existing && state.receipts.length >= 10000)
        throw new Error(
          "Session read-state capacity reached. Existing records were preserved.",
        );
      const receipt: SessionReadReceipt = {
        taskId: parsed.taskId,
        agentId: parsed.agentId,
        token: current.token,
        workspaceId: current.workspaceId,
        readAt: new Date().toISOString(),
      };
      state.receipts = state.receipts.filter((r) => r !== existing);
      state.receipts.push(receipt);
      return { value: receipt, changed: true };
    });
  }

  /** "Mark as unread": the session stays unread until it is read again. */
  markUnread(
    input: MarkSessionUnreadInput,
    validate: () => Promise<{ workspaceId: string }>,
  ): Promise<SessionReadReceipt> {
    const parsed = markSessionUnreadInput.parse(input);
    return this.update(async (state) => {
      const current = await validate();
      const existing = state.receipts.find(
        (r) => r.taskId === parsed.taskId && r.agentId === parsed.agentId && r.workspaceId === current.workspaceId,
      );
      if (existing?.token === manualUnreadToken) return { value: existing, changed: false };
      if (!existing && state.receipts.length >= 10000)
        throw new Error("Session read-state capacity reached. Existing records were preserved.");
      const mark: SessionReadReceipt = {
        ...parsed,
        workspaceId: current.workspaceId,
        token: manualUnreadToken,
        readAt: new Date().toISOString(),
      };
      state.receipts = state.receipts.filter((r) => r !== existing);
      state.receipts.push(mark);
      return { value: mark, changed: true };
    });
  }
}

export class SessionReadService {
  constructor(
    readonly board: BoardStore,
    readonly reads: SessionReadStore,
  ) {}
  /** The task must be live and the session must belong to its workspace. */
  private async current(input: { taskId: string; agentId: string }, paseo: PaseoApi) {
    const board = await this.board.read();
    const task = board.tasks.find((t) => t.id === input.taskId);
    if (!task) throw new Error("Task not found.");
    const project = board.projects.find((p) => p.id === task.projectId);
    if (!project) throw new Error("Project not found.");
    if (task.archivedAt || project.archivedAt)
      throw new Error("Archived task or project is read-only.");
    const [snapshot, workspace] = await Promise.all([
      paseo.agents.ref(input.agentId).refresh(),
      paseo.workspaces.ref(task.workspaceId).refresh(),
    ]);
    const actor = snapshot?.agent;
    if (!actor || actor.id !== input.agentId)
      throw new Error("Session is unavailable.");
    if (actor.workspaceId !== task.workspaceId)
      throw new Error("Session belongs to a different workspace.");
    if (actor.archivedAt) throw new Error("Archived session is read-only.");
    if (
      !workspace ||
      workspace.id !== task.workspaceId ||
      workspace.archivingAt
    )
      throw new Error("Workspace is unavailable.");
    return {
      workspaceId: task.workspaceId,
      token: nativeAttentionToken(actor),
    };
  }
  mark(input: MarkSessionReadInput, paseo: PaseoApi) {
    return this.reads.mark(input, () => this.current(input, paseo));
  }
  markUnread(input: MarkSessionUnreadInput, paseo: PaseoApi) {
    return this.reads.markUnread(input, () => this.current(input, paseo));
  }
}
