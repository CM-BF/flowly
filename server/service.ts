import { laneProblem } from "../shared/lanes";
import type { PaseoApi } from "@getpaseo/client";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BoardStore } from "./store";
import type { ProjectInput, TaskInput, Board } from "../shared/model";
import { effectiveRepos, sessionContext } from "../shared/scope";
import { repoMatcher } from "./repos";

const execute = promisify(execFile);
export async function resolveWorktreeBaseRef(
  sourcePath: string,
  requested: string,
): Promise<string> {
  const explicit = requested.trim();
  if (explicit && explicit !== "HEAD") return explicit;
  try {
    const { stdout } = await execute(
      "git",
      ["-C", sourcePath, "symbolic-ref", "--quiet", "HEAD"],
      { timeout: 10000 },
    );
    const branch = stdout.trim();
    if (!branch.startsWith("refs/heads/")) throw new Error("No named branch");
    return branch;
  } catch {
    throw new Error(
      "Cannot determine the selected repository's current named branch. Enter a valid base ref (such as main or origin/main); detached HEAD and non-Git directories have no automatic branch.",
    );
  }
}
export const paseoHome = () =>
  process.env.PASEO_HOME || resolve(homedir(), ".paseo");
/**
 * Branch for a worktree card created without an explicit name. Derived from the
 * operation ID (not Math.random) so a retried create reuses the same branch and
 * idempotency key instead of provisioning a second worktree.
 */
export function generatedBranchName(title: string, operationId: string) {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const suffix = createHash("sha256").update(operationId).digest("hex").slice(0, 6);
  return `kanban/${slug || "task"}-${suffix}`;
}
export const dataDirectory = () =>
  process.env.ULTRA_KANBAN_DATA_DIR ||
  resolve(paseoHome(), "plugin-data/paseo-ultra-kanban");
export async function directory(path: string): Promise<string> {
  const expanded = path.startsWith("~/")
    ? resolve(homedir(), path.slice(2))
    : path;
  const canonical = await realpath(resolve(expanded));
  if (!(await stat(canonical)).isDirectory())
    throw new Error("Expected an existing directory.");
  return canonical;
}

