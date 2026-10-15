import { laneProblem } from "../shared/lanes";
import type { PaseoApi } from "@getpaseo/client";
import { lstat, mkdir, readlink, realpath, rmdir, stat, symlink, unlink } from "node:fs/promises";
import { basename, join, relative, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BoardStore } from "./store";
import type { ProjectInput, TaskInput, Board, LinkedProjectInput, ProjectLinksEdit, Project, ProjectRemoval } from "../shared/model";
import { effectiveRepos, sessionContext } from "../shared/scope";
import { repoMatcher } from "./repos";
import type { z } from "zod";
import type { removeProject as removeProjectRpc } from "../shared/rpc";

const execute = promisify(execFile);
type RemoveResult = z.infer<typeof removeProjectRpc.output>;
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
/** Fixed parent of plugin-created linked multi-repo project roots (PROJECT-PICKER-SPEC). */
export const linkedDirectory = () =>
  process.env.ULTRA_KANBAN_LINKED_DIR || resolve(dataDirectory(), "projects");
/** Folder/link name: letters, digits, `-`, `_`, `.`; never empty, hidden or a path. */
export function folderName(text: string, fallback = "project") {
  const name = text
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 60)
    .replace(/[-.]+$/, "");
  return name || fallback;
}
function uniqueName(base: string, taken: Set<string>) {
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}-${i}`;
  taken.add(name.toLowerCase());
  return name;
}
const inside = (parent: string, child: string) => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
/** Canonical, distinct link targets outside the linked-project parent. */
async function linkTargets(paths: string[]) {
  const parent = await realpath(linkedDirectory()).catch(() => resolve(linkedDirectory()));
  const targets: string[] = [];
  for (const path of paths) {
    const target = await directory(path).catch(() => {
      throw new Error(`Not an existing directory: ${path}`);
    });
    if (inside(parent, target) || inside(target, parent))
      throw new Error(`Cannot link a directory inside or containing the linked projects folder: ${target}`);
    if (targets.includes(target)) throw new Error(`Directory added twice: ${target}`);
    targets.push(target);
  }
  return targets;
}
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
    return this.serialize(() => this.registerProject(input, paseo));
  }
  /**
   * Linked multi-repo project: a new, plugin-owned directory holding one
   * symlink per chosen directory, registered as the native project root.
   */
  createLinked(input: LinkedProjectInput, paseo: PaseoApi) {
    return this.serialize(async () => {
      const targets = await linkTargets(input.links);
      const parent = linkedDirectory();
      await mkdir(parent, { recursive: true });
      const taken = new Set<string>();
      let root = "";
      for (const base = folderName(input.title); ; ) {
        root = join(parent, uniqueName(base, taken));
        // Exclusive create: never reuse or write into an existing directory.
        const created = await mkdir(root).then(() => true, (e: NodeJS.ErrnoException) => {
          if (e.code === "EEXIST") return false;
          throw e;
        });
        if (created) break;
      }
      const names = new Set<string>(),
        links = targets.map((target) => ({ name: uniqueName(folderName(basename(target), "repo"), names), target }));
      let registered = false;
      try {
        for (const link of links) await symlink(link.target, join(root, link.name), "dir");
        return await this.registerProject(
          { title: input.title, description: input.description, primaryPath: root },
          paseo,
          links,
          () => (registered = true),
        );
      } catch (e) {
        if (!registered) {
          for (const link of links) await unlink(join(root, link.name)).catch(() => undefined);
          await rmdir(root).catch(() => undefined);
        }
        throw e;
      }
    });
  }
  /** Adds/removes symlinks of a linked project; only entries the plugin recorded are removed. */
  setLinks(input: ProjectLinksEdit) {
    return this.serialize(async () => {
      const board = await this.store.read();
      const project = board.projects.find((p) => p.id === input.id);
      if (!project) throw new Error("Project not found.");
      if (!project.links) throw new Error("Only linked multi-repo projects have editable repositories.");
      if (project.revision !== input.revision)
        throw new Error("Revision conflict: reload the project before saving.");
      const targets = await linkTargets(input.links);
      const root = project.primaryPath;
      const kept = project.links.filter((l) => targets.includes(l.target)),
        removed = project.links.filter((l) => !targets.includes(l.target));
      for (const link of removed) {
        const path = join(root, link.name);
        const entry = await lstat(path).catch(() => null);
        if (!entry) continue;
        if (!entry.isSymbolicLink() || (await readlink(path)) !== link.target)
          throw new Error(`${path} is no longer the link Kanban created; remove it yourself or restore it.`);
      }
      for (const link of removed) await unlink(join(root, link.name)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
      const taken = new Set(kept.map((l) => l.name.toLowerCase()));
      const added: { name: string; target: string }[] = [];
      for (const target of targets.filter((t) => !kept.some((l) => l.target === t))) {
        let name = uniqueName(folderName(basename(target), "repo"), taken);
        // Skip names a user created inside the root by hand.
        while (await lstat(join(root, name)).then(() => true, () => false))
          name = uniqueName(folderName(basename(target), "repo"), taken);
        await symlink(target, join(root, name), "dir");
        added.push({ name, target });
      }
      const links = targets.map((t) => kept.find((l) => l.target === t) || added.find((l) => l.target === t)!);
      return this.store.mutate((board) => {
        const p = board.projects.find((p) => p.id === input.id);
        if (!p) throw new Error("Project not found.");
        p.links = links;
        p.revision++;
        p.updatedAt = new Date().toISOString();
        return p;
      });
    });
  }
  /** What removing a project touches in Paseo (PROJECT-REMOVE-SPEC). Read-only. */
  async removeCheck(id: string, paseo: PaseoApi) {
    const board = await this.store.read();
    const project = board.projects.find((p) => p.id === id);
    if (!project) throw new Error("Project not found.");
    const native = (await paseo.projects.list()).projects.find((p) => p.projectId === project.paseoProjectId);
    const workspaces = new Set<string>();
    if (native) {
      let cursor: string | undefined;
      do {
        const page = await paseo.workspaces.list({ page: { limit: 200, cursor } });
        for (const w of page.entries) if (w.projectId === project.paseoProjectId) workspaces.add(w.id);
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
    }
    let runningSessions = 0,
      cursor: string | undefined;
    if (workspaces.size)
      do {
        const page = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor } });
        for (const { agent } of page.entries)
          if (!!agent.workspaceId && workspaces.has(agent.workspaceId) && !agent.archivedAt && (agent.status === "running" || agent.status === "initializing"))
            runningSessions++;
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
    return {
      cards: board.tasks.filter((t) => t.projectId === id).length,
      paseoProjectId: project.paseoProjectId,
      paseoExists: !!native,
      workspaces: workspaces.size,
      runningSessions,
    };
  }
  /**
   * Removes the board project; with `alsoPaseo` then removes the native
   * project too (Paseo has no project archive; its removal keeps all files).
   * The board removal comes first so a failed Paseo step never strands cards.
   */
  removeProject(input: ProjectRemoval, paseo: PaseoApi) {
    return this.serialize(async (): Promise<RemoveResult> => {
      let check: Awaited<ReturnType<BoardService["removeCheck"]>> | null = null;
      if (input.alsoPaseo) {
        check = await this.removeCheck(input.id, paseo);
        if (check.runningSessions)
          throw new Error(
            `${check.runningSessions} session${check.runningSessions === 1 ? " is" : "s are"} still running in this Paseo project. Stop ${check.runningSessions === 1 ? "it" : "them"} first, or keep the project in Paseo.`,
          );
      }
      const removed = await this.store.removeProject(input);
      if (!check) return removed;
      if (!check.paseoExists) return { ...removed, paseo: { removed: false, workspaces: 0, error: "" } };
      try {
        const { stdout } = await execute(
          "paseo",
          ["project", "delete", check.paseoProjectId, "--home", paseoHome(), "--json"],
          { timeout: 60000, maxBuffer: 1024 * 1024 },
        );
        const ids = (JSON.parse(stdout) as { removedWorkspaceIds?: string[] }).removedWorkspaceIds ?? [];
        return { ...removed, paseo: { removed: true, workspaces: ids.length, error: "" } };
      } catch (e) {
        const reason = String((e as { stderr?: string }).stderr || (e as Error).message || e).trim().split("\n").pop() || "unknown error";
        return { ...removed, paseo: { removed: false, workspaces: 0, error: reason } };
      }
    });
  }
  private async registerProject(
    input: ProjectInput,
    paseo: PaseoApi,
    links?: Project["links"],
    onRegistered?: () => void,
  ) {
    {
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
        // From here on the directory may be referenced by a native project; keep it on failure.
        onRegistered?.();
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
          ...(links ? { links } : {}),
          revision: 1,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        };
        board.projects.push(project);
        return project;
      });
    }
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
            ...(input.type ? { type: input.type } : {}),
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
            ownsWorkspace: input.mode !== "existing",
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
