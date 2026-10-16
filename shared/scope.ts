import { enabledStatuses, laneName } from "./lanes";
import { taskTypeLabels, type Task, type Project } from "./model";

export function effectiveRepos(
  task: Pick<Task, "repoPaths">,
  project: Pick<Project, "repos">,
) {
  return task.repoPaths.length ? task.repoPaths : project.repos;
}
export function includesRepo(task: Pick<Task, "repoPaths">, repo: string) {
  return !task.repoPaths.length || task.repoPaths.includes(repo);
}
export function isLegacyScope(
  task: Pick<Task, "repoPaths">,
  project: Pick<Project, "primaryPath" | "repos">,
) {
  return task.repoPaths.length
    ? task.repoPaths.length !== 1 || task.repoPaths[0] !== project.primaryPath
    : project.repos.length > 1;
}
export function sessionContext(
  task: Task,
  project: Project,
  paths: { repo: string; directory: string }[],
  workspaceDirectory: string,
  /** The card's links, one per line (CARD-LINKS-SPEC §4). */
  links: readonly string[] = [],
) {
  return `Kanban task: ${task.title}\nTask ID: ${task.id}\n${task.type ? `Task type: ${taskTypeLabels[task.type]}\n` : ""}${links.map((l) => `${l}\n`).join("")}${task.description}\nProject: ${project.title}\nLanes (this project's workflow): ${enabledStatuses(project).map((s) => `${laneName(project, s)} [${s}]`).join(" → ")}\nNative Paseo project root: ${project.primaryPath}\n${isLegacyScope(task, project) ? "Legacy card scope retained from the previous board version." : "Project-root task scope."}${project.links?.length ? `\nLinked repositories (symlinks in the project root -> real directories; they are part of this task's directories):\n${project.links.map((l) => `${l.name} -> ${l.target}`).join("\n")}` : ""}\nWork directories for this task:\n${paths.map((p) => `${p.repo} -> ${p.directory}`).join("\n")}\nWorkspace starting directory: ${workspaceDirectory}\nWork only in the listed task directories. A common project root can contain multiple child repositories managed by the user. A worktree isolates only the Git project root. Provider permissions still apply; report denied access. Card business status is independent of session status.`;
}
