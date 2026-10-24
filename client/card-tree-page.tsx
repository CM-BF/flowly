import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PixelRatio, Pressable, View, type GestureResponderEvent } from "react-native";
import { FlatList, Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { AutomationJob } from "../shared/automation";
import {
  cardFlag,
  chainOf,
  nextUp,
  outlineRows,
  sameRowList,
  scopeOf,
  subtreeTotals,
  type BlockerInfo,
  type CardTree,
  type Flags,
  type Level,
  type OutlineRow,
  type Totals,
} from "../shared/card-tree";
import type { Project, Status, Task } from "../shared/model";
import { t, tn } from "../shared/i18n";
import { automationSignal, type AutomationSignal } from "./automation-view";
import { connectors, nowNextText, revealOverrides, rowLabel, stepState, totalsText, waitChips, type StepState, type WaitChip } from "./card-tree-view";
import { menuHandlers, useMenuOpener, type MenuEntry } from "./context-menu";
import { Chevron } from "./disclosure";
import { useMotionValue, useReducedMotion, useSettled, motionDuration } from "./motion";
import { perfEnd, perfStart } from "./perf";
import { useStableCallback } from "./stable";
import { StatusIcon } from "./status";
import { SignalMark } from "./task-automation";
import { Button, Choices, Label, font, noFocusRing, radius, space, tint, touch, useTheme, verticalContent, verticalScroll } from "./ui";

/** A "Show in tree" request: open the card's ancestors, scroll to it, flash it once (CARD-TREE-SPEC §2.2). */
export type TreeFocus = { id: string; key: string };

const rowMax = 960;
const stepSlot = 24;
const circle = 18;
const rowTop = 56;
// Not `typeof === "function"`: a host FlatList wrapped in memo/forwardRef is an object (client/session-transcript.tsx).
const virtualized = !!FlatList;

/**
 * The project's Card tree page (CARD-TREE-SPEC §2.2): a virtualized outline of top-level items with
 * collapsible sub-card trees, step numbers per sibling group, waits-for chips, each item's
 * Now / Next / Needs you line, and a chain highlight. Replaces the board area like Insights.
 */
export const CardTreePage = memo(function CardTreePage({
  project,
  tree,
  tasksById,
  flags,
  blockers,
  jobs,
  showArchived,
  level,
  choices,
  levelText,
  onLevel,
  onLevelsMenu,
  compact,
  active,
  selectedId,
  chain,
  onChain,
  focus,
  nameOf,
  onOpenTask,
  onBack,
  menuFor,
}: {
  project: Project;
  tree: CardTree;
  tasksById: ReadonlyMap<string, Task>;
  flags: Flags;
  blockers: ReadonlyMap<string, BlockerInfo>;
  jobs: ReadonlyMap<string, AutomationJob>;
  showArchived: boolean;
  /** The board's Levels value in effect: rows open down to it by default. */
  level: Level;
  choices: readonly { level: Level; hides: number }[];
  levelText: string;
  onLevel(level: Level): void;
  /** Compact: the same Levels menu as the board's chip. */
  onLevelsMenu(event: GestureResponderEvent): void;
  compact: boolean;
  /** False while the phone's card overlay covers the page (it stays mounted, keeping its scroll). */
  active: boolean;
  selectedId: string;
  /** The card whose chain is highlighted; the board owns it, so Esc clears it before leaving. */
  chain: string | null;
  onChain(id: string | null): void;
  focus: TreeFocus | null;
  nameOf(status: Status): string;
  onOpenTask(id: string): void;
  onBack(): void;
  menuFor(id: string): MenuEntry[];
}) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const settled = useSettled(`tree|${project.id}`);
  // Timing log: the render that mounts the outline, to its commit.
  const mountStart = settled ? perfStart() : 0;
  useEffect(() => perfEnd("tree.mount", mountStart), [settled]);
  const inScope = useMemo(() => scopeOf(tree, showArchived), [tree, showArchived]);
  // Chevron choices for this visit; changing project or Levels starts over (like Show older).
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  useEffect(() => setOverrides(new Map()), [project.id, level]);
  const chainData = useMemo(() => (chain && tree.ids.includes(chain) ? { ...chainOf(tree, chain), focus: chain } : null), [tree, chain]);
  const rowsRef = useRef<OutlineRow[] | undefined>(undefined);
  const rows = useMemo(() => {
    const start = perfStart();
    const next = outlineRows(tree, { inScope, flags, level, overrides, chain: chainData });
    perfEnd("tree.rows", start);
    return (rowsRef.current = sameRowList(rowsRef.current, next));
  }, [tree, inScope, flags, level, overrides, chainData]);
  const joins = useMemo(() => connectors(rows), [rows]);
  const totals = useMemo(() => subtreeTotals(tree, flags, inScope), [tree, flags, inScope]);
  const titleOf = (id: string) => tasksById.get(id)?.title ?? "";
  // Item status lines, built for the rows on screen only and kept until the data changes.
  const lines = useMemo(() => new Map<string, string>(), [tree, flags, inScope, tasksById, jobs]);
  const lineOf = (id: string) => {
    let line = lines.get(id);
    if (line === undefined) lines.set(id, (line = nowNextText(nextUp(tree, id, flags, inScope), titleOf, (x) => jobs.get(x)?.state === "queued")));
    return line;
  };

  // Scrolling to a card (Show in tree, a waits-for chip) once its row exists, and flashing it once.
  const [target, setTarget] = useState<{ id: string; key: string } | null>(null);
  const [flash, setFlash] = useState("");
  const list = useRef<{ scrollToIndex(o: object): void; scrollToOffset(o: object): void } | null>(null);
  const scroll = useRef<{ scrollTo(o: object): void } | null>(null);
  const offsets = useRef(new Map<string, number>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      fn();
    }, ms);
    timers.current.add(timer);
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!focus) return;
    setTarget({ id: focus.id, key: focus.key });
  }, [focus?.key]);
  useEffect(() => {
    if (!target || !settled) return;
    const index = rows.findIndex((r) => r.id === target.id);
    if (index < 0) {
      // A card the outline never shows (archived with Show archived off, or gone): drop the request.
      if (!tree.ids.includes(target.id) || !inScope(target.id)) setTarget(null);
      return;
    }
    setTarget(null);
    if (virtualized) list.current?.scrollToIndex({ index, viewPosition: 0.3, animated: !reduced });
    // The plain list knows a row's offset only after its layout, which comes after this commit for newly opened rows.
    else later(() => scroll.current?.scrollTo({ y: Math.max(0, (offsets.current.get(target.id) ?? 0) - 80), animated: !reduced }), 60);
    if (!reduced) {
      setFlash(target.id);
      later(() => setFlash((current) => (current === target.id ? "" : current)), 1600);
    }
  }, [target, rows, settled]);

  const toggle = useStableCallback((id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    setOverrides((current) => new Map(current).set(id, !row.open));
  });
  const jump = useStableCallback((id: string) => {
    setOverrides((current) => {
      const next = new Map(current);
      for (const [key, open] of revealOverrides(tree, id, flags, inScope)) next.set(key, open);
      return next;
    });
    setTarget({ id, key: `jump-${Date.now()}` });
  });
  const step = useStableCallback((id: string) => onChain(chain === id ? null : id));
  const menuOf = useStableCallback((id: string) => menuFor(id));
  const open = useStableCallback((id: string) => onOpenTask(id));

  const indent = compact ? 14 : 20;
  const renderRow = (row: OutlineRow, index: number) => {
    if (row.kind === "group") return <GroupRow row={row} onToggle={toggle} />;
    const task = tasksById.get(row.id);
    if (!task) return null;
    const flag = flags.get(row.id) ?? 0;
    const info = blockers.get(row.id);
    const chips = waitChips(tree, row.id, tasksById, !!info?.held);
    const signal = automationSignal(jobs.get(row.id), task, info);
    const kids = row.hasKids ? (tree.children.get(row.id) ?? []).filter(inScope) : [];
    const subCards = kids.length ? { done: kids.filter((k) => (flags.get(k) ?? 0) & (cardFlag.done | cardFlag.cancelled)).length, total: kids.length } : null;
    const root = row.depth === 0 && row.section !== "other";
    const sub = totals.get(row.id);
    const parent = tree.parent.get(row.id);
    const view: RowView = {
      title: task.title,
      status: task.status,
      lane: nameOf(task.status),
      signal,
      state: stepState(flag),
      subCards,
      chips,
      line: root ? lineOf(row.id) : "",
      totals: sub && (root || (row.hasKids && !row.open)) ? sub : null,
      label: rowLabel({ title: task.title, lane: nameOf(task.status), signal: signal?.text, step: row.step, steps: row.steps, parent: parent ? titleOf(parent) : undefined, waits: chips, cyclic: row.cyclic }),
    };
    return (
      <TreeRow
        row={row}
        join={joins[index]}
        view={view}
        viewKey={JSON.stringify(view)}
        root={root}
        indent={indent}
        selected={selectedId === row.id}
        flash={flash === row.id}
        onOpen={open}
        onStep={step}
        onToggle={toggle}
        onJump={jump}
        menuFor={menuOf}
      />
    );
  };
  const chainTitle = chainData ? titleOf(chainData.focus) : "";
  const levelValue = level === null ? "all" : String(level);
  const content = { ...verticalContent, paddingHorizontal: space[3], paddingBottom: space[6] * 2 };
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], paddingHorizontal: space[3], minHeight: touch ? 48 : 40, borderBottomWidth: 1, borderColor: colors.border }}>
        <Button quiet icon="ChevronLeft" label={t("Back to board (Esc)")} onPress={onBack}>
          {t("Board")}
        </Button>
        <Label bold size={font.md} lines={1} selectable={false}>
          {t("Card tree")}
        </Label>
        <View style={{ flex: 1 }} />
        {choices.length > 0 &&
          (compact ? (
            <Button quiet small icon="ListTree" label={t("Sub-card levels shown: {text}", { text: levelText })} onPress={onLevelsMenu}>
              {levelText}
            </Button>
          ) : (
            <Choices
              title={t("Levels")}
              hideTitle
              value={levelValue}
              options={choices.map((c) => ({ value: c.level === null ? "all" : String(c.level), label: c.level === null ? t("All") : String(c.level) }))}
              onChange={(value) => onLevel(value === "all" ? null : Number(value))}
            />
          ))}
      </View>
      {/* One line, same height either way: the legend, or the chain summary while a chain is highlighted. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], paddingHorizontal: space[3], height: touch ? 40 : 32, backgroundColor: chainData ? tint(colors.accent, 0.08) : "transparent" }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label muted={!chainData} size={font.sm} lines={1} selectable={false}>
            {chainData
              ? [t("Chain of {title}", { title: chainTitle }), tn(chainData.up.length + chainData.inherited.length, "{n} before", "{n} before"), tn(chainData.down.length, "{n} after", "{n} after")].join(" · ")
              : t("Same number = parallel · arrow = later step")}
          </Label>
        </View>
        {chainData && (
          <Button quiet small onPress={() => onChain(null)}>
            {t("Clear")}
          </Button>
        )}
      </View>
      {!settled ? null : !rows.length ? (
        <View style={{ padding: space[6], alignItems: "center" }}>
          <Label muted selectable={false}>{t("No tasks")}</Label>
        </View>
      ) : virtualized ? (
        <FlatList
          ref={list as never}
          {...verticalScroll}
          style={{ flex: 1, minHeight: 0 }}
          data={rows}
          extraData={[flags, tasksById, blockers, jobs, selectedId, flash, compact, joins]}
          keyExtractor={(row: OutlineRow) => row.id}
          renderItem={({ item, index }: { item: OutlineRow; index: number }) => renderRow(item, index)}
          contentContainerStyle={content}
          initialNumToRender={12}
          windowSize={7}
          keyboardShouldPersistTaps="handled"
          onScrollToIndexFailed={(info: { index: number; averageItemLength: number }) => {
            list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            later(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.3, animated: false }), 80);
          }}
        />
      ) : (
        <ScrollView ref={scroll as never} {...verticalScroll} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={content} keyboardShouldPersistTaps="handled">
          {rows.map((row, index) => (
            <View key={row.id} onLayout={(e) => offsets.current.set(row.id, e.nativeEvent.layout.y)}>
              {renderRow(row, index)}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
});

type RowView = {
  title: string;
  status: Status;
  lane: string;
  signal: AutomationSignal | null;
  state: StepState;
  subCards: { done: number; total: number } | null;
  chips: WaitChip[];
  line: string;
  totals: Totals | null;
  label: string;
};

type TreeRowProps = {
  row: OutlineRow;
  join: { above: boolean; below: boolean; arrow: boolean };
  view: RowView;
  /** `view` as text: the memo compares it instead of the fresh object. */
  viewKey: string;
  root: boolean;
  indent: number;
  selected: boolean;
  flash: boolean;
  onOpen(id: string): void;
  onStep(id: string): void;
  onToggle(id: string): void;
  onJump(id: string): void;
  menuFor(id: string): MenuEntry[];
};

