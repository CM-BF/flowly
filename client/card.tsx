import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { taskTypeLabels, type Task } from "../shared/model";
import { Badge, Dot, IconButton, Label, font, radius, relativeTime, space, tint, touch, useTheme } from "./ui";
import { PriorityIcon, TypeIcon, priorityAccent, priorityLabels } from "./status";
import type { Point } from "./geometry";
import type { SessionAttentionSummary } from "../shared/session-attention";
import { PulseDot, motionDuration, useMotionValue } from "./motion";
import { useCardOutput, type CardOutput, type OutputSession } from "./card-output";
import { menuHandlers, useMenuOpener, type MenuEntry } from "./context-menu";
import { shallowEqual } from "./stable";
import { t, tn } from "../shared/i18n";

export type CardDrag = {
  start(task: Task, point: Point): void;
  move(point: Point): void;
  end(point: Point): void;
  cancel(): void;
};

type TaskCardProps = Parameters<typeof TaskCard>[0];

type LiveTaskCardProps = Omit<TaskCardProps, "output" | "menu" | "onOpen" | "onActions"> & {
  outputSession?: OutputSession | null;
  /** Stable handlers shared by all cards; they receive the card's task (PERFORMANCE-SPEC §3). */
  onOpen(task: Task): void;
  onActions(task: Task): void;
  menuFor?(task: Task): MenuEntry[];
};

/** Derived props arrive as fresh objects each board render; compare their content. */
const contentProps = new Set(["summary", "progress", "outputSession"]);
function sameLiveCard(a: LiveTaskCardProps, b: LiveTaskCardProps) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof LiveTaskCardProps>;
  for (const key of keys) {
    if (Object.is(a[key], b[key])) continue;
    if (contentProps.has(key) && shallowEqual(a[key], b[key])) continue;
    return false;
  }
  return true;
}

/**
 * TaskCard that loads its latest agent output while mounted. Memoized: a board
 * re-render (live agent updates, polls) only re-renders cards whose own data
 * changed.
 */
export const LiveTaskCard = memo(function LiveTaskCard({
  outputSession,
  onOpen: openTask,
  onActions: taskActions,
  menuFor,
  ...props
}: LiveTaskCardProps) {
  const { task } = props;
  const output = useCardOutput(props.available ? outputSession : null, task.id);
  const openMenu = useMenuOpener();
  const menu = useMemo(
    () => (menuFor ? menuHandlers(openMenu, task.title, () => menuFor(task)) : undefined),
    [openMenu, menuFor, task],
  );
  const onOpen = useCallback(() => openTask(task), [openTask, task]);
  const onActions = useCallback(() => taskActions(task), [taskActions, task]);
  return <TaskCard {...props} output={output} menu={menu} onOpen={onOpen} onActions={onActions} />;
}, sameLiveCard);

