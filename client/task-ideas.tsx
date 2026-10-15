import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { taskTypeLabels, type Idea, type Task } from "../shared/model";
import { Disclosure } from "./disclosure";
import { Enter, lerp, motionDuration, useMotionPresence } from "./motion";
import { exitRows } from "./idea-rows";
import { boardKey, useBoardQuery } from "./queries";
import { PriorityIcon, TypeIcon, priorityLabels } from "./status";
import { Button, Label, SectionHeader, font, message, radius, relativeTime, space, touch, useTheme } from "./ui";

/**
 * Drawer "Ideas": follow-ups agents proposed on this card (IDEAS-SPEC §5.2).
 * Renders nothing without ideas. "Not now" is optimistic: the card collapses
 * away at once and comes back with an error toast if the save fails.
 */
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
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(() => new Set());
  const [restoring, setRestoring] = useState("");
  const ideas = useMemo(() => (board.data?.ideas || []).filter((i) => i.taskId === taskId), [board.data?.ideas, taskId]);
  const open = useMemo(() => ideas.filter((i) => i.status === "open" && !dismissing.has(i.id)), [ideas, dismissing]);
  const closed = ideas.filter((i) => i.status !== "open" || dismissing.has(i.id)).reverse();
  // A dismissal is settled once the board shows it; drop it from the optimistic set.
  useEffect(() => {
    const settled = [...dismissing].filter((id) => !ideas.some((i) => i.id === id && i.status === "open"));
    if (settled.length) setDismissing((current) => without(current, settled));
  }, [ideas, dismissing]);
  const rows = useExitList(open);
  if (!ideas.length) return null;
  const titleOf = (id: string) => board.data?.tasks.find((t) => t.id === id)?.title;
  const dismiss = async (idea: Idea) => {
    setDismissing((current) => new Set(current).add(idea.id));
    try {
      await updateIdea({ id: idea.id, status: "dismissed" });
      await queryClient.invalidateQueries({ queryKey: boardKey });
    } catch (e) {
      setDismissing((current) => without(current, [idea.id]));
      toast.show(message(e), { variant: "error" });
    }
  };
  const restore = async (idea: Idea) => {
    setRestoring(idea.id);
    try {
      await updateIdea({ id: idea.id, status: "open" });
      await queryClient.invalidateQueries({ queryKey: boardKey });
    } catch (e) {
      toast.show(message(e), { variant: "error" });
    } finally {
      setRestoring("");
    }
  };
  return (
    <View style={{ gap: space[2] }}>
      <SectionHeader title="Ideas" count={open.length} />
      {rows.length ? (
        <View>
          {rows.map((row) => (
            <IdeaRow key={row.item.id} leaving={row.leaving} entering={row.entering}>
              <IdeaCard idea={row.item} disabled={disabled || row.leaving} onCreate={onCreate} onDismiss={dismiss} />
            </IdeaRow>
          ))}
        </View>
      ) : (
        <Label muted size={font.sm}>No open ideas. Agents add them when they find follow-up work.</Label>
      )}
      {closed.length > 0 && (
        <Disclosure title={`Closed · ${closed.length}`} open={closedOpen} onChange={setClosedOpen}>
          <View style={{ gap: space[1] }}>
            {closed.map((idea) => (
              <ClosedIdea
                key={idea.id}
                idea={idea}
                acceptedTitle={idea.acceptedTaskId ? titleOf(idea.acceptedTaskId) : undefined}
                disabled={disabled || !!restoring || dismissing.has(idea.id)}
                onOpenTask={onOpenTask}
                onRestore={(i) => void restore(i)}
              />
            ))}
          </View>
        </Disclosure>
      )}
    </View>
  );
}

const without = (set: ReadonlySet<string>, ids: readonly string[]) => {
  const next = new Set(set);
  for (const id of ids) next.delete(id);
  return next;
};

/**
 * The open list plus rows that just left it, held in place for their exit.
 * Rows present on first render never animate in; later arrivals do.
 */
function useExitList<T extends { id: string }>(items: readonly T[]) {
  const [leaving, setLeaving] = useState<ReadonlyMap<string, { item: T; index: number }>>(() => new Map());
  const previous = useRef(items);
  const initial = useRef(new Set(items.map((i) => i.id)));
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    const gone = previous.current.map((item, index) => ({ item, index })).filter(({ item }) => !ids.has(item.id));
    const back = [...leaving.keys()].filter((id) => ids.has(id));
    previous.current = items;
    if (!gone.length && !back.length) return;
    for (const id of back) {
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
    }
    setLeaving((current) => {
      const next = new Map(current);
      for (const id of back) next.delete(id);
      for (const row of gone) next.set(row.item.id, row);
      return next;
    });
    for (const { item } of gone) {
      clearTimeout(timers.current.get(item.id));
      timers.current.set(
        item.id,
        setTimeout(() => {
          timers.current.delete(item.id);
          setLeaving((current) => {
            const next = new Map(current);
            next.delete(item.id);
            return next;
          });
        }, motionDuration.reverse + 40),
      );
    }
    // `leaving` is read, not tracked: only a change of the open list starts or cancels exits.
  }, [items]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return useMemo(() => exitRows(items, [...leaving.values()], initial.current), [items, leaving]);
}


