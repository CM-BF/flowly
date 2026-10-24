import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PixelRatio, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { cardTreeOf, isHeld } from "../shared/card-tree";
import { laneName } from "../shared/lanes";
import type { Project, Task } from "../shared/model";
import { t, tn } from "../shared/i18n";
import { dependencySummary, dependencyView, type Neighbour } from "./card-tree-view";
import { Section, type SectionState } from "./disclosure";
import { neighbourhoodLayout, type NeighbourSlot, type Span } from "./geometry";
import { perfEnd, perfStart } from "./perf";
import { boardKey, useBoardQuery } from "./queries";
import { StatusIcon } from "./status";
import { Button, IconButton, Label, font, message, noFocusRing, radius, space, tint, touch, useTheme } from "./ui";

const nodeH = touch ? 44 : 40;
const gap = 8;
const edgeW = 16;
/** The stacked map's "Waits for" / "Blocks" caption row (CARD-TREE-SPEC §2.6). */
const captionH = 18;
const px = (n: number) => PixelRatio.roundToNearestPixel(n);

/**
 * Drawer "Dependencies" (CARD-TREE-SPEC §2.6): the parent path, a small map "Waits for | This card |
 * Blocks", the further unfinished blockers, the sub-cards in step order, and the links that hold a
 * queued card. Shown only when the card has a parent, sub-cards or blocks links. The header renders at
 * once and the map's height is reserved from its node counts; nodes and lines mount once the drawer has
 * settled (`ready`), so nothing below this section moves.
 */
export const TaskDependencies = memo(function TaskDependencies({
  task,
  project,
  ready,
  vertical,
  disabled,
  section,
  onOpenTask,
  onShowInTree,
}: {
  task: Task;
  project: Project;
  /** The drawer's open transition is over. */
  ready: boolean;
  /** Stacked map: compact layouts and narrow sidebars. */
  vertical: boolean;
  disabled: boolean;
  section: SectionState;
  onOpenTask(id: string): void;
  onShowInTree?(id: string): void;
}) {
  const { colors } = useTheme();
  const board = useBoardQuery();
  const toast = useToast();
  const queryClient = useQueryClient();
  const deleteLink = useRpc(rpc.deleteLink);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const data = board.data;
  const derived = useMemo(() => {
    if (!data) return null;
    const tree = cardTreeOf(data, task.projectId);
    const tasksById = new Map(data.tasks.filter((x) => x.projectId === task.projectId).map((x) => [x.id, x] as const));
    const held = isHeld(tree, tasksById, data.automation.find((j) => j.taskId === task.id));
    const view = dependencyView(tree, task.id, tasksById, held);
    return view && { tree, tasksById, view };
  }, [data, task.id, task.projectId]);
  const start = ready ? perfStart() : 0;
  useEffect(() => perfEnd("drawer.deps.mount", start), [ready]);
  if (!derived) return null;
  const { view, tasksById } = derived;
  const titleOf = (id: string) => tasksById.get(id)?.title ?? "";
  const holding = view.holding.filter((id) => !removing.has(id));
  const removeHold = async (blocker: string) => {
    const link = data?.links.find((l) => l.kind === "blocks" && l.from === blocker && l.to === task.id);
    if (!link) return;
    setRemoving((current) => new Set(current).add(blocker));
    try {
      await deleteLink({ id: link.id });
      await queryClient.invalidateQueries({ queryKey: boardKey });
    } catch (e) {
      toast.show(message(e), { variant: "error" });
    } finally {
      setRemoving((current) => {
        const next = new Set(current);
        next.delete(blocker);
        return next;
      });
    }
  };
  const more = onShowInTree ? () => onShowInTree(task.id) : undefined;
  const hasMap = view.left.length > 0 || view.right.length > 0;
  return (
    <Section id={task.id} title={t("Dependencies")} open={section.open} onToggle={section.onToggle} summary={dependencySummary(view)}>
      {view.path.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 4, rowGap: 2 }}>
          <Icon name="CornerLeftUp" size={13} color={colors.foregroundMuted} />
          <Label muted size={font.sm} selectable={false}>{t("Sub-card of")}</Label>
          {view.path.map((id, i) => (
            <PathPart key={id} id={id} title={titleOf(id)} last={i === view.path.length - 1} onOpen={onOpenTask} />
          ))}
        </View>
      )}
      {hasMap && (
        <NeighbourMap
          left={view.left}
          right={view.right}
          self={task}
          vertical={vertical}
          ready={ready}
          titleOf={titleOf}
          laneOf={(id) => {
            const other = tasksById.get(id);
            return other ? (other.archivedAt ? t("Archived") : laneName(project, other.status)) : "";
          }}
          onOpen={onOpenTask}
          onMore={more}
        />
      )}
      {view.upstream > 0 && (
        <Pressable
          accessibilityRole="button"
          disabled={!more}
          onPress={more}
          style={({ pressed }) => ({ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: space[1.5], minHeight: touch ? 40 : 28, opacity: pressed ? 0.7 : 1 })}
        >
          <Icon name="ChevronsUp" size={13} color={colors.foregroundMuted} />
          <Label muted size={font.sm} selectable={false}>{tn(view.upstream, "{n} more upstream", "{n} more upstream")}</Label>
        </Pressable>
      )}
      {view.strip.length > 0 && (
        <View style={{ gap: 4 }}>
          <Label muted size={font.xs} bold selectable={false}>{t("Sub-cards")}</Label>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 4, rowGap: 4 }}>
            {view.strip.map((item, i) => (
              <StripChip key={item.id} id={item.id} step={item.step} steps={view.strip[view.strip.length - 1].step} title={titleOf(item.id)} status={tasksById.get(item.id)?.status} arrow={i > 0 && item.step > view.strip[i - 1].step} onOpen={onOpenTask} />
            ))}
          </View>
        </View>
      )}
      {holding.map((id) => (
        <View key={id} style={{ flexDirection: "row", alignItems: "center", gap: space[2], padding: space[2], borderRadius: radius.md, borderWidth: 1, borderColor: colors.statusWarning, backgroundColor: tint(colors.statusWarning, 0.06) }}>
          <Icon name="CirclePause" size={14} color={colors.statusWarning} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label size={font.md} lines={1} selectable={false}>{t("Held by {title}", { title: titleOf(id) })}</Label>
            <Label muted size={font.sm} selectable={false}>{t("Holds this card until the link is removed")}</Label>
          </View>
          <IconButton icon="X" size={touch ? 36 : 24} label={t("Remove link: {group} {title}", { group: t("Waiting on"), title: titleOf(id) })} disabled={disabled} onPress={() => void removeHold(id)} />
        </View>
      ))}
      {more && (
        <View style={{ flexDirection: "row" }}>
          <Button quiet small icon="Workflow" onPress={more}>
            {t("Show in tree")}
          </Button>
        </View>
      )}
    </Section>
  );
});

