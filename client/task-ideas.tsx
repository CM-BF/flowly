import { memo, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { taskTypeLabels, type Idea, type Task } from "../shared/model";
import { Disclosure } from "./disclosure";
import { boardKey, useBoardQuery } from "./queries";
import { PriorityIcon, TypeIcon, priorityLabels } from "./status";
import { Button, Label, SectionHeader, font, message, radius, space, useTheme } from "./ui";

/** Drawer "Ideas": follow-ups agents proposed on this card (IDEAS-SPEC §5.2). Renders nothing without ideas. */
export function TaskIdeas({
  taskId,
  disabled,
  onCreate,
  onOpenTask,
}: {
  taskId: string;
  disabled: boolean;
  onCreate(idea: Idea): void;
  onOpenTask(id: string): void;
}) {
  const board = useBoardQuery();
  const toast = useToast();
  const queryClient = useQueryClient();
  const updateIdea = useRpc(rpc.updateIdea);
  const [closedOpen, setClosedOpen] = useState(false);
  const [pending, setPending] = useState("");
  const ideas = useMemo(() => (board.data?.ideas || []).filter((i) => i.taskId === taskId), [board.data?.ideas, taskId]);
  const open = ideas.filter((i) => i.status === "open");
  const closed = ideas.filter((i) => i.status !== "open").reverse();
  if (!ideas.length) return null;
  const titleOf = (id: string) => board.data?.tasks.find((t) => t.id === id)?.title;
  const setStatus = async (idea: Idea, status: "open" | "dismissed") => {
    setPending(idea.id);
    try {
      await updateIdea({ id: idea.id, status });
      await queryClient.invalidateQueries({ queryKey: boardKey });
    } catch (e) {
      toast.show(message(e), { variant: "error" });
    } finally {
      setPending("");
    }
  };
  return (
    <View style={{ gap: space[2] }}>
      <SectionHeader title="Ideas" count={open.length} />
      {open.length ? (
        <View style={{ gap: space[2] }}>
          {open.map((idea) => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              disabled={disabled || pending === idea.id}
              onCreate={onCreate}
              onDismiss={(i) => void setStatus(i, "dismissed")}
            />
          ))}
        </View>
      ) : (
        <Label muted size={font.sm}>No open ideas.</Label>
      )}
      {closed.length > 0 && (
        <Disclosure title={`Closed · ${closed.length}`} open={closedOpen} onChange={setClosedOpen}>
          <View style={{ gap: space[1] }}>
            {closed.map((idea) => (
              <ClosedIdea
                key={idea.id}
                idea={idea}
                acceptedTitle={idea.acceptedTaskId ? titleOf(idea.acceptedTaskId) : undefined}
                disabled={disabled || pending === idea.id}
                onOpenTask={onOpenTask}
                onRestore={(i) => void setStatus(i, "open")}
              />
            ))}
          </View>
        </Disclosure>
      )}
    </View>
  );
}

const IdeaCard = memo(function IdeaCard({
  idea,
  disabled,
  onCreate,
  onDismiss,
}: {
  idea: Idea;
  disabled: boolean;
  onCreate(idea: Idea): void;
  onDismiss(idea: Idea): void;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View
      style={{
        gap: space[2],
        padding: space[3],
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Idea: ${idea.title}`}
        accessibilityState={{ expanded }}
        accessibilityHint={expanded ? "Hide details" : "Show details"}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => ({ gap: space[1.5], opacity: pressed ? 0.8 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[1.5] }}>
          <View style={{ paddingTop: 2 }}>
            <Icon name="Lightbulb" size={14} color={colors.statusWarning} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label bold size={font.md} selectable={false}>{idea.title}</Label>
          </View>
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
        </View>
        {(!!idea.type || !!idea.priority) && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[3] }}>
            {!!idea.priority && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                <PriorityIcon priority={idea.priority} size={12} />
                <Label muted size={font.xs} selectable={false}>{priorityLabels[idea.priority]}</Label>
              </View>
            )}
            {!!idea.type && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                <TypeIcon type={idea.type} size={12} />
                <Label muted size={font.xs} selectable={false}>{taskTypeLabels[idea.type]}</Label>
              </View>
            )}
          </View>
        )}
        {expanded ? (
          <View style={{ gap: space[2] }}>
            <Label size={font.sm} selectable>{idea.detail}</Label>
            <IdeaField title="Why" text={idea.rationale} />
            <IdeaField title="Context" text={idea.context} />
          </View>
        ) : (
          <Label muted size={font.sm} lines={2} selectable={false}>{idea.rationale}</Label>
        )}
      </Pressable>
      <View style={{ flexDirection: "row", gap: space[2] }}>
        <Button primary icon="Plus" disabled={disabled} onPress={() => onCreate(idea)}>
          Create task
        </Button>
        <Button quiet icon="X" disabled={disabled} onPress={() => onDismiss(idea)}>
          Dismiss
        </Button>
      </View>
    </View>
  );
});

function IdeaField({ title, text }: { title: string; text: string }) {
  if (!text.trim()) return null;
  return (
    <View style={{ gap: 2 }}>
      <Label muted size={font.xs} bold selectable={false}>{title}</Label>
      <Label size={font.sm} selectable>{text}</Label>
    </View>
  );
}

function ClosedIdea({
  idea,
  acceptedTitle,
  disabled,
  onOpenTask,
  onRestore,
}: {
  idea: Idea;
  acceptedTitle?: string;
  disabled: boolean;
  onOpenTask(id: string): void;
  onRestore(idea: Idea): void;
}) {
  const { colors } = useTheme();
  const accepted = idea.status === "accepted";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: 32 }}>
      <Icon name={accepted ? "CircleCheck" : "CircleSlash"} size={14} color={accepted ? colors.statusSuccess : colors.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label size={font.sm} muted={!accepted} lines={1} selectable={false}>{idea.title}</Label>
        {accepted &&
          (acceptedTitle && idea.acceptedTaskId ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Open task ${acceptedTitle}`}
              onPress={() => onOpenTask(idea.acceptedTaskId!)}
            >
              <Label size={font.xs} color={colors.accent} lines={1} selectable={false}>→ {acceptedTitle}</Label>
            </Pressable>
          ) : (
            <Label muted size={font.xs} selectable={false}>→ deleted card</Label>
          ))}
      </View>
      {!accepted && (
        <Button quiet icon="Undo2" disabled={disabled} onPress={() => onRestore(idea)}>
          Restore
        </Button>
      )}
    </View>
  );
}

/** "From idea on <card>" for a card created from an idea (IDEAS-SPEC §5.3). */
export function IdeaOrigin({ task, onOpenTask }: { task: Task; onOpenTask(id: string): void }) {
  const board = useBoardQuery({ enabled: !!task.origin });
  const { colors } = useTheme();
  if (!task.origin) return null;
  const source = board.data?.tasks.find((t) => t.id === task.origin!.taskId);
  if (board.isPending) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
      <Icon name="Lightbulb" size={13} color={colors.foregroundMuted} />
      {source ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open source task ${source.title}`}
          onPress={() => onOpenTask(source.id)}
          style={{ flexShrink: 1 }}
        >
          <Label size={font.sm} muted lines={1} selectable={false}>
            From idea on <Label size={font.sm} color={colors.accent} selectable={false}>{source.title}</Label>
          </Label>
        </Pressable>
      ) : (
        <Label size={font.sm} muted selectable={false}>From idea on a deleted card</Label>
      )}
    </View>
  );
}