export function TaskCard({
  task,
  selected,
  legacy,
  available,
  wrapped = false,
  running,
  sessions,
  summary,
  summaryState = "ready",
  output,
  progress,
  questions = 0,
  ideas = 0,
  waiting = 0,
  waitingTitles = "",
  flash = false,
  dragging,
  disabled,
  drag,
  onOpen,
  onActions,
  menu,
}: {
  task: Task;
  selected: boolean;
  legacy: boolean;
  available: boolean;
  /** Done/Cancelled and wrapped up: its workspace is archived on purpose, not missing. */
  wrapped?: boolean;
  running: number;
  sessions: number;
  summary?: SessionAttentionSummary;
  summaryState?: "ready" | "loading" | "stale" | "unavailable";
  output?: CardOutput | null;
  /** Latest progress summary state (TASK-SUMMARY-SPEC). */
  progress?: { state: string; at: string } | null;
  /** Open agent questions awaiting the user's reply. */
  questions?: number;
  /** Open ideas proposed on this card (IDEAS-SPEC §5.1). */
  ideas?: number;
  /** Unresolved cards this one is blocked by, and their titles (CARD-LINKS-SPEC §5.1). */
  waiting?: number;
  waitingTitles?: string;
  /** Briefly emphasize a card whose status just changed (often an automatic move). */
  flash?: boolean;
  dragging?: boolean;
  disabled?: boolean;
  drag?: CardDrag;
  onOpen(): void;
  onActions(): void;
  /** Context-menu handlers (right-click / long-press) for the card body. */
  menu?: object;
}) {
  const { colors } = useTheme();
  const outputTime = output ? relativeTime(output.at) : "";
  // No fade on mount: the list's own reveal covers navigation, and N mount
  // animations per lane switch competed with it.
  const opacity = useMotionValue(dragging ? 0.45 : 1);
  const [hovered, setHovered] = useState(false),
    [focused, setFocused] = useState(false);
  // Quick in, slow out: noticeable without holding attention.
  const flashOpacity = useMotionValue(flash ? 1 : 0, flash ? motionDuration.forward : 900);
  // The overlay exists only while it shows (and during its fade-out).
  const [flashShown, setFlashShown] = useState(flash);
  useEffect(() => {
    if (flash) return setFlashShown(true);
    const timer = setTimeout(() => setFlashShown(false), 1000);
    return () => clearTimeout(timer);
  }, [flash]);
  const current = useRef({ task, drag, disabled });
  current.current = { task, drag, disabled };
  const suppressUntil = useRef(0);
  const activeDrag = useRef(false);
  const mousePress = useRef(false);
  useEffect(
    () => () => {
      if (activeDrag.current) current.current.drag?.cancel();
    },
    [],
  );
  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        !!current.current.drag &&
        !current.current.disabled &&
        mousePress.current &&
        Math.hypot(g.dx, g.dy) >= 8,
      onPanResponderGrant: (e) => {
        if (!mousePress.current || current.current.disabled) return;
        activeDrag.current = true;
        suppressUntil.current = Date.now() + 500;
        current.current.drag?.start(current.current.task, {
          x: e.nativeEvent.pageX,
          y: e.nativeEvent.pageY,
        });
      },
      onPanResponderMove: (_e, g) => {
        if (activeDrag.current)
          current.current.drag?.move({ x: g.moveX, y: g.moveY });
      },
      onPanResponderRelease: (e) => {
        mousePress.current = false;
        if (!activeDrag.current) return;
        activeDrag.current = false;
        suppressUntil.current = Date.now() + 250;
        current.current.drag?.end({
          x: e.nativeEvent.pageX,
          y: e.nativeEvent.pageY,
        });
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderTerminate: () => {
        mousePress.current = false;
        if (!activeDrag.current) return;
        activeDrag.current = false;
        current.current.drag?.cancel();
      },
    }),
  );
  const signals = summaryState === "ready" || summaryState === "stale" ? summary : undefined;
  const showActions = !drag || touch || hovered || selected;
  const accent = priorityAccent(colors, task.priority);
  return (
    <Animated.View
      {...(drag && !disabled ? pan.panHandlers : {})}
      onPointerEnter={drag ? () => setHovered(true) : undefined}
      onPointerLeave={drag ? () => setHovered(false) : undefined}
      onPointerDown={
        drag
          ? (e) => {
              mousePress.current =
                e.nativeEvent.pointerType === "mouse" &&
                e.nativeEvent.button === 0;
            }
          : undefined
      }
      onPointerUp={
        drag
          ? () => {
              mousePress.current = false;
            }
          : undefined
      }
      onPointerCancel={
        drag
          ? () => {
              mousePress.current = false;
              if (activeDrag.current) {
                activeDrag.current = false;
                current.current.drag?.cancel();
              }
            }
          : undefined
      }
      style={{
        borderWidth: 1,
        borderColor: selected || focused
          ? colors.accent
          : hovered
            ? tint(colors.foregroundMuted, 0.45)
            : colors.border,
        borderRadius: radius.lg,
        backgroundColor: colors.surface0,
        opacity,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          t("Open task {title}", { title: task.title }),
          questions ? tn(questions, "Needs you: {n} open question", "Needs you: {n} open questions") : "",
          ideas ? tn(ideas, "{n} idea", "{n} ideas") : "",
          waiting ? tn(waiting, "Waiting on {n} card: {waitingTitles}", "Waiting on {n} cards: {waitingTitles}", { waitingTitles }) : "",
          progress ? t("Progress: {state}", { state: progress.state }) : "",
          [t("{priority} priority", { priority: priorityLabels[task.priority] }), task.type ? taskTypeLabels[task.type] : "", task.archivedAt ? t("archived") : "", legacy ? t("legacy scope") : ""].filter(Boolean).join(", "),
          summaryState === "ready" && summary
            ? t("{running} running, {finished} finished turns, {unread} unread sessions, {attention} need attention", { running: summary.running, finished: summary.finished, unread: summary.unread, attention: summary.attention })
            : "",
          output ? t(outputTime ? "Latest agent output {time}: {text}" : "Latest agent output: {text}", { time: outputTime ?? "", text: output.text.length > 80 ? output.text.slice(0, 80) + "…" : output.text }) : "",
        ]
          .filter(Boolean)
          .join(". ") + "."}
        {...(menu || {})}
        accessibilityHint={
          drag
            ? t("Drag this card with the mouse or open task actions to change status.")
            : t("Open details and agent sessions.")
        }
        onPress={() => {
          if (Date.now() >= suppressUntil.current) onOpen();
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={({ pressed }) => ({
          paddingHorizontal: space[3],
          paddingTop: space[2] + 2,
          paddingBottom: space[2] + 2,
          paddingRight: space[3] + 24,
          gap: space[2],
          opacity: pressed ? 0.8 : 1,
          // No browser focus ring; focus is shown with the card's own accent border.
          outlineStyle: "none",
        }) as never}
      >
        <Label medium size={font.base} lines={3} selectable={false}>
          {task.title}
        </Label>
        {!!progress?.state && <ProgressLine state={progress.state} />}
        {output && <OutputLine output={output} time={outputTime} />}
        <CardSignals
          task={task}
          legacy={legacy}
          available={available}
          wrapped={wrapped}
          summary={signals}
          summaryState={summaryState}
          running={running}
          sessions={sessions}
          questions={questions}
          ideas={ideas}
          waiting={waiting}
        />
      </Pressable>
      {accent && (
        // Urgent/High: a stripe down the left edge, readable from across the board.
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -1,
            bottom: -1,
            left: -1,
            width: 4,
            borderTopLeftRadius: radius.lg,
            borderBottomLeftRadius: radius.lg,
            backgroundColor: accent,
          }}
        />
      )}
      {flashShown && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -1,
            left: -1,
            right: -1,
            bottom: -1,
            borderRadius: radius.lg + 1,
            borderWidth: 1.5,
            borderColor: colors.accent,
            backgroundColor: tint(colors.accent, 0.06),
            opacity: flashOpacity,
          }}
        />
      )}
      <View
        style={{ position: "absolute", top: 4, right: 4, opacity: showActions ? 1 : 0 }}
        onPointerDown={
          drag
            ? (e) => {
                mousePress.current = false;
                e.stopPropagation();
              }
            : undefined
        }
      >
        <IconButton
          icon="Ellipsis"
          size={touch ? 40 : 26}
          label={t("Actions for {title}", { title: task.title })}
          onPress={onActions}
        />
      </View>
    </Animated.View>
  );
}