function PathPart({ id, title, last, onOpen }: { id: string; title: string; last: boolean; onOpen(id: string): void }) {
  const { colors } = useTheme();
  const press = useCallback(() => onOpen(id), [onOpen, id]);
  return (
    <>
      <Pressable accessibilityRole="link" accessibilityLabel={t("Open task {title}", { title })} onPress={press} style={({ pressed }) => ({ ...noFocusRing, flexShrink: 1, opacity: pressed ? 0.7 : 1 })}>
        <Label size={font.sm} color={colors.accent} lines={1} selectable={false}>{title}</Label>
      </Pressable>
      {!last && <Label muted size={font.sm} selectable={false}>›</Label>}
    </>
  );
}

function StripChip({ id, step, steps, title, status, arrow, onOpen }: { id: string; step: number; steps: number; title: string; status?: Task["status"]; arrow: boolean; onOpen(id: string): void }) {
  const { colors } = useTheme();
  const press = useCallback(() => onOpen(id), [onOpen, id]);
  return (
    <>
      {arrow && <Icon name="ArrowRight" size={11} color={colors.foregroundMuted} />}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${t("Step {step} of {total}", { step, total: steps })}, ${t("Open task {title}", { title })}`}
        onPress={press}
        style={(state) => ({
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          maxWidth: 200,
          height: touch ? 32 : 24,
          paddingHorizontal: space[1.5],
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: (state as { hovered?: boolean }).hovered || state.pressed ? colors.surface2 : "transparent",
        })}
      >
        <Label size={font.xs} bold muted selectable={false}>{String(step)}</Label>
        {status && <StatusIcon status={status} size={11} />}
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <Label size={font.sm} lines={1} selectable={false}>{title}</Label>
        </View>
      </Pressable>
    </>
  );
}

/**
 * "Waits for | This card | Blocks": positions from `neighbourhoodLayout()`, lines as 1 px Views. The
 * box has its final height before the nodes mount.
 */
function NeighbourMap({
  left,
  right,
  self,
  vertical,
  ready,
  titleOf,
  laneOf,
  onOpen,
  onMore,
}: {
  left: Neighbour[];
  right: Neighbour[];
  self: Task;
  vertical: boolean;
  ready: boolean;
  titleOf(id: string): string;
  laneOf(id: string): string;
  onOpen(id: string): void;
  onMore?(): void;
}) {
  const { colors } = useTheme();
  const layout = neighbourhoodLayout(left.length, right.length, nodeH, gap, { vertical, caption: captionH });
  const waitsFor = t("Waits for");
  const blocksText = t("Blocks");
  const tone = (n: Neighbour | undefined) => (!n ? colors.foregroundMuted : n.state === "done" ? tint(colors.statusSuccess, 0.6) : n.state === "stuck" ? colors.statusWarning : colors.foregroundMuted);
  // Each node's label names its relation, so a screen reader knows which side it is on in either layout.
  const node = (slot: NeighbourSlot, n: Neighbour | undefined, key: string, relation: string, style: object) =>
    slot.more ? (
      <MoreNode key={key} count={slot.more} relation={relation} style={{ ...style, top: slot.y }} onPress={onMore} />
    ) : n ? (
      <MapNode key={key} id={n.id} title={titleOf(n.id)} lane={laneOf(n.id)} state={n.state} relation={relation} style={{ ...style, top: slot.y }} onOpen={onOpen} />
    ) : null;
  const centre = (style: object) => <MapNode key="self" id={self.id} title={self.title} lane={laneOf(self.id)} state="self" relation={t("This card")} style={{ ...style, top: layout.centre }} />;
  const caption = (key: string, text: string, top: number | null) =>
    top === null ? null : (
      <View key={key} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", left: 24, right: 0, top, height: captionH, justifyContent: "flex-start" }}>
        <Label muted size={font.xs} bold lines={1} selectable={false}>{text}</Label>
      </View>
    );
  const lines: ReactNode[] = [];
  const arrow = (key: string, x: number, y: number, dir: "right" | "down", color: string) =>
    lines.push(
      <View
        key={key}
        style={
          dir === "right"
            ? { position: "absolute", left: px(x - 4), top: px(y - 4), width: 0, height: 0, borderTopWidth: 4, borderBottomWidth: 4, borderLeftWidth: 4, borderTopColor: "transparent", borderBottomColor: "transparent", borderLeftColor: color }
            : { position: "absolute", left: px(x - 4), top: px(y - 4), width: 0, height: 0, borderLeftWidth: 4, borderRightWidth: 4, borderTopWidth: 4, borderLeftColor: "transparent", borderRightColor: "transparent", borderTopColor: color }
        }
      />,
    );
  const vline = (key: string, x: number, span: Span, color: string) =>
    lines.push(<View key={key} style={{ position: "absolute", left: px(x), top: px(span.top), height: px(span.bottom - span.top), width: 1, backgroundColor: color }} />);
  const hline = (key: string, x: number, width: number, y: number, color: string) =>
    lines.push(<View key={key} style={{ position: "absolute", left: px(x), top: px(y), width: px(width), height: 1, backgroundColor: color }} />);
  const mid = layout.centre + nodeH / 2;
  if (layout.vertical) {
    // One rail on the left: blockers above, this card, blocked cards below.
    const railX = 6;
    if (layout.rail) vline("rail", railX, layout.rail, colors.border);
    layout.left.forEach((slot, i) => hline(`l${i}`, railX, 10, slot.y + nodeH / 2, tone(left[i])));
    arrow("in", railX + 14, mid, "right", colors.foregroundMuted);
    hline("c", railX, 10, mid, colors.foregroundMuted);
    layout.right.forEach((slot, i) => {
      hline(`r${i}`, railX, 10, slot.y + nodeH / 2, tone(right[i]));
      arrow(`ra${i}`, railX + 14, slot.y + nodeH / 2, "right", tone(right[i]));
    });
  }
  return (
    <View style={{ gap: 4 }}>
      {!layout.vertical && (
        <View style={{ flexDirection: "row" }}>
          <View style={{ flex: 1 }}><Label muted size={font.xs} bold selectable={false}>{waitsFor}</Label></View>
          <View style={{ width: edgeW }} />
          <View style={{ flex: 1, alignItems: "center" }}><Label muted size={font.xs} bold selectable={false}>{t("This card")}</Label></View>
          <View style={{ width: edgeW }} />
          <View style={{ flex: 1, alignItems: "flex-end" }}><Label muted size={font.xs} bold selectable={false}>{blocksText}</Label></View>
        </View>
      )}
      {/* The height is known from the counts, so it is reserved before anything inside mounts. */}
      <View style={{ height: layout.height }}>
        {ready &&
          (layout.vertical ? (
            <>
              <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: 24 }}>
                {lines}
              </View>
              {caption("waits-caption", waitsFor, layout.captions.left)}
              {layout.left.map((slot, i) => node(slot, left[i], `l${i}`, waitsFor, { position: "absolute", left: 24, right: 0 }))}
              {centre({ position: "absolute", left: 24, right: 0 })}
              {caption("blocks-caption", blocksText, layout.captions.right)}
              {layout.right.map((slot, i) => node(slot, right[i], `r${i}`, blocksText, { position: "absolute", left: 24, right: 0 }))}
            </>
          ) : (
            <View style={{ flexDirection: "row", height: layout.height }}>
              <View style={{ flex: 1 }}>{layout.left.map((slot, i) => node(slot, left[i], `l${i}`, waitsFor, { position: "absolute", left: 0, right: 0 }))}</View>
              <Edges side="left" slots={layout.left} bus={layout.leftBus} mid={mid} tones={layout.left.map((_, i) => tone(left[i]))} />
              <View style={{ flex: 1 }}>{centre({ position: "absolute", left: 0, right: 0 })}</View>
              <Edges side="right" slots={layout.right} bus={layout.rightBus} mid={mid} tones={layout.right.map((_, i) => tone(right[i]))} />
              <View style={{ flex: 1 }}>{layout.right.map((slot, i) => node(slot, right[i], `r${i}`, blocksText, { position: "absolute", left: 0, right: 0 }))}</View>
            </View>
          ))}
      </View>
    </View>
  );
}

/** The 16 pt gutter between two columns: a stub per node, a bus, a stub to the middle node, an arrowhead toward the later card. */
function Edges({ side, slots, bus, mid, tones }: { side: "left" | "right"; slots: NeighbourSlot[]; bus: Span | null; mid: number; tones: string[] }) {
  const { colors } = useTheme();
  const half = edgeW / 2;
  const muted = colors.foregroundMuted;
  const head = (key: string, y: number, color: string) => (
    <View key={key} style={{ position: "absolute", left: edgeW - 4, top: px(y - 4), width: 0, height: 0, borderTopWidth: 4, borderBottomWidth: 4, borderLeftWidth: 4, borderTopColor: "transparent", borderBottomColor: "transparent", borderLeftColor: color }} />
  );
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: edgeW }}>
      {bus && <View style={{ position: "absolute", left: half, top: px(bus.top), height: px(Math.max(1, bus.bottom - bus.top)), width: 1, backgroundColor: colors.border }} />}
      {slots.map((slot, i) => (
        <View key={`s${i}`} style={{ position: "absolute", left: side === "left" ? 0 : half, top: px(slot.y + nodeH / 2), width: half, height: 1, backgroundColor: tones[i] }} />
      ))}
      {bus && <View style={{ position: "absolute", left: side === "left" ? half : 0, top: px(mid), width: half, height: 1, backgroundColor: muted }} />}
      {bus && side === "left" && head("head", mid, muted)}
      {side === "right" && slots.map((slot, i) => head(`h${i}`, slot.y + nodeH / 2, tones[i]))}
    </View>
  );
}

function MapNode({ id, title, lane, state, relation, style, onOpen }: { id: string; title: string; lane: string; state: Neighbour["state"] | "self"; relation: string; style: object; onOpen?(id: string): void }) {
  const { colors } = useTheme();
  const press = useCallback(() => onOpen?.(id), [onOpen, id]);
  const dot = state === "done" ? colors.statusSuccess : state === "stuck" ? colors.statusWarning : state === "self" ? colors.accent : colors.foregroundMuted;
  const body = (
    <>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dot }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.sm} medium={state === "self"} lines={1} selectable={false}>{title}</Label>
        <Label muted size={font.xs} lines={1} selectable={false}>{lane}</Label>
      </View>
    </>
  );
  const frame = {
    ...style,
    height: nodeH,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingHorizontal: space[2],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: state === "self" ? colors.accent : state === "stuck" ? colors.statusWarning : colors.border,
    backgroundColor: colors.surface0,
  };
  if (state === "self") return <View accessible accessibilityLabel={`${relation}: ${title}`} style={frame}>{body}</View>;
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`${relation}: ${t("Open task {title}", { title })}, ${lane}`} onPress={press} style={(s) => ({ ...noFocusRing, ...frame, backgroundColor: (s as { hovered?: boolean }).hovered || s.pressed ? colors.surface2 : colors.surface0 })}>
      {body}
    </Pressable>
  );
}

function MoreNode({ count, relation, style, onPress }: { count: number; relation: string; style: object; onPress?(): void }) {
  const { colors } = useTheme();
  const text = tn(count, "+{n} more", "+{n} more");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${relation}: ${text}`}
      disabled={!onPress}
      onPress={onPress}
      style={{ ...noFocusRing, ...style, height: nodeH, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border }}
    >
      <Label muted size={font.sm} selectable={false}>{text}</Label>
    </Pressable>
  );
}
