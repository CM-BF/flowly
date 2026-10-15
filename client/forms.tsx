import { enabledStatuses, laneName, projectLanes } from "../shared/lanes";
import { LaneEditor } from "./lane-editor";
import { useBoardView } from "./board-view";
import { useState } from "react";
import { View } from "react-native";
import { Modal } from "./modal";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useBoardQuery, useResourcesQuery } from "./queries";
import * as rpc from "../shared/rpc";
import {
  priorities,
  taskTypes,
  taskTypeLabels,
  type TaskType,
  type Lane,
  type Project,
  type Task,
  type Status,
} from "../shared/model";
import { Theme, useTheme, Button, IconButton, Field, Choices, Notice, Label, Row, Actions, Toggle, message, basename, font, radius, space } from "./ui";
import { priorityLabels } from "./status";
import { isLegacyScope } from "../shared/scope";
import { AgentPicker, useAgentChoice, type AgentDefaults } from "./agent-choice";
import { launchKanbanSession } from "./session";
import { DirectoryChooser } from "./directory-picker";

export function ProjectForm({
  project: initialProject,
  laneCounts = {},
  onClose,
  onSaved,
}: {
  project?: Project;
  /** Live cards per lane, so lanes in use can't be turned off. */
  laneCounts?: Partial<Record<Status, number>>;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const theme = useTheme();
  const [project] = useState(initialProject);
  const create = useRpc(rpc.createProject),
    createLinked = useRpc(rpc.createLinkedProject),
    setLinks = useRpc(rpc.setProjectLinks),
    update = useRpc(rpc.updateProject);
  const resources = useResourcesQuery();
  const [title, setTitle] = useState(project?.title || ""),
    [description, setDescription] = useState(project?.description || ""),
    [primaryPath, setPrimary] = useState(project?.primaryPath || ""),
    [nativeId, setNative] = useState(project?.paseoProjectId || ""),
    [source, setSource] = useState<"directory" | "linked" | "native">("directory"),
    [links, setLinkList] = useState<string[]>(() => project?.links?.map((l) => l.target) ?? []),
    [autoStatus, setAutoStatus] = useState(project?.autoStatus !== false),
    [lanes, setLanes] = useState<Lane[]>(() => projectLanes(project)),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  async function save() {
    setPending(true);
    setError("");
    try {
      if (project) {
        let saved = await update({
          id: project.id,
          revision: project.revision,
          title,
          description,
          ...(autoStatus !== (project.autoStatus !== false) ? { autoStatus } : {}),
          ...(JSON.stringify(lanes) !== JSON.stringify(projectLanes(project)) ? { lanes } : {}),
        });
        if (project.links && JSON.stringify(links) !== JSON.stringify(project.links.map((l) => l.target)))
          saved = await setLinks({ id: project.id, revision: saved.revision, links });
        onSaved(saved.id);
        return;
      }
      const result =
        source === "linked"
          ? await createLinked({ title, description, links })
          : await create({
              title,
              description,
              primaryPath,
              ...(source === "native" && nativeId ? { paseoProjectId: nativeId } : {}),
            });
      onSaved(result.id);
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      open
      title={project ? "Edit project" : "Create project"}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
        <View style={{ gap: 16 }}>
          <Field title="Name" value={title} onChange={setTitle} placeholder="Project name" />
          <Field
            title="Description"
            value={description}
            onChange={setDescription}
            multiline
          />
          {!project && (
            <Choices
              title="Project root"
              value={source}
              options={[
                { value: "directory", label: "Directory" },
                { value: "linked", label: "Multiple repositories" },
                { value: "native", label: "Existing Paseo project" },
              ]}
              onChange={(next) => {
                setSource(next);
                if (next !== "native") setNative("");
              }}
            />
          )}
          {!project && source === "native" && (
            <Choices
              title="Paseo project"
              hideTitle
              value={nativeId}
              options={(resources.data?.projects || []).map((p) => ({
                value: p.id,
                label: p.name,
              }))}
              onChange={(id) => {
                setNative(id);
                const p = resources.data?.projects.find((p) => p.id === id);
                if (p) setPrimary(p.path);
              }}
            />
          )}
          {(project ? !project.links : source !== "linked") && (
            <Field
              title="Paseo project root"
              value={primaryPath}
              onChange={setPrimary}
              editable={!project && source === "directory"}
              placeholder="/absolute/path/to/directory"
            />
          )}
          {!project && source === "directory" && (
            <DirectoryChooser disabled={pending} onPick={(paths) => paths[0] && setPrimary(paths[0])} />
          )}
          {(project ? !!project.links : source === "linked") && (
            <LinkList
              links={links}
              root={project?.primaryPath}
              disabled={pending}
              onChange={setLinkList}
            />
          )}
          {project && <LaneEditor lanes={lanes} counts={laneCounts} disabled={pending} onChange={setLanes} />}
          {project && (
            <Toggle
              title="Auto-update status in this project"
              detail="A Kanban session resuming after review moves the card to Development, after a blocker back to its previous stage. Applies only while Auto-update status is on in Ultra Kanban settings."
              value={autoStatus}
              onChange={setAutoStatus}
            />
          )}
          {!project && source !== "linked" && (
            <Label muted size={font.sm}>
              To work across several repositories, choose Multiple repositories,
              or use a common parent directory as the project root.
            </Label>
          )}
          {resources.error && <Notice>{message(resources.error)}</Notice>}
          {error && <Notice>{error}</Notice>}
          <Actions>
            <Button quiet disabled={pending} onPress={onClose}>
              Cancel
            </Button>
            <Button
              primary
              disabled={
                pending ||
                !title.trim() ||
                ((project ? !!project.links : source === "linked") ? !links.length : !primaryPath.trim()) ||
                (!project && source === "native" && !nativeId)
              }
              onPress={() => void save()}
            >
              {pending ? "Saving…" : project ? "Save project" : "Create project"}
            </Button>
          </Actions>
        </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}

/** Repositories of a linked multi-repo project (PROJECT-PICKER-SPEC §2). */
function LinkList({
  links,
  root,
  disabled,
  onChange,
}: {
  links: string[];
  root?: string;
  disabled: boolean;
  onChange(links: string[]): void;
}) {
  const [typed, setTyped] = useState("");
  const add = (paths: string[]) => {
    const next = [...links];
    for (const p of paths.map((p) => p.trim()).filter(Boolean)) if (!next.includes(p)) next.push(p);
    onChange(next);
  };
  return (
    <View style={{ gap: space[2] }}>
      <Label medium size={font.sm} muted>
        Repositories
      </Label>
      {links.length === 0 && (
        <Label muted size={font.sm}>
          Add the repositories or folders this project works across.
        </Label>
      )}
      {links.map((path) => (
        <View key={path} style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label lines={1}>{basename(path)}</Label>
            <Label muted mono lines={1} size={font.sm}>
              {path}
            </Label>
          </View>
          <IconButton
            icon="X"
            label={`Remove ${basename(path)}`}
            disabled={disabled || links.length <= (root ? 1 : 0)}
            onPress={() => onChange(links.filter((l) => l !== path))}
          />
        </View>
      ))}
      <DirectoryChooser multiple disabled={disabled} onPick={add} />
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2] }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Field title="Or type a path" value={typed} onChange={setTyped} placeholder="/absolute/path/to/repo" />
        </View>
        <Button
          disabled={disabled || !typed.trim()}
          onPress={() => {
            add([typed]);
            setTyped("");
          }}
        >
          Add
        </Button>
      </View>
      <Label muted size={font.sm}>
        {root
          ? `Links live in ${root}. Removing one deletes only the link, never the repository.`
          : "Kanban creates a new folder with a link to each of these and registers it as the Paseo project. Cards use directory workspaces."}
      </Label>
    </View>
  );
}

/** Where a new task starts: the requested lane when enabled, else the first active lane. */
function startStatus(project: Project, requested: Status): Status {
  const lanes = enabledStatuses(project);
  if (lanes.includes(requested)) return requested;
  return lanes.find((s) => s !== "done" && s !== "cancelled") ?? lanes[0];
}

export function TaskForm({
  project,
  task: initialTask,
  defaultStatus = "todo",
  onClose,
  onSaved,
  agentDefaults,
}: {
  project: Project;
  task?: Task;
  defaultStatus?: Status;
  onClose: () => void;
  /** `launch` reports the optional first agent started with a new task. */
  onSaved: (id: string, launch?: { sessionId?: string; error?: string }, status?: Status) => void;
  agentDefaults?: AgentDefaults;
}) {
  const theme = useTheme();
  const [task] = useState(initialTask);
  const create = useRpc(rpc.createTask),
    update = useRpc(rpc.updateTask);
  const resources = useResourcesQuery();
  const board = useBoardQuery();
  const [title, setTitle] = useState(task?.title || ""),
    [description, setDescription] = useState(task?.description || ""),
    [status, setStatus] = useState<Status>(task?.status || startStatus(project, defaultStatus)),
    [priority, setPriority] = useState(task?.priority || "normal"),
    [type, setType] = useState<TaskType | "">(task?.type || ""),
    [mode, setMode] = useState<"directory" | "worktree" | "existing">(
      "directory",
    ),
    [workspaceId, setWorkspace] = useState(""),
    [branchName, setBranch] = useState(""),
    [baseRef, setBase] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [operationId] = useState(
    () => `card-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  // Optional first agent for a new task (remembered on/off choice).
  const view = useBoardView();
  const [startAgent, setStartAgentState] = useState<boolean | null>(null);
  const startChosen = !task && (startAgent ?? view.values?.startAgentOnCreate ?? true);
  const setStartAgent = (next: boolean) => {
    setStartAgentState(next);
    if (view.values && view.values.startAgentOnCreate !== next) void view.update({ startAgentOnCreate: next });
  };
  const choice = useAgentChoice({ enabled: startChosen, cwd: project.primaryPath, defaults: agentDefaults });
  // The project's lanes. New tasks start in an active lane (finished ones only
  // when added from that lane); an edited card keeps showing its current lane.
  const lanes = enabledStatuses(project);
  const statusChoices = task
    ? lanes.includes(task.status) ? lanes : [...lanes, task.status]
    : lanes.filter((s) => (s !== "done" && s !== "cancelled") || s === defaultStatus);
  // The agent's first message; required, never prefilled (title and description already reach it as context).
  const [prompt, setPrompt] = useState("");
  const contextRead = useRpc(rpc.taskContext),
    prepare = useRpc(rpc.prepareSession),
    paseo = usePaseo();
  const eligible = (resources.data?.workspaces || []).filter((w) =>
    w.repoPaths.includes(project.primaryPath),
  );
  async function save() {
    setPending(true);
    setError("");
    try {
      const result = task
        ? await update({
            id: task.id,
            revision: task.revision,
            title,
            description,
            status,
            priority,
            type: type || null,
          })
        : await create({
            projectId: project.id,
            operationId,
            title,
            description,
            status,
            priority,
            type: type || undefined,
            mode,
            workspaceId: mode === "existing" ? workspaceId : undefined,
            baseRef,
            branchName,
          });
      if (task) return onSaved(result.id, undefined, result.status);
      if (!startChosen) return onSaved(result.id);
      try {
        const session = await launchKanbanSession({ paseo, contextRead, prepare }, result, {
          provider: choice.provider,
          model: choice.chosenModel,
          mode: choice.chosenMode,
          thinking: choice.chosenThinking,
          prompt: prompt.trim(),
          operationId: `first-session-${operationId}`,
        });
        onSaved(result.id, { sessionId: session.id });
      } catch (e) {
        // The card exists; report and let the user start the agent from the drawer.
        onSaved(result.id, { error: message(e) });
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      open
      title={task ? "Edit task" : "Create task"}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Modal.Content>
        <Theme.Provider value={theme}>
        <View style={{ gap: 16 }}>
          <Field title="Title" value={title} onChange={setTitle} placeholder="What needs doing?" />
          <Field
            title="Description"
            value={description}
            onChange={setDescription}
            multiline
          />
          <Choices
            title="Status"
            value={status}
            // New tasks start in an active column (finished ones only when added from that column).
            options={statusChoices.map((s) => ({ value: s, label: laneName(project, s) }))}
            onChange={setStatus}
          />
          <Choices
            title="Priority"
            value={priority}
            options={priorities.map((p) => ({ value: p, label: priorityLabels[p] }))}
            onChange={setPriority}
          />
          <Choices
            title="Type"
            value={type}
            options={[
              { value: "" as const, label: "None" },
              ...taskTypes.map((t) => ({ value: t, label: taskTypeLabels[t] })),
            ]}
            onChange={setType}
          />
          <Label muted size={font.sm}>
            Project root · {project.primaryPath}
            {project.links ? ` · links ${project.links.map((l) => l.name).join(", ")}` : ""}
          </Label>
          {task && isLegacyScope(task, project) && (
            <Notice tone="info">
              Legacy card scope is preserved:{" "}
              {(task.repoPaths.length ? task.repoPaths : project.repos).join(
                ", ",
              )}
              . Its directories and workspace stay linked.
            </Notice>
          )}
          {!task && (
            <>
              <Choices
                title="Workspace"
                value={mode}
                options={[
                  { value: "directory", label: "New in directory" },
                  { value: "worktree", label: "New isolated worktree", disabled: !!project.links },
                  { value: "existing", label: "Link existing" },
                ]}
                onChange={setMode}
              />
              {mode === "worktree" && (
                <Label muted size={font.sm}>
                  The project root itself must be a Git repository. For two
                  child repositories under a common directory, choose a
                  directory workspace.
                </Label>
              )}
              {mode === "existing" && (
                <>
                  <View style={{ gap: 6 }}>
                    <Label medium size={font.sm} muted>
                      Existing workspace
                    </Label>
                    {eligible.length > 0 && (
                      <View
                        style={{
                          padding: 4,
                          gap: 2,
                          borderRadius: radius.lg,
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                        }}
                      >
                        {eligible.map((w) => {
                          const bound = !!board.data?.tasks.some(
                            (t) => t.workspaceId === w.id,
                          );
                          return (
                            <Row
                              key={w.id}
                              title={w.name}
                              detail={`${basename(project.primaryPath)} · ${w.owner}${bound ? " · already bound" : ""}`}
                              label={`Existing workspace: ${w.name}`}
                              icon="FolderGit2"
                              selected={workspaceId === w.id}
                              disabled={bound}
                              onPress={() => setWorkspace(w.id)}
                            />
                          );
                        })}
                      </View>
                    )}
                  </View>
                  {!!workspaceId && (
                    <Label muted size={font.sm}>
                      {eligible.find((w) => w.id === workspaceId)?.path} ·
                      native owner is preserved
                    </Label>
                  )}
                  {eligible.length === 0 && (
                    <Notice tone="info">
                      No available workspace under this Paseo project root.
                      Create one or register a matching directory/worktree in
                      Paseo.
                    </Notice>
                  )}
                </>
              )}
              {mode === "worktree" && (
                <>
                  <Field
                    title="Base ref (optional)"
                    value={baseRef}
                    onChange={setBase}
                    placeholder="Current branch of the project root"
                  />
                  <Field
                    title="New branch (optional)"
                    value={branchName}
                    onChange={setBranch}
                    placeholder="Leave empty to generate kanban/<title>-xxxxxx"
                  />
                </>
              )}
            </>
          )}
          {!task && (
            <View style={{ gap: 12 }}>
              <Toggle
                title="Start an agent now"
                detail="Create the task, then start its first session with Kanban tools. Turn off to add the task only and start later."
                value={startChosen}
                onChange={setStartAgent}
              />
              {startChosen && (
                <>
                  <AgentPicker choice={choice} disabled={pending} />
                  <Field
                    title="Instruction"
                    value={prompt}
                    onChange={setPrompt}
                    multiline
                    placeholder="What should the agent do first?"
                    hint="The title and description are included automatically."
                  />
                </>
              )}
            </View>
          )}
          {resources.error && <Notice>{message(resources.error)}</Notice>}
          {error && <Notice>{error}</Notice>}
          <Actions>
            <Button quiet disabled={pending} onPress={onClose}>
              Cancel
            </Button>
            <Button
              primary
              icon={startChosen ? "Play" : undefined}
              disabled={
                pending ||
                !title.trim() ||
                (!task && mode === "existing" && !workspaceId) ||
                (startChosen && (!choice.ready || !prompt.trim()))
              }
              onPress={() => void save()}
            >
              {pending ? (startChosen ? "Starting…" : "Saving…") : task ? "Save task" : startChosen ? "Create and start" : "Create task"}
            </Button>
          </Actions>
        </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}
