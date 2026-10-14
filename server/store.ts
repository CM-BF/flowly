import { mkdir, readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  boardSchema,
  legacyBoardSchema,
  previousBoardSchema,
  storageSchema,
  emptyBoard,
  type Board,
  type BoardEvent,
  type Task,
  type TaskEdit,
  type TaskPlacement,
} from "../shared/model";

export class StoreInvalidError extends Error {}

const columnOrder = (a: Task, b: Task) =>
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
  constructor(readonly directory: string) {}
  get path() {
    return join(this.directory, "board.json");
  }
  private async load(): Promise<Board> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      const board =
        raw.version === 1
          ? (() => {
              const old = legacyBoardSchema.parse(raw);
              return storageSchema.parse({
                ...old,
                version: 3,
                agentReceipts: [],
                tasks: old.tasks.map((t) => ({ ...t, repoPaths: [] })),
              });
            })()
          : raw.version === 2
            ? storageSchema.parse({
                ...previousBoardSchema.parse(raw),
                version: 3,
                agentReceipts: [],
              })
            : storageSchema.parse(raw);
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
      const board = await this.load();
      const result = await operation(board);
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
      if (input.title !== undefined) task.title = input.title;
      if (input.description !== undefined) task.description = input.description;
      if (input.priority !== undefined) task.priority = input.priority;
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
  event(board: Board, input: Omit<BoardEvent, "id" | "at">) {
    const event = {
      ...input,
      id: randomUUID(),
      at: new Date().toISOString(),
    };
    board.events.push(event);
    const relevant = board.events.filter((e) => e.taskId === input.taskId);
    if (relevant.length > 100) {
      const remove = new Set(relevant.slice(0, -100).map((e) => e.id));
      board.events = board.events.filter((e) => !remove.has(e.id));
    }
    return event;
  }
}
