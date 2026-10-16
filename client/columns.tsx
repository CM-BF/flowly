import { useEffect, useRef, useState, type ReactNode } from "react";
import { sortTasks } from "../shared/sort";
import { Animated, Pressable, View, type ScrollView as NativeScrollView } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import type { Status, Task } from "../shared/model";
import { statusLabels } from "../shared/model";
import { IconButton, Label, font, noFocusRing, radius, space, touch, useTheme, verticalScroll, verticalContent } from "./ui";
import { menuHandlers, useMenuOpener } from "./context-menu";
import { StatusIcon } from "./status";
import type { CardDrag } from "./card";
import { Enter, motionDuration, useMotionPresence, useMotionValue, lerp } from "./motion";
import {
  columnAtPoint,
  columnGap,
  columnWidth,
  contentY,
  dropSlot,
  edgeScroll,
  placementUpdate,
  type ColumnBounds,
  type DropSlot,
  type Point,
  type Rect,
} from "./geometry";
import { t, tn } from "../shared/i18n";

type DragState = { task: Task; point: Point; target: Status | null; slot: DropSlot | null; sequence: number };
export type Placement = NonNullable<ReturnType<typeof placementUpdate>>;

/**
 * A lane's outer frame. Collapsing/expanding animates its width (JS-driven;
 * width is layout) and fades the new content in; the frame owns the layout
 * measurement used for drop targeting.
 */
function LaneFrame({ status, collapsed, onLayout, frameRef, children }: { status: Status; collapsed: boolean; onLayout(x: number, width: number): void; frameRef(node: View | null): void; children: ReactNode }) {
  const { colors } = useTheme();
  const open = useMotionValue(collapsed ? 0 : 1, collapsed ? motionDuration.reverse : motionDuration.forward, collapsed ? 0 : 1, true);
  return (
    <Animated.View
      ref={frameRef}
      testID={`lane-${status}`}
      onLayout={(e) => onLayout(e.nativeEvent.layout.x, e.nativeEvent.layout.width)}
      style={{
        width: lerp(open, [collapsedWidth, columnWidth]),
        minHeight: 0,
        overflow: "hidden",
        borderRadius: radius.xl,
        backgroundColor: colors.surface1,
      }}
    >
      <Enter key={collapsed ? "collapsed" : "expanded"} distance={0} style={{ flex: 1, minHeight: 0 }}>
        {children}
      </Enter>
    </Animated.View>
  );
}
const collapsedWidth = 44;