export class BoardService {
  private provision = Promise.resolve<unknown>(undefined);
  constructor(readonly store: BoardStore) {}
  private serialize<T>(action: () => Promise<T>) {
    const result = this.provision.then(action);
    this.provision = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async resources(paseo: PaseoApi) {
    const projects = (await paseo.projects.list()).projects;
    const board = await this.store.read();
    const match = repoMatcher([
      ...new Set(board.projects.flatMap((p) => p.repos)),
    ]);
    const workspaces = [];
    let cursor: string | undefined;
    do {
      const page = await paseo.workspaces.list({
        page: { limit: 200, cursor },
      });
      workspaces.push(...page.entries);
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return {
      projects: projects.map((p) => ({
        id: p.projectId,
        name: p.projectDisplayName,
        path: p.projectRootPath,
      })),
      workspaces: await Promise.all(
        workspaces.map(async (w) => ({
          id: w.id,
          projectId: w.projectId,
          name: w.name || w.id,
          path: w.workspaceDirectory,
          status: w.status,
          repoPaths: await match(w.workspaceDirectory),
          owner:
            projects.find((p) => p.projectId === w.projectId)
              ?.projectDisplayName || w.projectId,
        })),
      ),
    };
  }
  createProject(input: ProjectInput, paseo: PaseoApi) {
    return this.serialize(async () => {
      const primaryPath = await directory(input.primaryPath);
      const findNative = async () => {
        const projects = (await paseo.projects.list()).projects;
        if (input.paseoProjectId)
          return projects.find((p) => p.projectId === input.paseoProjectId);
        const paths = await Promise.all(
          projects.map((p) => directory(p.projectRootPath).catch(() => null)),
        );
        return projects.find((_, i) => paths[i] === primaryPath);
      };
      let native = await findNative();
      if (input.paseoProjectId && !native)
        throw new Error("Paseo project not found.");
      if (!native) {
        await execute(
          "paseo",
          ["project", "create", primaryPath, "--home", paseoHome(), "--json"],
          { timeout: 30000, maxBuffer: 1024 * 1024 },
        );
        native = await findNative();
      }
      if (!native || (await directory(native.projectRootPath)) !== primaryPath)
        throw new Error(
          "Native project root does not match the selected primary directory.",
        );
      const paseoProjectId = native.projectId;
      return this.store.mutate((board) => {
        if (board.projects.some((p) => p.paseoProjectId === paseoProjectId))
          throw new Error(
            "Paseo project is already linked; open or restore its board project.",
          );
        const now = new Date().toISOString();
        const project = {
          id: randomUUID(),
          title: input.title,
          description: input.description,
          paseoProjectId,
          primaryPath,
          repos: [primaryPath],
          revision: 1,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        };
        board.projects.push(project);
        return project;
      });
    });
  }
  createTask(input: TaskInput, paseo: PaseoApi) {
    return this.serialize(async () => {
      const board = await this.store.read();
      const previous = board.tasks.find(
        (t) => t.operationId === input.operationId,
      );
      if (previous) return previous;
      const project = board.projects.find((p) => p.id === input.projectId);
      if (!project || project.archivedAt)
        throw new Error("Project is unavailable or archived.");
      const laneError = laneProblem(project, input.status);
      if (laneError) throw new Error(laneError);
      const repoPaths = [project.primaryPath];
      const sourcePath = project.primaryPath;
      let workspaceId = input.workspaceId;
      if (input.mode === "existing") {
        if (!workspaceId) throw new Error("Select a workspace.");
        const workspace = await paseo.workspaces.ref(workspaceId).refresh();
        const matching = workspace
          ? await repoMatcher([project.primaryPath])(
              workspace.workspaceDirectory,
            )
          : [];
        if (!workspace || !matching.length)
          throw new Error(
            "Workspace is unavailable or outside this project's repositories.",
          );
        if (board.tasks.some((t) => t.workspaceId === workspaceId))
          throw new Error("Workspace is already bound to another card.");
      } else {
        const branchName =
          input.mode === "worktree"
            ? input.branchName?.trim() || generatedBranchName(input.title, input.operationId)
            : undefined;
        const baseRef =
          input.mode === "worktree"
            ? await resolveWorktreeBaseRef(sourcePath, input.baseRef)
            : undefined;
        const intent = createHash("sha256")
          .update(
            JSON.stringify({
              projectId: project.paseoProjectId,
              sourcePath,
              mode: input.mode,
              baseRef,
              branchName,
              title: input.title,
            }),
          )
          .digest("hex")
          .slice(0, 24);
        const created = await paseo.workspaces.create({
          title: input.title,
          idempotencyKey: `ultra-kanban:${input.operationId}:${intent}`,
          source:
            input.mode === "directory"
              ? {
                  kind: "directory",
                  path: sourcePath,
                  projectId: project.paseoProjectId,
                }
              : {
                  kind: "worktree",
                  cwd: sourcePath,
                  projectId: project.paseoProjectId,
                  action: "branch-off",
                  refName: baseRef,
                  branchName,
                },
        });
        workspaceId = created.id;
      }
      const id = workspaceId!;
      try {
        return await this.store.mutate((current) => {
          const duplicate = current.tasks.find(
            (t) => t.operationId === input.operationId,
          );
          if (duplicate) return duplicate;
          const p = current.projects.find((p) => p.id === project.id);
          if (!p || p.archivedAt || p.primaryPath !== sourcePath)
            throw new Error("Project changed during workspace creation.");
          const now = new Date().toISOString();
          const task = {
            id: randomUUID(),
            projectId: project.id,
            workspaceId: id,
            sourcePath,
            repoPaths,
            title: input.title,
            description: input.description,
            status: input.status,
            priority: input.priority,
            position: Math.max(
              -1,
              ...current.tasks
                .filter(
                  (t) => t.projectId === project.id && t.status === input.status,
                )
                .map((t) => t.position),
            ) + 1,
            revision: 1,
            operationId: input.operationId,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          };
          current.tasks.push(task);
          this.store.event(current, {
            taskId: task.id,
            actor: "human",
            action: "created",
          });
          return task;
        });
      } catch (error) {
        throw new Error(
          `Card was not saved. Workspace ${id} remains available; retry with the same operation or link it. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
  async context(id: string, paseo: PaseoApi, snapshot?: Board) {
    const board = snapshot || (await this.store.read());
    const task = board.tasks.find((t) => t.id === id);
    const project = board.projects.find((p) => p.id === task?.projectId);
    if (!task || !project) throw new Error("Task or project not found.");
    const workspace = await paseo.workspaces.ref(task.workspaceId).refresh();
    const matches = workspace
      ? await repoMatcher(project.repos)(workspace.workspaceDirectory)
      : [];
    const available =
      !!workspace &&
      !!matches.length &&
      !task.archivedAt &&
      !project.archivedAt;
    const directories = effectiveRepos(task, project).map((repo) => ({
      repo,
      directory:
        workspace?.workspaceKind === "worktree" && matches.includes(repo)
          ? workspace.workspaceDirectory
          : repo,
    }));
    return {
      available,
      reason:
        task.archivedAt || project.archivedAt
          ? "Task or project is archived."
          : !workspace
            ? "Workspace is unavailable or archived."
            : !matches.length
              ? "Workspace is outside this project's repositories."
              : "",
      context: sessionContext(
        task,
        project,
        directories,
        workspace?.workspaceDirectory || task.sourcePath,
      ),
      directories,
      workspaceRepoPaths: matches,
      owner:
        workspace?.projectDisplayName || workspace?.projectId || "Unavailable",
    };
  }
}
