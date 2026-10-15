import { View } from "react-native";
import { taskTypeLabels, type Task, type Project } from "../shared/model";
import { Disclosure } from "./disclosure";
import { Label, Notice, basename, font, space } from "./ui";
import { priorityLabels } from "./status";

function MetaRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[3], minWidth: 0 }}>
    <View style={{ width: 96 }}><Label muted size={font.sm}>{label}</Label></View>
    <View style={{ flex: 1, minWidth: 0 }}><Label selectable size={mono ? font.sm : font.md} mono={mono}>{value}</Label></View>
  </View>;
}

export function TaskMetadata({ task, project, open, onChange, disabled, summary, legacy,
  workspaceName, workspaceDirectory, workspaceStatus, owner, directories,
}: {
  task: Task;
  project: Project;
  open: boolean;
  onChange(open: boolean): void;
  disabled: boolean;
  summary?: string;
  legacy: boolean;
  workspaceName?: string;
  workspaceDirectory?: string;
  workspaceStatus: string;
  owner?: string;
  directories: { repo: string; directory: string }[];
}) {
  return <Disclosure title="Details & workspace" summary={summary} open={open} disabled={disabled} onChange={onChange}>
    <MetaRow label="Type" value={task.type ? taskTypeLabels[task.type] : "None"} />
    <MetaRow label="Priority" value={priorityLabels[task.priority]} />
    <MetaRow label="Project" value={project.title} />
    <MetaRow label="Project root" value={project.primaryPath} mono />
    <MetaRow label="Workspace" value={workspaceName || task.workspaceId} />
    <MetaRow label="Workspace ID" value={task.workspaceId} mono />
    <MetaRow label="Directory" value={workspaceDirectory || task.sourcePath} mono />
    <MetaRow label="Execution" value={workspaceStatus} />
    <MetaRow label="Native owner" value={owner || "Checking…"} />
    <MetaRow label="Created" value={new Date(task.createdAt).toLocaleString()} />
    <MetaRow label="Updated" value={new Date(task.updatedAt).toLocaleString()} />
    {legacy && <>
      <Notice tone="info">Legacy card scope is preserved. Its saved directories and workspace stay linked.</Notice>
      {directories.map((path) => <MetaRow key={path.repo} label={basename(path.repo)} value={path.directory} mono />)}
    </>}
  </Disclosure>;
}