const sameTreeRow = (a: TreeRowProps, b: TreeRowProps) =>
  a.row === b.row &&
  a.viewKey === b.viewKey &&
  a.join.above === b.join.above &&
  a.join.below === b.join.below &&
  a.join.arrow === b.join.arrow &&
  a.root === b.root &&
  a.indent === b.indent &&
  a.selected === b.selected &&
  a.flash === b.flash &&
  a.onOpen === b.onOpen &&
  a.menuFor === b.menuFor;

const px = (n: number) => PixelRatio.roundToNearestPixel(n);

/** One card of the outline: tree rails, the step circle and its connector, the chevron, the title and its meta line. */
const TreeRow = memo(function TreeRow({ row, join, view, root, indent, selected, flash, onOpen, onStep, onToggle, onJump, menuFor }: TreeRowProps) {
  const { colors } = useTheme();
  const openMenu = useMenuOpener();
  const opacity = useMotionValue(row.dim ? 0.45 : 1);
  const flashOpacity = useMotionValue(flash ? 1 : 0, flash ? motionDuration.forward : 900);
  const id = row.id;
  const press = useCallback(() => onOpen(id), [onOpen, id]);
  const pressStep = useCallback(() => onStep(id), [onStep, id]);
  const pressChevron = useCallback(() => onToggle(id), [onToggle, id]);
  const menu = useMemo(() => menuHandlers(openMenu, view.title, () => menuFor(id)), [openMenu, menuFor, id, view.title]);
  const left = row.depth * indent;
  const cx = left + stepSlot / 2;
  const mid = rowTop / 2;
  const line = colors.border;
  const rails: ReactNode[] = [];
  for (let k = 0; k < row.depth - 1; k++)
    if (row.rails & (1 << k)) rails.push(<View key={`rail-${k}`} style={{ position: "absolute", left: px(k * indent + indent / 2), top: 0, bottom: 0, width: 1, backgroundColor: line }} />);
  if (row.depth > 0) {
    const x = px((row.depth - 1) * indent + indent / 2);
    rails.push(<View key="elbow-v" style={{ position: "absolute", left: x, top: 0, ...(row.last ? { height: mid } : { bottom: 0 }), width: 1, backgroundColor: line }} />);
    rails.push(<View key="elbow-h" style={{ position: "absolute", left: x, top: mid, width: px(left - x), height: 1, backgroundColor: line }} />);
  }
  if (join.above) rails.push(<View key="join-up" style={{ position: "absolute", left: px(cx), top: 0, height: px(mid - circle / 2), width: 1, backgroundColor: line }} />);
  if (join.arrow)
    rails.push(
      <View
        key="arrow"
        style={{ position: "absolute", left: px(cx - 3.5), top: px(mid - circle / 2 - 4), width: 0, height: 0, borderLeftWidth: 4, borderRightWidth: 4, borderTopWidth: 4, borderLeftColor: "transparent", borderRightColor: "transparent", borderTopColor: colors.foregroundMuted }}
      />,
    );
  if (join.below) rails.push(<View key="join-down" style={{ position: "absolute", left: px(cx), top: px(mid + circle / 2), bottom: 0, width: 1, backgroundColor: line }} />);
  const filled: Partial<Record<StepState, string>> = { done: colors.statusSuccess, cancelled: colors.foregroundMuted, active: colors.accent, needs: colors.statusWarning };
  const ring: Partial<Record<StepState, string>> = { held: colors.statusWarning, waiting: colors.border, ready: colors.accent };
  const fill = filled[view.state];
  return (
    <Animated.View style={{ width: "100%", maxWidth: rowMax, alignSelf: "center", opacity }}>
      <View
        style={{
          flexDirection: "row",
          minHeight: rowTop,
          borderRadius: radius.md,
          backgroundColor: row.inChain ? tint(colors.accent, row.inherited ? 0.05 : 0.1) : selected ? colors.surface2 : "transparent",
        }}
      >
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}>
          {rails}
        </View>
        <View style={{ width: left }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Chain of {title}", { title: view.title })}
          accessibilityState={{ selected: row.inChain }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          onPress={pressStep}
          style={{ ...noFocusRing, width: stepSlot, height: rowTop, alignItems: "center", justifyContent: "center" }}
        >
          <View
            style={{
              width: circle,
              height: circle,
              borderRadius: circle / 2,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: fill ?? colors.surface0,
              borderWidth: fill ? 0 : 1.5,
              borderColor: ring[view.state] ?? colors.border,
            }}
          >
            <Label size={10} bold color={fill ? colors.surface0 : colors.foreground} selectable={false}>
              {String(row.step)}
            </Label>
          </View>
        </Pressable>
        {row.hasKids ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={row.open ? t("Hide its sub-cards") : t("Show its sub-cards")}
            accessibilityState={{ expanded: row.open }}
            hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
            onPress={pressChevron}
            style={{ ...noFocusRing, width: 22, height: rowTop, alignItems: "center", justifyContent: "center" }}
          >
            <Chevron open={row.open} title={`tree-${id}`} size={14} color={colors.foregroundMuted} />
          </Pressable>
        ) : (
          <View style={{ width: 6 }} />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={view.label}
          {...menu}
          onPress={press}
          style={({ pressed }) => ({ ...noFocusRing, flex: 1, minWidth: 0, paddingVertical: space[2], paddingRight: space[2], justifyContent: "center", gap: 3, opacity: pressed ? 0.75 : 1 })}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], minWidth: 0 }}>
            <StatusIcon status={view.status} size={root ? 15 : 13} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Label medium bold={root} size={root ? font.base : font.md} lines={2} selectable={false}>
                {view.title}
              </Label>
            </View>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space[2], rowGap: 3 }}>
            <Label muted size={font.sm} selectable={false}>{view.lane}</Label>
            {view.signal && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <SignalMark signal={view.signal} />
                <Label muted={view.signal.tone === "info"} size={font.sm} selectable={false}>{view.signal.text}</Label>
              </View>
            )}
            {view.subCards && <Label muted size={font.sm} selectable={false}>{t("Sub-cards {done}/{total}", view.subCards)}</Label>}
            {view.chips.map((chip) => (
              <WaitFor key={chip.id} chip={chip} onJump={onJump} />
            ))}
          </View>
          {view.totals && view.totals.total > 0 && (
            <View style={{ gap: 3, paddingTop: 2 }}>
              <ProgressBar totals={view.totals} />
              {!root && <Label muted size={font.xs} selectable={false}>{totalsText(view.totals)}</Label>}
            </View>
          )}
          {!!view.line && (
            <Label size={font.sm} lines={2} selectable={false}>
              {view.line}
            </Label>
          )}
        </Pressable>
        {flash && (
          <Animated.View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.accent, backgroundColor: tint(colors.accent, 0.06), opacity: flashOpacity }} />
        )}
      </View>
    </Animated.View>
  );
}, sameTreeRow);

