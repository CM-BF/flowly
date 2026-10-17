import { memo, useMemo, useState } from "react";
import { View } from "react-native";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import type { Task } from "../shared/model";
import { projectTagStats, tagValues } from "../shared/tags";
import { boardKey, useBoardQuery } from "./queries";
import { TagEditor, TagPill } from "./tag-input";
import { IconButton, Label, Notice, font, message, space } from "./ui";
import { t } from "../shared/i18n";

/**
 * The drawer's Tags row (CARD-TAGS-SPEC §6.3): each change saves at once through
 * `tasks.tags`, which leaves the card revision alone. Tapping a tag filters the board.
 */
export const TaskTags = memo(function TaskTags({
  task,
  active,
  onFilterTag,
}: {
  task: Task;
  active: boolean;
  onFilterTag?(tag: string): void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const board = useBoardQuery();
  const save = useRpc(rpc.updateTaskTags);
  const [editing, setEditing] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const tags = useMemo(() => tagValues(task), [task.tags]);
  const agentTags = useMemo(() => new Set((task.tags || []).filter((x) => x.by === "agent").map((x) => x.tag)), [task.tags]);
  const suggestions = useMemo(
    () => (editing ? projectTagStats(board.data?.tasks || [], task.projectId).map((x) => x.tag) : []),
    [editing, board.data?.tasks, task.projectId],
  );
  const writable = active && !task.archivedAt;
  const change = async (edit: { add?: string[]; remove?: string[] }, success: string) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await save({ taskId: task.id, ...edit });
      toast.show(success, { variant: "success" });
      void queryClient.invalidateQueries({ queryKey: boardKey });
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  };
  const add = (values: string[]) =>
    void change({ add: values }, values.length === 1 ? t("Tag {tag} added", { tag: values[0] }) : t("Tags added"));
  const remove = (tag: string) => void change({ remove: [tag] }, t("Tag {tag} removed", { tag }));
  if (!tags.length && !writable) return null;
  return (
    <View style={{ gap: space[1.5] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
        <Label medium size={font.sm} muted>
          {t("Tags")}
        </Label>
        {writable && (
          <IconButton
            icon={editing ? "Check" : "Plus"}
            label={editing ? t("Done editing tags") : t("Edit tags")}
            onPress={() => setEditing((v) => !v)}
          />
        )}
      </View>
      {editing && writable ? (
        <TagEditor
          tags={tags}
          agentTags={agentTags}
          suggestions={suggestions}
          onAdd={add}
          onRemove={remove}
          disabled={pending}
          autoFocus
        />
      ) : tags.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1] }}>
          {tags.map((tag) => (
            <TagPill key={tag} tag={tag} agent={agentTags.has(tag)} onPress={onFilterTag ? () => onFilterTag(tag) : undefined} />
          ))}
        </View>
      ) : (
        <Label muted size={font.sm}>
          {t("No tags yet. Tag the modules and directions this card touches.")}
        </Label>
      )}
      {!!error && <Notice>{error}</Notice>}
    </View>
  );
});
