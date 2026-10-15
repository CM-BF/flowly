import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { Task } from "../shared/model";
import { Badge, Dot, IconButton, Label, font, radius, relativeTime, space, tint, touch, useTheme } from "./ui";
import { PriorityIcon, priorityLabels } from "./status";
import type { Point } from "./geometry";
import type { SessionAttentionSummary } from "../shared/session-attention";
import { PulseDot, motionDuration, useMotionValue } from "./motion";
import { useCardOutput, type CardOutput, type OutputSession } from "./card-output";

export type CardDrag = {
  start(task: Task, point: Point): void;
  move(point: Point): void;
  end(point: Point): void;
  cancel(): void;
};

type TaskCardProps = Parameters<typeof TaskCard>[0];

/** TaskCard that loads its latest agent output while mounted. */
export function LiveTaskCard({
  outputSession,
  ...props
}: Omit<TaskCardProps, "output"> & { outputSession?: OutputSession | null }) {
  const output = useCardOutput(props.available ? outputSession : null);
  return <TaskCard {...props} output={output} />;
}

export function TaskCard({
  task,
  selected,
  legacy,
  available,
  running,
  sessions,
  summary,
  summaryState = "ready",
  output,
  questions = 0,
  flash = false,
  dragging,
  disabled,
  drag,
  onOpen,
  onActions,
}: {
  task: Task;
  selected: boolean;
  legacy: boolean;
  available: boolean;
  running: number;
  sessions: number;
  summary?: SessionAttentionSummary;
  summaryState?: "ready" | "loading" | "stale" | "unavailable";
  output?: CardOutput | null;
  /** Open agent questions awaiting the user's reply. */
  questions?: number;
  /** Briefly emphasize a card whose status just changed (often an automatic move). */
  flash?: boolean;
  dragging?: boolean;
  disabled?: boolean;
  drag?: CardDrag;
  onOpen(): void;
  onActions(): void;
}) {
  const { colors } = useTheme();
  const outputTime = output ? relativeTime(output.at) : "";
  const opacity = useMotionValue(dragging ? 0.45 : 1, undefined, 0.65);
  const [hovered, setHovered] = useState(false),
    [focused, setFocused] = useState(false);
  // Quick in, slow out: noticeable without holding attention.
  const flashOpacity = useMotionValue(flash ? 1 : 0, flash ? motionDuration.forward : 900);
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
  const pan = useRef(
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
  ).current;
  const signals = summaryState === "ready" || summaryState === "stale" ? summary : undefined;
  const showActions = !drag || hovered || selected;
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
          `Open task ${task.title}`,
          questions ? `Needs you: ${questions} open question${questions === 1 ? "" : "s"}` : "",
          `${priorityLabels[task.priority]} priority${task.archivedAt ? ", archived" : ""}${legacy ? ", legacy scope" : ""}`,
          summaryState === "ready" && summary
            ? `${summary.running} running, ${summary.finished} finished turns, ${summary.unread} unread sessions, ${summary.attention} need attention`
            : "",
          output ? `Latest agent output${outputTime ? ` ${outputTime}` : ""}: ${output.text.length > 80 ? output.text.slice(0, 80) + "…" : output.text}` : "",
        ]
          .filter(Boolean)
          .join(". ") + "."}
        accessibilityHint={
          drag
            ? "Drag this card with the mouse or open task actions to change status."
            : "Open details and agent sessions."
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
        {output && <OutputLine output={output} time={outputTime} />}
        <CardSignals
          task={task}
          legacy={legacy}
          available={available}
          summary={signals}
          summaryState={summaryState}
          running={running}
          sessions={sessions}
          questions={questions}
        />
      </Pressable>
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
          label={`Actions for ${task.title}`}
          onPress={onActions}
        />
      </View>
    </Animated.View>
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
  summary,
  summaryState,
  running,
  sessions,
  questions,
}: {
  task: Task;
  legacy: boolean;
  available: boolean;
  summary?: SessionAttentionSummary;
  summaryState: "ready" | "loading" | "stale" | "unavailable";
  running: number;
  sessions: number;
  questions: number;
}) {
  const { colors } = useTheme();
  const items: ReactNode[] = [];
  if (questions)
    items.push(<Signal key="question" icon="MessageCircleQuestion" color={colors.statusWarning} text="Needs you" />);
  if (!available)
    items.push(<Signal key="ws" icon="TriangleAlert" color={colors.statusWarning} text="Workspace unavailable" />);
  else if (summaryState === "loading")
    items.push(<Signal key="load" icon="Loader" text="Loading…" />);
  else if (summaryState === "unavailable")
    items.push(<Signal key="na" icon="CircleHelp" text="Session state unavailable" />);
  else if (summary) {
    if (summary.permissions)
      items.push(<Signal key="perm" color={colors.statusWarning} text={`${summary.permissions} approval`} />);
    if (summary.errors)
      items.push(<Signal key="err" color={colors.statusDanger} text={`${summary.errors} error`} />);
    if (summary.running || summary.starting)
      items.push(
        <Signal
          key="run"
          pulse
          color={colors.accent}
          text={summary.starting && !summary.running ? `${summary.starting} starting` : `${summary.running + summary.starting} running`}
        />,
      );
    // A session with an open question is already shown as "Needs you".
    const unread = Math.max(0, summary.unread - questions);
    if (unread)
      items.push(<Signal key="unread" color={colors.statusSuccess} text={`${unread} unread`} />);
    if (!items.length && summary.total)
      items.push(<Signal key="total" icon="MessageSquare" text={`${summary.total}`} />);
    if (summaryState === "stale")
      items.push(<Signal key="stale" icon="Clock" text="Last known" />);
  } else if (sessions)
    items.push(<Signal key="fallback" icon="MessageSquare" text={running ? `${running}/${sessions} running` : `${sessions}`} />);
  const priority = task.priority !== "normal";
  if (!priority && !items.length && !legacy && !task.archivedAt) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space[3], rowGap: space[1] }}>
      {priority && (
        <View accessibilityLabel={`${priorityLabels[task.priority]} priority`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <PriorityIcon priority={task.priority} size={13} />
          {task.priority === "urgent" && (
            <Label size={font.sm} color={colors.statusDanger} selectable={false}>
              Urgent
            </Label>
          )}
        </View>
      )}
      {items}
      {!!task.archivedAt && <Badge>Archived</Badge>}
      {legacy && <Badge>Legacy</Badge>}
    </View>
  );
}
