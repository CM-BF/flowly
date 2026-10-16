import { laneName, laneProblem } from "../shared/lanes";
import { mkdir, readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { upgradeBoard } from "./migrate";
import { ideaTitleKey } from "../shared/ideas";
import type { FlowLog } from "./flow-log";
import {
  boardSchema,
  storageSchema,
  emptyBoard,
  type Board,
  type BoardEvent,
  type Task,
  type TaskEdit,
  type TaskPlacement,
  type ProjectEdit,
  type ProjectRemoval,
  type TaskDeletion,
  type IdeaEdit,
  ideaLimits,
  projectOrder,
} from "../shared/model";

export class StoreInvalidError extends Error {}

export const columnOrder = (a: Task, b: Task) =>
  a.position - b.position || a.createdAt.localeCompare(b.createdAt);

/** Position strictly between the neighbors at `index`, or null when equal neighbors leave no room. */
export function slotPosition(
  peers: readonly { position: number }[],
  index: number,
): number | null {
  const previous = peers[index - 1],
    next = peers[index];
  if (!previous) return next ? next.position - 1 : 0;
  if (!next) return previous.position + 1;
  const middle = (previous.position + next.position) / 2;
  return previous.position < middle && middle < next.position ? middle : null;
}

export class BoardStore {
  private tail: Promise<unknown> = Promise.resolve();
  /** Events created by the running transaction; appended to the flow log once it commits. */
  private pending: BoardEvent[] = [];
  /** Untrimmed event log for insights (PROJECT-INSIGHTS-SPEC §2). */
  flow: FlowLog | null = null;
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "board.json");
  }
  private async load(): Promise<Board> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      if (raw?.version !== 4) await this.keepPreV4Copy();
      const board = upgradeBoard(raw);
      this.assertInvariants(board);
      return board;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyBoard();
      throw new StoreInvalidError(
        `Board data is invalid; preserved at ${this.path}. Restore a valid backup before continuing. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  /** One-time copy of pre-v4 data before the status split is first persisted (WORKFLOW-STAGES-SPEC). */
  private async keepPreV4Copy() {
    try {
      await copyFile(this.path, join(this.directory, "board.pre-v4.json"), constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  async read() {
    await this.tail;
    return this.load();
  }
  async view() {
    return boardSchema.parse(await this.read());
  }
  mutate<T>(operation: (board: Board) => Promise<T> | T): Promise<T> {
    return this.transaction(async (board) => ({
      value: await operation(board),
      changed: true,
    }));
  }
  transaction<T>(
    operation: (
      board: Board,
    ) =>
      | Promise<{ value: T; changed: boolean }>
      | { value: T; changed: boolean },
  ): Promise<T> {
    const job = this.tail.then(async () => {
      this.pending = [];
      const board = await this.load();
      const result = await operation(board);
      const events = this.pending;
      this.pending = [];
      if (!result.changed) return result.value;
      board.revision++;
      this.assertInvariants(board);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify(storageSchema.parse(board), null, 2),
        { mode: 0o600 },
      );
      try {
        await copyFile(this.path, `${this.path}.bak`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await rename(temporary, this.path);
      if (this.flow && events.length)
        void this.flow.append(events, board).catch((e) =>
          console.error("Kanban flow log append failed:", e instanceof Error ? e.message : String(e)),
        );
      return result.value;
    });
    this.tail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }
  private assertInvariants(board: Board) {
    if (
      new Set(board.agentReceipts.map((r) => r.key)).size !==
      board.agentReceipts.length
    )
      throw new Error("Duplicate agent receipt.");
    const nativeIds = new Set<string>(),
      workspaces = new Set<string>(),
      operations = new Set<string>();
    for (const p of board.projects) {
      if (nativeIds.has(p.paseoProjectId))
        throw new Error("Paseo project is already linked to a board project.");
      if (!p.repos.includes(p.primaryPath))
        throw new Error("The primary directory must remain in the project.");
      nativeIds.add(p.paseoProjectId);
    }
    for (const t of board.tasks) {
      const project = board.projects.find((p) => p.id === t.projectId);
      if (
        !project ||
        !project.repos.includes(t.sourcePath) ||
        t.repoPaths.some((p) => !project.repos.includes(p)) ||
        new Set(t.repoPaths).size !== t.repoPaths.length
      )
        throw new Error("Task source directory must belong to its project.");
      if (workspaces.has(t.workspaceId))
        throw new Error("Workspace is already bound to another card.");
      if (operations.has(t.operationId))
        throw new Error("Duplicate task operation.");
      workspaces.add(t.workspaceId);
      operations.add(t.operationId);
    }
  }
  async editTask(input: TaskEdit): Promise<Task> {
    return this.mutate((board) => {
      const task = board.tasks.find((t) => t.id === input.id);
      if (!task) throw new Error("Task not found.");
      if (task.revision !== input.revision)
        throw new Error(
          "Revision conflict: this card changed. Reload before saving your draft.",
        );
      const previous = task.status;
      if (input.status !== undefined && input.status !== task.status) {
        const laneError = laneProblem(board.projects.find((p) => p.id === task.projectId), input.status);
        if (laneError) throw new Error(laneError);
      }
      if (input.title !== undefined) task.title = input.title;
      if (input.description !== undefined) task.description = input.description;
      if (input.priority !== undefined) task.priority = input.priority;
      if (input.type === null) delete task.type;
      else if (input.type !== undefined) task.type = input.type;
      if (input.status !== undefined) task.status = input.status;
      if (input.archived !== undefined)
        task.archivedAt = input.archived ? new Date().toISOString() : null;
      task.revision++;
      task.updatedAt = new Date().toISOString();
      this.event(board, {
        taskId: task.id,
        actor: input.actor,
        agentId: input.agentId,
        action:
          previous !== task.status
            ? "status_changed"
            : input.archived !== undefined
              ? "archive_changed"
              : "edited",
        from: previous !== task.status ? previous : undefined,
        to: previous !== task.status ? task.status : undefined,
        note: input.note,
      });
      return task;
    });
  }
  placeTask(input: TaskPlacement): Promise<Task> {
    return this.transaction((board) => {
      const task = board.tasks.find((t) => t.id === input.id);
      if (!task) throw new Error("Task not found.");
      if (task.revision !== input.revision)
        throw new Error(
          "Revision conflict: this card changed. Reload before moving.",
        );
      const project = board.projects.find((p) => p.id === task.projectId);
      if (task.archivedAt || !project || project.archivedAt)
        throw new Error("Archived cards cannot be moved.");
      if (input.status !== task.status) {
        const laneError = laneProblem(project, input.status);
        if (laneError) throw new Error(laneError);
      }
      const column = board.tasks
        .filter((t) => t.projectId === task.projectId && t.status === input.status)
        .sort(columnOrder);
      const peers = column.filter((t) => t !== task);
      const anchorId = input.beforeId ?? input.afterId;
      let index = peers.length;
      if (anchorId) {
        const anchor = peers.findIndex((t) => t.id === anchorId);
        if (anchor < 0)
          throw new Error("Drop position changed. Reload and try again.");
        index = input.beforeId ? anchor : anchor + 1;
      }
      if (task.status === input.status && column.indexOf(task) === index)
        return { value: task, changed: false };
      let position = slotPosition(peers, index);
      if (position === null) {
        peers.forEach((t, i) => {
          t.position = i;
        });
        position = slotPosition(peers, index)!;
      }
      const previous = task.status;
      task.status = input.status;
      task.position = position;
      task.revision++;
      task.updatedAt = new Date().toISOString();
      if (previous !== task.status)
        this.event(board, {
          taskId: task.id,
          actor: "human",
          action: "status_changed",
          from: previous,
          to: task.status,
        });
      return { value: task, changed: true };
    });
  }
  /**
   * Reorders projects for the chooser. Order is presentation, not project
   * data: no revision bump, so agent writes holding a project revision are
   * unaffected. All projects are renumbered 0..n in the resulting order.
   */
  /**
   * Project settings. A lane can only be turned off once it holds no live
   * cards, so no card is ever left outside the project's workflow.
   */
  updateProject(input: ProjectEdit) {
    return this.mutate((board) => {
      const p = board.projects.find((p) => p.id === input.id);
      if (!p) throw new Error("Project not found.");
      if (p.revision !== input.revision)
        throw new Error("Revision conflict: reload the project before saving.");
      if (input.lanes) {
        const blocked = input.lanes
          .filter((l) => !l.enabled)
          .map((l) => ({
            lane: l,
            count: board.tasks.filter((t) => t.projectId === p.id && !t.archivedAt && t.status === l.status).length,
          }))
          .filter((x) => x.count);
        if (blocked.length)
          throw new Error(
            `Move the cards out of ${blocked
              .map((x) => `${laneName(p, x.lane.status)} (${x.count})`)
              .join(", ")} before turning ${blocked.length === 1 ? "it" : "them"} off.`,
          );
        p.lanes = input.lanes.map((l) => ({ status: l.status, enabled: l.enabled, ...(l.name?.trim() ? { name: l.name.trim() } : {}) }));
      }
      if (input.title !== undefined) p.title = input.title;
      if (input.description !== undefined) p.description = input.description;
      if (input.autoStatus !== undefined) p.autoStatus = input.autoStatus;
      if (input.archived !== undefined)
        p.archivedAt = input.archived ? new Date().toISOString() : null;
      p.revision++;
      p.updatedAt = new Date().toISOString();
      return p;
    });
  }
  /**
   * Drops a project and its cards (with their events and agent receipts) from
   * the board. Paseo resources are untouched. The removed records are first
   * written to `removed/<project>-<time>.json` so a mistaken removal can be recovered.
   */
  removeProject(input: ProjectRemoval) {
    return this.mutate(async (board) => {
      const project = board.projects.find((p) => p.id === input.id);
      if (!project) throw new Error("Project not found.");
      if (project.revision !== input.revision)
        throw new Error("Revision conflict: reload the project before removing it.");
      const taskIds = new Set(board.tasks.filter((t) => t.projectId === project.id).map((t) => t.id));
      const removed = {
        removedAt: new Date().toISOString(),
        project,
        tasks: board.tasks.filter((t) => taskIds.has(t.id)),
        events: board.events.filter((e) => taskIds.has(e.taskId)),
        agentReceipts: board.agentReceipts.filter((r) => taskIds.has(r.taskId)),
        ideas: board.ideas.filter((i) => taskIds.has(i.taskId)),
      };
      const folder = join(this.directory, "removed");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const backup = join(folder, `${project.id}-${removed.removedAt.replace(/[:.]/g, "-")}.json`);
      await writeFile(backup, JSON.stringify(removed, null, 2), { mode: 0o600, flag: "wx" });
      board.projects = board.projects.filter((p) => p.id !== project.id);
      board.tasks = board.tasks.filter((t) => !taskIds.has(t.id));
      board.events = board.events.filter((e) => !taskIds.has(e.taskId));
      board.agentReceipts = board.agentReceipts.filter((r) => !taskIds.has(r.taskId));
      board.ideas = board.ideas.filter((i) => !taskIds.has(i.taskId));
      return { id: project.id, removedTasks: taskIds.size, backup };
    });
  }
  /**
   * Permanently drops one card with its events and agent receipts.
   * Paseo resources are untouched. The removed records are first written to
   * `removed/task-<id>-<time>.json`.
   */
  deleteTask(input: Pick<TaskDeletion, "id" | "revision">) {
    return this.mutate(async (board) => {
      const task = board.tasks.find((t) => t.id === input.id);
      if (!task) throw new Error("Task not found.");
      if (task.revision !== input.revision)
        throw new Error("Revision conflict: reload the card before deleting it.");
      const removed = {
        removedAt: new Date().toISOString(),
        tasks: [task],
        events: board.events.filter((e) => e.taskId === task.id),
        agentReceipts: board.agentReceipts.filter((r) => r.taskId === task.id),
        ideas: board.ideas.filter((i) => i.taskId === task.id),
      };
      const folder = join(this.directory, "removed");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const backup = join(folder, `task-${task.id}-${removed.removedAt.replace(/[:.]/g, "-")}.json`);
      await writeFile(backup, JSON.stringify(removed, null, 2), { mode: 0o600, flag: "wx" });
      board.tasks = board.tasks.filter((t) => t !== task);
      board.events = board.events.filter((e) => e.taskId !== task.id);
      board.agentReceipts = board.agentReceipts.filter((r) => r.taskId !== task.id);
      board.ideas = board.ideas.filter((i) => i.taskId !== task.id);
      return { id: task.id, backup };
    });
  }
  /** Dismisses or restores an idea; accepted ideas are final (IDEAS-SPEC §7). */
  updateIdea(input: IdeaEdit) {
    return this.transaction((board) => {
      const idea = board.ideas.find((i) => i.id === input.id);
      if (!idea) throw new Error("Idea not found.");
      if (idea.status === "accepted") throw new Error("This idea already became a card.");
      if (idea.status === input.status) return { value: idea, changed: false };
      const task = board.tasks.find((t) => t.id === idea.taskId),
        project = board.projects.find((p) => p.id === idea.projectId);
      if (!task || task.archivedAt || !project || project.archivedAt)
        throw new Error("The card or project is archived.");
      if (input.status === "open") {
        const open = board.ideas.filter((i) => i.taskId === idea.taskId && i.status === "open");
        if (open.some((i) => ideaTitleKey(i.title) === ideaTitleKey(idea.title)))
          throw new Error("This card already has an open idea with that title.");
        if (open.length >= ideaLimits.openPerTask)
          throw new Error(`This card already has ${ideaLimits.openPerTask} open ideas.`);
      }
      idea.status = input.status;
      idea.updatedAt = new Date().toISOString();
      this.event(board, {
        taskId: idea.taskId,
        actor: "human",
        action: input.status === "dismissed" ? "idea_dismissed" : "idea_restored",
        note: idea.title,
      });
      return { value: idea, changed: true };
    });
  }
  moveProject(input: { id: string; direction?: "up" | "down" | "top"; to?: number }) {
    return this.transaction((board) => {
      const ordered = [...board.projects].sort(projectOrder);
      const index = ordered.findIndex((p) => p.id === input.id);
      if (index < 0) throw new Error("Project not found.");
      const target =
        input.to !== undefined
          ? Math.min(ordered.length - 1, input.to)
          : input.direction === "top" ? 0 : input.direction === "up" ? Math.max(0, index - 1) : Math.min(ordered.length - 1, index + 1);
      const changed = target !== index || ordered.some((p, i) => p.position !== i);
      if (!changed) return { value: ordered.map((p) => p.id), changed: false };
      const [moved] = ordered.splice(index, 1);
      ordered.splice(target, 0, moved);
      ordered.forEach((p, i) => (p.position = i));
      return { value: ordered.map((p) => p.id), changed: true };
    });
  }
  event(board: Board, input: Omit<BoardEvent, "id" | "at">) {
    const event = {
      ...input,
      id: randomUUID(),
      at: new Date().toISOString(),
    };
    board.events.push(event);
    this.pending.push(event);
    const relevant = board.events.filter((e) => e.taskId === input.taskId);
    if (relevant.length > 100) {
      const remove = new Set(relevant.slice(0, -100).map((e) => e.id));
      board.events = board.events.filter((e) => !remove.has(e.id));
    }
    return event;
  }
}