/** Holds one idea's slot: rises in when it arrives, collapses its height and fades when it leaves. */
function IdeaRow({ leaving, entering, children }: { leaving: boolean; entering: boolean; children: ReactNode }) {
  const [height, setHeight] = useState(0);
  // Height is a layout property, so this value runs on the JS driver.
  const presence = useMotionPresence(leaving ? undefined : true, leaving ? "" : "row", false);
  const body = (
    <View onLayout={(e) => setHeight(e.nativeEvent.layout.height)} style={{ paddingBottom: space[2] }}>
      {children}
    </View>
  );
  if (leaving)
    return (
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          overflow: "hidden",
          height: height ? lerp(presence.progress, [0, height]) : undefined,
          opacity: presence.progress,
          transform: [{ scale: lerp(presence.progress, [0.97, 1]) }],
        }}
      >
        {body}
      </Animated.View>
    );
  return entering ? <Enter distance={8}>{body}</Enter> : body;
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
  const [contentHeight, setContentHeight] = useState(0);
  const details = useMotionPresence(expanded ? true : undefined, expanded ? "details" : "", false);
  const hasMore = !!(idea.detail.trim() || idea.context.trim()) || idea.rationale.length > 90;
  const meta = [
    idea.type && (
      <Meta key="type" icon={<TypeIcon type={idea.type} size={12} />} text={taskTypeLabels[idea.type]} />
    ),
    idea.priority && idea.priority !== "normal" && (
      // Low's single-bar glyph reads as stray punctuation at this size; only the High/Urgent arrows add meaning.
      <Meta
        key="priority"
        icon={idea.priority === "low" ? null : <PriorityIcon priority={idea.priority} size={12} />}
        text={idea.priority === "low" ? "Low priority" : priorityLabels[idea.priority]}
      />
    ),
  ].filter(Boolean);
  return (
    <View
      style={{
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Idea: ${idea.title}`}
        accessibilityState={{ expanded, disabled: !hasMore }}
        accessibilityHint={hasMore ? (expanded ? "Hides the details" : "Shows what to do, why, and the context") : undefined}
        disabled={!hasMore}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => ({
          gap: space[1.5],
          paddingHorizontal: space[3],
          paddingTop: space[3],
          paddingBottom: space[2],
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[2] }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label bold size={font.md} selectable={false}>{idea.title}</Label>
          </View>
          {hasMore && (
            <Animated.View
              style={{ paddingTop: 2, transform: [{ rotate: lerp(details.progress, ["0deg", "180deg"]) }] }}
            >
              <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />
            </Animated.View>
          )}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space[3], rowGap: 2 }}>
          {meta}
          <Label muted size={font.xs} selectable={false}>{relativeTime(idea.createdAt)}</Label>
        </View>
        {!!idea.rationale.trim() && (
          <Label muted size={font.sm} lines={expanded ? undefined : 2} selectable={expanded}>
            {idea.rationale}
          </Label>
        )}
        {details.item && (
          <Animated.View
            pointerEvents={details.active ? "auto" : "none"}
            accessibilityElementsHidden={!details.active}
            importantForAccessibility={details.active ? "auto" : "no-hide-descendants"}
            style={{ overflow: "hidden", height: lerp(details.progress, [0, contentHeight]), opacity: details.progress }}
          >
            <View
              onLayout={(e) => setContentHeight(e.nativeEvent.layout.height)}
              style={{ position: "absolute", top: 0, left: 0, right: 0, gap: space[2], paddingTop: space[1.5] }}
            >
              <IdeaField title="What to do" text={idea.detail} />
              <IdeaField title="Context" text={idea.context} />
            </View>
          </Animated.View>
        )}
      </Pressable>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          // The quiet button carries its own padding, so a small gap reads as even spacing.
          gap: space[1],
          paddingHorizontal: space[3],
          paddingBottom: space[2] + 2,
        }}
      >
        <Button
          small
          primary
          icon="ThumbsUp"
          disabled={disabled}
          label={`Good idea: create a task from ${idea.title}`}
          onPress={() => onCreate(idea)}
        >
          Good idea
        </Button>
        <Button small quiet disabled={disabled} label={`Not now: dismiss ${idea.title}`} onPress={() => onDismiss(idea)}>
          Not now
        </Button>
      </View>
    </View>
  );
});

function Meta({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      {icon}
      <Label muted size={font.xs} selectable={false}>{text}</Label>
    </View>
  );
}

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
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: touch ? 44 : 32 }}>
      <Icon name={accepted ? "ThumbsUp" : "CircleSlash"} size={14} color={accepted ? colors.statusSuccess : colors.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label size={font.sm} muted={!accepted} lines={1} selectable={false}>{idea.title}</Label>
        {accepted &&
          (acceptedTitle && idea.acceptedTaskId ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Open task ${acceptedTitle}`}
              onPress={() => onOpenTask(idea.acceptedTaskId!)}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <Label size={font.xs} color={colors.accent} lines={1} selectable={false}>→ {acceptedTitle}</Label>
            </Pressable>
          ) : (
            <Label muted size={font.xs} selectable={false}>→ deleted card</Label>
          ))}
      </View>
      {!accepted && (
        <Button small quiet icon="Undo2" disabled={disabled} label={`Restore ${idea.title}`} onPress={() => onRestore(idea)}>
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
  if (!task.origin || board.isPending) return null;
  const source = board.data?.tasks.find((t) => t.id === task.origin!.taskId);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
      <Icon name="Lightbulb" size={13} color={colors.foregroundMuted} />
      {source ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open source task ${source.title}`}
          onPress={() => onOpenTask(source.id)}
          style={({ pressed }) => ({ flexShrink: 1, opacity: pressed ? 0.7 : 1 })}
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