/** A waits-for chip: pressing it opens the way to that card, scrolls to it and flashes it. */
function WaitFor({ chip, onJump }: { chip: WaitChip; onJump(id: string): void }) {
  const { colors } = useTheme();
  const press = useCallback(() => onJump(chip.id), [onJump, chip.id]);
  const warning = chip.tone === "warning";
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t("waits for {titles}", { titles: chip.text })}
      onPress={press}
      style={(state) => ({
        ...noFocusRing,
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        paddingHorizontal: space[1.5],
        height: touch ? 26 : 20,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: warning ? colors.statusWarning : colors.border,
        backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? colors.surface2 : "transparent",
        maxWidth: 260,
      })}
    >
      <Icon name="Hourglass" size={11} color={warning ? colors.statusWarning : colors.foregroundMuted} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Label size={font.xs} muted={!warning} color={warning ? colors.statusWarning : undefined} lines={1} selectable={false}>
          {chip.text}
        </Label>
      </View>
    </Pressable>
  );
}

/** The sub-tree's progress, at most five segments: done, moving, needs you, waiting or held, the rest. */
function ProgressBar({ totals }: { totals: Totals }) {
  const { colors } = useTheme();
  const parts: [number, string][] = [
    [totals.done, colors.statusSuccess],
    [totals.active, colors.accent],
    [totals.needs, colors.statusWarning],
    [totals.waiting, tint(colors.statusWarning, 0.35)],
    [totals.rest, colors.surface2],
  ];
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: "row", height: 4, borderRadius: 2, overflow: "hidden", maxWidth: 320, backgroundColor: colors.surface2 }}>
      {parts.map(([n, color], i) => (n > 0 ? <View key={i} style={{ flex: n, backgroundColor: color }} /> : null))}
    </View>
  );
}

const GroupRow = memo(function GroupRow({ row, onToggle }: { row: OutlineRow; onToggle(id: string): void }) {
  const { colors } = useTheme();
  const press = useCallback(() => onToggle(row.id), [onToggle, row.id]);
  const title = row.section === "items" ? t("Items") : row.section === "other" ? t("Other cards") : t("Finished");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title} · ${row.count}`}
      accessibilityState={{ expanded: row.open }}
      onPress={press}
      style={{ ...noFocusRing, width: "100%", maxWidth: rowMax, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: space[1.5], minHeight: touch ? 44 : 36, paddingTop: space[2] }}
    >
      <Chevron open={row.open} title={`tree-${row.id}`} size={14} color={colors.foregroundMuted} />
      <Label bold size={font.sm} muted selectable={false}>{`${title} · ${row.count}`}</Label>
    </Pressable>
  );
});