/** Insertion line positioned absolutely in the column content, so showing it never shifts cards. */
function InsertLine({ y }: { y: number | null }) {
  const { colors } = useTheme();
  const last = useRef(0);
  if (y !== null) last.current = Math.max(0, y - 1);
  const opacity = useMotionValue(y === null ? 0 : 1);
  return <Animated.View testID="card-insert-line" pointerEvents="none" style={{
    position: "absolute", left: space[2], right: space[2], top: last.current, height: 2,
    borderRadius: 1, backgroundColor: colors.accent, opacity,
  }} />;
}

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
  sortColumn = (column) => sortTasks(column, "manual"),
  manualOrder = true,
  onReorderBlocked = () => undefined,
  collapsed = [],
  onToggleCollapse,
  nameOf = (status) => statusLabels[status],
  renderCard,
  onAdd,
  onDrop,
}: {
  statuses: Status[];
  tasks: Task[];
  disabled: boolean;
  /** Orders one column for display. */
  sortColumn?(tasks: Task[]): Task[];
  /** Manual sort: drops pick a slot. Otherwise cards only change column (appended in manual order). */
  manualOrder?: boolean;
  /** A within-column drop while a non-manual sort is active. */
  onReorderBlocked?(): void;
  /** Columns shown as a narrow strip (still a drop target). */
  collapsed?: readonly Status[];
  onToggleCollapse?(status: Status): void;
  /** The project's lane name for a status. */
  nameOf?(status: Status): string;
  cancelKey: string;
  renderCard(task: Task, drag: CardDrag, dragging: boolean): ReactNode;
  onAdd(status: Status): void;
  onDrop(input: Placement): void;
}) {
  const { colors } = useTheme();
  const openMenu = useMenuOpener();
  const [hoverHeader, setHoverHeader] = useState<Status | null>(null);
  // RN-web ends a Pressable's hover while a nested Pressable is hovered, so the header buttons report their own.
  const [hoverHeaderButton, setHoverHeaderButton] = useState<string | null>(null);
  const trackHeaderButton = (key: string) => (hovered: boolean) => setHoverHeaderButton((h) => (hovered ? key : h === key ? null : h));
  const cardGap = space[2];
  const viewportRef = useRef<View>(null),
    scrollRef = useRef<NativeScrollView>(null);
  const viewport = useRef<Rect>({ x: 0, y: 0, width: 0, height: 0 });
  const columns = useRef<ColumnBounds[]>([]),
    offset = useRef(0),
    contentWidth = useRef(0);
  const cards = useRef<Record<string, { y: number; height: number }>>({}),
    order = useRef<Partial<Record<Status, string[]>>>({}),
    lists = useRef<Partial<Record<Status, View | null>>>({}),
    frames = useRef<Partial<Record<Status, View | null>>>({}),
    listTops = useRef<Partial<Record<Status, number>>>({}),
    scrollY = useRef<Partial<Record<Status, number>>>({});
  const live = useRef<DragState | null>(null);
  const sequence = useRef(0);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const ghost = useMotionPresence(dragging, dragging ? `${dragging.task.id}|${dragging.sequence}` : "");
  const cancel = () => {
    live.current = null;
    setDragging(null);
  };
  const current = useRef({ disabled, onDrop, manualOrder, onReorderBlocked });
  current.current = { disabled, onDrop, manualOrder, onReorderBlocked };
  const target = (point: Point) =>
    columnAtPoint(
      point,
      viewport.current,
      offset.current,
      columns.current.filter((c) => statuses.includes(c.status)),
    );
  const slot = (task: Task, status: Status | null, point: Point) => {
    const top = status ? listTops.current[status] : undefined;
    if (!status || top === undefined || !current.current.manualOrder) return null;
    const bounds = (order.current[status] || []).flatMap((id) =>
      cards.current[id] ? [{ id, ...cards.current[id] }] : [],
    );
    return dropSlot(contentY(point.y, top, scrollY.current[status] || 0), bounds, task.id, cardGap);
  };
  const move = (point: Point) => {
    if (!live.current) return;
    const status = target(point);
    const next = { ...live.current, point, target: status, slot: slot(live.current.task, status, point) };
    live.current = next;
    setDragging(next);
  };
  const drag: CardDrag = {
    start(task, point) {
      if (current.current.disabled || task.archivedAt) return;
      live.current = { task: { ...task }, point, target: target(point), slot: null, sequence: ++sequence.current };
      setDragging(live.current);
      listTops.current = {};
      viewportRef.current?.measureInWindow((x, y, width, height) => {
        viewport.current = { x, y, width, height };
        // Web onLayout only reports size changes, so lanes shifted by a sibling
        // collapsing/expanding keep a stale x: re-measure them for this drag.
        for (const [status, frame] of Object.entries(frames.current) as [Status, View | null][])
          frame?.measureInWindow((laneX, _laneY, laneWidth) => {
            columns.current = [
              ...columns.current.filter((c) => c.status !== status),
              { status, x: laneX - viewport.current.x + offset.current, width: laneWidth },
            ];
            if (live.current) move(live.current.point);
          });
        if (live.current) move(live.current.point);
      });
      for (const [status, list] of Object.entries(lists.current) as [Status, View | null][])
        list?.measureInWindow((_x, y) => {
          listTops.current[status] = y;
          if (live.current) move(live.current.point);
        });
    },
    move,
    end(point) {
      const snapshot = live.current;
      cancel();
      if (!snapshot || current.current.disabled) return;
      const status = target(point);
      if (!current.current.manualOrder && status === snapshot.task.status) {
        current.current.onReorderBlocked();
        return;
      }
      const input = placementUpdate(
        snapshot.task,
        status,
        slot(snapshot.task, status, point),
        status ? order.current[status] || [] : [],
      );
      if (input) current.current.onDrop(input);
    },
    cancel,
  };
  // Cards are memoized: hand them one drag object that always runs this
  // render's handlers (PERFORMANCE-SPEC §3).
  const latestDrag = useRef(drag);
  latestDrag.current = drag;
  const [stableDrag] = useState<CardDrag>(() => ({
    start: (task, point) => latestDrag.current.start(task, point),
    move: (point) => latestDrag.current.move(point),
    end: (point) => latestDrag.current.end(point),
    cancel: () => latestDrag.current.cancel(),
  }));
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
          const column = sortColumn(tasks.filter((t) => t.status === status));
          order.current[status] = column.map((t) => t.id);
          const highlighted =
            dragging?.target === status && dragging.task.status !== status;
          const line =
            dragging?.target === status &&
            placementUpdate(dragging.task, status, dragging.slot, order.current[status])
              ? (dragging.slot?.lineY ?? null)
              : null;
          const headerMenu = menuHandlers(openMenu, nameOf(status), () => [
            { id: "add", label: t("Add task"), icon: "Plus", disabled, onPress: () => onAdd(status) },
            ...(onToggleCollapse
              ? [{ id: "collapse", label: collapsed.includes(status) ? t("Expand column") : t("Collapse column"), icon: collapsed.includes(status) ? "ChevronsLeftRight" : "ChevronsRightLeft", onPress: () => onToggleCollapse(status) }]
              : []),
          ]);
          const frameRef = (node: View | null) => {
            frames.current[status] = node;
          };
          const measure = (x: number, width: number) => {
            columns.current = [...columns.current.filter((c) => c.status !== status), { status, x, width }];
          };
          if (collapsed.includes(status))
            return (
              <LaneFrame key={status} status={status} collapsed onLayout={measure} frameRef={frameRef}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tn(column.length, "Expand {lane}, {n} task", "Expand {lane}, {n} tasks", { lane: nameOf(status) })}
                onPress={() => onToggleCollapse?.(status)}
                {...headerMenu}
                style={(state) => {
                  const { hovered } = state as typeof state & { hovered?: boolean };
                  return {
                    ...noFocusRing,
                    flex: 1,
                    minHeight: 0,
                    alignItems: "center",
                    paddingTop: space[3],
                    gap: space[2],
                    borderRadius: radius.xl,
                    backgroundColor: highlighted ? colors.surface2 : hovered ? colors.surface2 : colors.surface1,
                    overflow: "hidden",
                  };
                }}
              >
                <StatusIcon status={status} />
                <Label muted size={font.sm} selectable={false}>{column.length}</Label>
                {/* Vertical title: a rotated label in a box as tall as the text is wide. */}
                <View style={{ width: 20, height: 140, alignItems: "center", justifyContent: "center" }}>
                  <View style={{ width: 140, alignItems: "center", transform: [{ rotate: "90deg" }] }}>
                    <Label medium size={font.md} lines={1} selectable={false}>{nameOf(status)}</Label>
                  </View>
                </View>
                <LaneAccent active={!!highlighted} />
              </Pressable>
              </LaneFrame>
            );
          return (
            <LaneFrame key={status} status={status} collapsed={false} onLayout={measure} frameRef={frameRef}>
            <View
              style={{
                width: columnWidth,
                flex: 1,
                minHeight: 0,
                borderRadius: radius.xl,
                backgroundColor: highlighted ? colors.surface2 : colors.surface1,
                overflow: "hidden",
              }}
            >
              <Pressable
                accessible={false}
                {...headerMenu}
                onHoverIn={() => setHoverHeader(status)}
                onHoverOut={() => setHoverHeader((h) => (h === status ? null : h))}
                style={{
                  ...noFocusRing,
                  paddingLeft: space[3],
                  paddingRight: space[1.5],
                  height: 44,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space[2],
                  ...({ cursor: "default" } as object),
                }}
              >
                <StatusIcon status={status} />
                <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
                  <Label medium size={font.md} lines={1} selectable={false}>
                    {nameOf(status)}
                  </Label>
                  <Label muted size={font.md} selectable={false}>
                    {column.length}
                  </Label>
                </View>
                {onToggleCollapse && (
                  // Always mounted (RN-web clears hover on press); revealed on header hover, always shown on touch.
                  <View style={{ opacity: touch || hoverHeader === status || hoverHeaderButton?.startsWith(`${status}:`) ? 1 : 0 }}>
                    <IconButton
                      icon="ChevronsRightLeft"
                      size={28}
                      label={t("Collapse {name}", { name: nameOf(status) })}
                      onHoverChange={trackHeaderButton(`${status}:collapse`)}
                      onPress={() => onToggleCollapse(status)}
                    />
                  </View>
                )}
                <IconButton
                  icon="Plus"
                  size={28}
                  label={t("Add task to {name}", { name: nameOf(status) })}
                  disabled={disabled}
                  onHoverChange={trackHeaderButton(`${status}:add`)}
                  onPress={() => onAdd(status)}
                />
              </Pressable>
              <View
                ref={(list) => {
                  lists.current[status] = list;
                }}
                style={{ flex: 1, minHeight: 0 }}
              >
              <ScrollView
                {...verticalScroll}
                style={{ flex: 1, minHeight: 0 }}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                scrollEventThrottle={16}
                onScroll={(e) => {
                  scrollY.current[status] = e.nativeEvent.contentOffset.y;
                  if (live.current) move(live.current.point);
                }}
                contentContainerStyle={{
                  ...verticalContent,
                  paddingHorizontal: space[2],
                  paddingBottom: space[4],
                  gap: cardGap,
                }}
              >
                {column.map((t) => (
                  <View
                    key={t.id}
                    onLayout={(e) => {
                      const { y, height } = e.nativeEvent.layout;
                      cards.current[t.id] = { y, height };
                    }}
                  >
                    {renderCard(t, stableDrag, dragging?.task.id === t.id)}
                  </View>
                ))}
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
                      {highlighted ? t("Drop to move here") : t("Empty")}
                    </Label>
                  </View>
                )}
                <InsertLine y={line} />
              </ScrollView>
              </View>
              <LaneAccent active={!!highlighted} />
            </View>
            </LaneFrame>
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
            transform: [{ scale: lerp(ghost.progress, [0.96, 1.02]) }],
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
              ? t("Move to {name}", { name: nameOf(ghost.item.target) })
              : ghost.item.target &&
                  placementUpdate(ghost.item.task, ghost.item.target, ghost.item.slot, order.current[ghost.item.target] || [])
                ? t("Reorder in {name}", { name: nameOf(ghost.item.target) })
                : t("Drag to reorder or move")}
          </Label>
        </Animated.View>
      )}
    </View>
  );
}