function ProgressLine({ state }: { state: string }) {
  const { colors } = useTheme();
  return (
    // One line on the board; the drawer's Progress section shows it in full.
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], minWidth: 0 }}>
      <Icon name="Flag" size={12} color={colors.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.sm} lines={1} selectable={false}>
          {state}
        </Label>
      </View>
    </View>
  );
}

function OutputLine({ output, time }: { output: CardOutput; time: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minWidth: 0 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label muted size={font.sm} lines={1} selectable={false}>
          {output.text}
        </Label>
      </View>
      {!!time && (
        <View style={{ flexShrink: 0 }}>
          <Label muted size={font.sm} lines={1} selectable={false}>
            {time}
          </Label>
        </View>
      )}
    </View>
  );
}

function Signal({ color, icon, text, pulse = false }: { color?: string; icon?: string; text: string; pulse?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      {icon ? (
        <Icon name={icon} size={13} color={color || colors.foregroundMuted} />
      ) : (
        <PulseDot color={color || colors.foregroundMuted} size={7} active={pulse} />
      )}
      <Label size={font.sm} muted={!color} selectable={false}>
        {text}
      </Label>
    </View>
  );
}

function CardSignals({
  task,
  legacy,
  available,
  wrapped,
  summary,
  summaryState,
  running,
  sessions,
  questions,
  ideas,
  waiting,
}: {
  task: Task;
  legacy: boolean;
  available: boolean;
  wrapped: boolean;
  summary?: SessionAttentionSummary;
  summaryState: "ready" | "loading" | "stale" | "unavailable";
  running: number;
  sessions: number;
  questions: number;
  ideas: number;
  waiting: number;
}) {
  const { colors } = useTheme();
  const items: ReactNode[] = [];
  if (questions)
    items.push(<Signal key="question" icon="MessageCircleQuestion" color={colors.statusWarning} text={t("Needs you")} />);
  if (waiting) items.push(<Signal key="waiting" icon="Hourglass" text={t("Waiting on {waiting}", { waiting })} />);
  if (!available && wrapped)
    items.push(<Signal key="wrapped" icon="CircleCheck" text={t("Wrapped up")} />);
  else if (!available)
    items.push(<Signal key="ws" icon="TriangleAlert" color={colors.statusWarning} text={t("Workspace unavailable")} />);
  else if (summaryState === "loading")
    items.push(<Signal key="load" icon="Loader" text={t("Loading…")} />);
  else if (summaryState === "unavailable")
    items.push(<Signal key="na" icon="CircleHelp" text={t("Session state unavailable")} />);
  else if (summary) {
    if (summary.permissions)
      items.push(<Signal key="perm" color={colors.statusWarning} text={tn(summary.permissions, "{n} approval", "{n} approvals")} />);
    if (summary.errors)
      items.push(<Signal key="err" color={colors.statusDanger} text={tn(summary.errors, "{n} error", "{n} errors")} />);
    if (summary.running || summary.starting)
      items.push(
        <Signal
          key="run"
          pulse
          color={colors.accent}
          text={summary.starting && !summary.running ? t("{n} starting", { n: summary.starting }) : t("{n} running", { n: summary.running + summary.starting })}
        />,
      );
    // A session with an open question is already shown as "Needs you".
    const unread = Math.max(0, summary.unread - questions);
    if (unread)
      items.push(<Signal key="unread" color={colors.statusSuccess} text={t("{n} unread", { n: unread })} />);
    if (!items.length && summary.total)
      items.push(<Signal key="total" icon="MessageSquare" text={`${summary.total}`} />);
    if (summaryState === "stale")
      items.push(<Signal key="stale" icon="Clock" text={t("Last known")} />);
  } else if (sessions)
    items.push(<Signal key="fallback" icon="MessageSquare" text={running ? t("{running}/{sessions} running", { running, sessions }) : `${sessions}`} />);
  const priority = task.priority !== "normal";
  const accent = priorityAccent(colors, task.priority);
  const tags = task.tags || [];
  if (!task.type && !priority && !tags.length && !items.length && !ideas && !legacy && !task.archivedAt) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space[3], rowGap: space[1] }}>
      {(!!task.type || priority) && (
        // Tags share one pill shape; Urgent/High keep their emphasis colour.
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
          {priority && (
            <Tag
              label={t("{priority} priority", { priority: priorityLabels[task.priority] })}
              icon={<PriorityIcon priority={task.priority} size={12} />}
              text={priorityLabels[task.priority]}
              accent={accent}
            />
          )}
          {!!task.type && (
            <Tag label={t("Type: {type}", { type: taskTypeLabels[task.type] })} icon={<TypeIcon type={task.type} size={12} />} text={taskTypeLabels[task.type]} />
          )}
        </View>
      )}
      {!!tags.length && (
        // Custom tags (CARD-TAGS-SPEC §6.2): the first two, then a count.
        <View
          accessibilityLabel={t("Tags: {tags}", { tags: tags.map((x) => x.tag).join(", ") })}
          style={{ flexDirection: "row", alignItems: "center", gap: space[1], flexShrink: 1, minWidth: 0 }}
        >
          {tags.slice(0, 2).map((x) => (
            <TagChip key={x.tag} text={x.tag} />
          ))}
          {tags.length > 2 && <Label size={font.xs} muted selectable={false}>{`+${tags.length - 2}`}</Label>}
        </View>
      )}
      {items}
      {!!ideas && <Signal icon="Lightbulb" color={colors.statusWarning} text={`${ideas}`} />}
      {!!task.archivedAt && <Badge>{t("Archived")}</Badge>}
      {legacy && <Badge>{t("Legacy")}</Badge>}
    </View>
  );
}

/** A neutral `#tag` chip, smaller than the priority/type pills. */
function TagChip({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ height: 18, paddingHorizontal: 5, justifyContent: "center", borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, flexShrink: 1, minWidth: 0 }}>
      <Label size={font.xs} muted lines={1} selectable={false}>{`#${text}`}</Label>
    </View>
  );
}

function Tag({ label, icon, text, accent }: { label: string; icon: ReactNode; text: string; accent?: string | null }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        height: 20,
        paddingLeft: 5,
        paddingRight: 7,
        borderRadius: radius.md,
        backgroundColor: tint(accent || colors.foregroundMuted, accent ? 0.14 : 0.1),
      }}
    >
      {icon}
      <Label size={font.xs} bold={!!accent} muted={!accent} color={accent || undefined} selectable={false}>
        {text}
      </Label>
    </View>
  );
}
