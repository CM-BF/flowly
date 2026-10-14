import { useState } from "react";
import { View } from "react-native";
import { Modal } from "./modal";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import {
  statuses,
  statusLabels,
  priorities,
  type Project,
  type Task,
  type Status,
} from "../shared/model";
import { Theme, useTheme, Button, Field, Choices, Notice, Label, Row, Actions, message, basename, font, radius } from "./ui";
import { priorityLabels } from "./status";
import { isLegacyScope } from "../shared/scope";

export function ProjectForm({
  project: initialProject,
  onClose,
  onSaved,
}: {
  project?: Project;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const theme = useTheme();
  const [project] = useState(initialProject);
  const create = useRpc(rpc.createProject),
    update = useRpc(rpc.updateProject),
    list = useRpc(rpc.listResources);
  const resources = useQuery({
    queryKey: ["ultra", "resources"],
    queryFn: () => list({}),
  });
  const [title, setTitle] = useState(project?.title || ""),
    [description, setDescription] = useState(project?.description || ""),
    [primaryPath, setPrimary] = useState(project?.primaryPath || ""),
    [nativeId, setNative] = useState(project?.paseoProjectId || ""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  async function save() {
    setPending(true);
    setError("");
    try {
      const result = project
        ? await update({
            id: project.id,
            revision: project.revision,
            title,
            description,
          })
        : await create({
            title,
            description,
            primaryPath,
            ...(nativeId ? { paseoProjectId: nativeId } : {}),
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
              title="Paseo project"
              value={nativeId}
              options={[
                { value: "", label: "Register from directory" },
                ...(resources.data?.projects || []).map((p) => ({
                  value: p.id,
                  label: p.name,
                })),
              ]}
              onChange={(id) => {
                setNative(id);
                const p = resources.data?.projects.find((p) => p.id === id);
                if (p) {
                  setPrimary(p.path);
                }
              }}
            />
          )}
          <Field
            title="Paseo project root"
            value={primaryPath}
            onChange={setPrimary}
            editable={!project && !nativeId}
            placeholder="/absolute/path/to/repo"
          />
          <Label muted size={font.sm}>
            For work across repositories, place them in a common directory and
            use that directory as the Paseo project root.
          </Label>
          {resources.error && <Notice>{message(resources.error)}</Notice>}
          {error && <Notice>{error}</Notice>}
          <Actions>
            <Button quiet disabled={pending} onPress={onClose}>
              Cancel
            </Button>
            <Button
              primary
              disabled={pending || !title.trim() || !primaryPath.trim()}
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

export function TaskForm({
  project,
  task: initialTask,
  defaultStatus = "todo",
  onClose,
  onSaved,
}: {
  project: Project;
  task?: Task;
  defaultStatus?: Status;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const theme = useTheme();
  const [task] = useState(initialTask);
  const create = useRpc(rpc.createTask),
    update = useRpc(rpc.updateTask),
    list = useRpc(rpc.listResources);
  const resources = useQuery({
    queryKey: ["ultra", "resources"],
    queryFn: () => list({}),
  });
  const boardRead = useRpc(rpc.readBoard);
  const board = useQuery({
    queryKey: ["ultra", "board"],
    queryFn: () => boardRead({}),
  });
  const [title, setTitle] = useState(task?.title || ""),
    [description, setDescription] = useState(task?.description || ""),
    [status, setStatus] = useState<Status>(task?.status || defaultStatus),
    [priority, setPriority] = useState(task?.priority || "normal"),
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
          })
        : await create({
            projectId: project.id,
            operationId,
            title,
            description,
            status,
            priority,
            mode,
            workspaceId: mode === "existing" ? workspaceId : undefined,
            baseRef,
            branchName,
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
            options={statuses.map((s) => ({
              value: s,
              label: statusLabels[s],
            }))}
            onChange={setStatus}
          />
          <Choices
            title="Priority"
            value={priority}
            options={priorities.map((p) => ({ value: p, label: priorityLabels[p] }))}
            onChange={setPriority}
          />
          <Label muted size={font.sm}>Project root · {project.primaryPath}</Label>
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
                  { value: "worktree", label: "New isolated worktree" },
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
                    title="New branch"
                    value={branchName}
                    onChange={setBranch}
                    placeholder="feature/task-name"
                  />
                </>
              )}
            </>
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
                (!task && mode === "existing" && !workspaceId) ||
                (!task && mode === "worktree" && !branchName.trim())
              }
              onPress={() => void save()}
            >
              {pending ? "Saving…" : task ? "Save task" : "Create task"}
            </Button>
          </Actions>
        </View>
        </Theme.Provider>
      </Modal.Content>
    </Modal>
  );
}
