import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, View, type ScrollView as NativeScrollView } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { Status, Task } from "../shared/model";
import { statusLabels } from "../shared/model";
import { IconButton, Label, font, radius, space, useTheme, verticalScroll, verticalContent } from "./ui";
import { StatusIcon } from "./status";
import type { CardDrag } from "./card";
import { useMotionPresence, useMotionValue } from "./motion";
import {
  columnAtPoint,
  columnGap,
  columnWidth,
  dropUpdate,
  edgeScroll,
  type ColumnBounds,
  type Point,
  type Rect,
} from "./geometry";

type DragState = { task: Task; point: Point; target: Status | null; sequence: number };

function LaneAccent({ active }: { active: boolean }) {
  const { colors } = useTheme();
  const opacity = useMotionValue(active ? 1 : 0);
  return <Animated.View pointerEvents="none" style={{
    position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
    borderWidth: 1.5, borderRadius: radius.xl, borderColor: colors.accent, opacity,
  }} />;
}
export function DesktopColumns({
  statuses,
  tasks,
  disabled,
  cancelKey,
  renderCard,
  onAdd,
  onDrop,
}: {
  statuses: Status[];
  tasks: Task[];
  disabled: boolean;
  cancelKey: string;
  renderCard(task: Task, drag: CardDrag, dragging: boolean): ReactNode;
  onAdd(status: Status): void;
  onDrop(input: { id: string; revision: number; status: Status }): void;
}) {
  const { colors } = useTheme();
  const viewportRef = useRef<View>(null),
    scrollRef = useRef<NativeScrollView>(null);
  const viewport = useRef<Rect>({ x: 0, y: 0, width: 0, height: 0 });
  const columns = useRef<ColumnBounds[]>([]),
    offset = useRef(0),
    contentWidth = useRef(0);
  const live = useRef<DragState | null>(null);
  const sequence = useRef(0);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const ghost = useMotionPresence(dragging, dragging ? `${dragging.task.id}|${dragging.sequence}` : "");
  const cancel = () => {
    live.current = null;
    setDragging(null);
  };
  const current = useRef({ disabled, onDrop });
  current.current = { disabled, onDrop };
  const target = (point: Point) =>
    columnAtPoint(
      point,
      viewport.current,
      offset.current,
      columns.current.filter((c) => statuses.includes(c.status)),
    );
  const move = (point: Point) => {
    if (!live.current) return;
    const next = { ...live.current, point, target: target(point) };
    live.current = next;
    setDragging(next);
  };
  const drag: CardDrag = {
    start(task, point) {
      if (current.current.disabled || task.archivedAt) return;
      live.current = { task: { ...task }, point, target: target(point), sequence: ++sequence.current };
      setDragging(live.current);
      viewportRef.current?.measureInWindow((x, y, width, height) => {
        viewport.current = { x, y, width, height };
        if (live.current) move(live.current.point);
      });
    },
    move,
    end(point) {
      const snapshot = live.current;
      cancel();
      if (!snapshot || current.current.disabled) return;
      const input = dropUpdate(snapshot.task, target(point));
      if (input) current.current.onDrop(input);
    },
    cancel,
  };
  useEffect(() => {
    cancel();
  }, [cancelKey, disabled]);
  useEffect(() => {
    if (!dragging) return;
    const timer = setInterval(() => {
      const active = live.current;
      if (!active) return;
      const next = edgeScroll(
        active.point,
        viewport.current,
        offset.current,
        contentWidth.current,
      );
      if (next !== offset.current) {
        offset.current = next;
        scrollRef.current?.scrollTo({ x: next, animated: false });
        move(active.point);
      }
    }, 40);
    return () => clearInterval(timer);
  }, [!!dragging]);
  useEffect(
    () => () => {
      live.current = null;
    },
    [],
  );
  return (
    <View
      ref={viewportRef}
      style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      onLayout={() => {
        cancel();
        viewportRef.current?.measureInWindow((x, y, width, height) => {
          viewport.current = { x, y, width, height };
        });
      }}
    >
      <ScrollView
        ref={scrollRef}
        horizontal
        style={{ flex: 1, minHeight: 0 }}
        scrollEnabled={!dragging}
        scrollEventThrottle={16}
        onScroll={(e) => {
          offset.current = e.nativeEvent.contentOffset.x;
          if (live.current) move(live.current.point);
        }}
        onContentSizeChange={(width) => {
          contentWidth.current = width;
        }}
        contentContainerStyle={{
          padding: space[3],
          paddingTop: space[2],
          gap: columnGap,
          alignItems: "stretch",
        }}
      >
        {statuses.map((status) => {
          const column = tasks
            .filter((t) => t.status === status)
            .sort(
              (a, b) =>
                a.position - b.position ||
                a.createdAt.localeCompare(b.createdAt),
            );
          const highlighted =
            dragging?.target === status && dragging.task.status !== status;
          return (
            <View
              key={status}
              onLayout={(e) => {
                const { x, width } = e.nativeEvent.layout;
                columns.current = [
                  ...columns.current.filter((c) => c.status !== status),
                  { status, x, width },
                ];
              }}
              style={{
                width: columnWidth,
                minHeight: 0,
                borderRadius: radius.xl,
                backgroundColor: highlighted ? colors.surface2 : colors.surface1,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  paddingLeft: space[3],
                  paddingRight: space[1.5],
                  height: 44,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space[2],
                }}
              >
                <StatusIcon status={status} />
                <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
                  <Label medium size={font.md} lines={1} selectable={false}>
                    {statusLabels[status]}
                  </Label>
                  <Label muted size={font.md} selectable={false}>
                    {column.length}
                  </Label>
                </View>
                <IconButton
                  icon="Plus"
                  size={28}
                  label={`Add task to ${statusLabels[status]}`}
                  disabled={disabled}
                  onPress={() => onAdd(status)}
                />
              </View>
              <ScrollView
                {...verticalScroll}
                style={{ flex: 1, minHeight: 0 }}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{
                  ...verticalContent,
                  paddingHorizontal: space[2],
                  paddingBottom: space[4],
                  gap: space[2],
                }}
              >
                {column.map((t) =>
                  renderCard(t, drag, dragging?.task.id === t.id),
                )}
                {!column.length && !!dragging && (
                  <View
                    style={{
                      height: 72,
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: radius.lg,
                      borderWidth: 1,
                      borderStyle: "dashed",
                      borderColor: highlighted ? colors.accent : colors.border,
                    }}
                  >
                    <Label muted size={font.sm} selectable={false}>
                      {highlighted ? "Drop to move here" : "Empty"}
                    </Label>
                  </View>
                )}
              </ScrollView>
              <LaneAccent active={!!highlighted} />
            </View>
          );
        })}
      </ScrollView>
      {ghost.item && (
        <Animated.View
          testID="card-drag-motion"
          pointerEvents="none"
          style={{
            position: "absolute",
            zIndex: 20,
            opacity: ghost.progress,
            transform: [{ scale: ghost.progress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1.02] }) }],
            left: Math.max(
              4,
              Math.min(
                Math.max(4, viewport.current.width - 224),
                ghost.item.point.x - viewport.current.x + 12,
              ),
            ),
            top: Math.max(
              4,
              Math.min(
                Math.max(4, viewport.current.height - 80),
                ghost.item.point.y - viewport.current.y + 12,
              ),
            ),
            width: 220,
            paddingHorizontal: space[3],
            paddingVertical: space[2] + 2,
            gap: space[1],
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.accent,
            backgroundColor: colors.surface0,
            shadowColor: "#000",
            shadowOpacity: 0.12,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 6 },
          }}
        >
          <Label medium size={font.base} lines={2} selectable={false}>
            {ghost.item.task.title}
          </Label>
          <Label muted size={font.sm} selectable={false}>
            {ghost.item.target && ghost.item.target !== ghost.item.task.status
              ? `Move to ${statusLabels[ghost.item.target]}`
              : "Drag to another column"}
          </Label>
        </Animated.View>
      )}
    </View>
  );
}
