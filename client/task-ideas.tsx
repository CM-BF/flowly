import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import { taskTypeLabels, type Idea } from "../shared/model";
import { continuesInCard } from "../shared/ideas";
import { eventPoint, useMenuOpener, type MenuEntry, type Point } from "./context-menu";
import { CardBody, CardField, CardHeadline, CardMeta, CardMetaRow, CardText, ContentCard } from "./content-card";
import { Disclosure, Section, type SectionState } from "./disclosure";
import { lerp, motionDuration, useMotionPresence, useReducedMotion } from "./motion";
import { exitRows } from "./idea-rows";
import { boardKey, useBoardQuery } from "./queries";
import { useStableCallback } from "./stable";
import { PriorityIcon, TypeIcon, priorityLabels } from "./status";
import { Button, Label, font, message, relativeTime, space, touch, useTheme } from "./ui";
import { t } from "../shared/i18n";

export type IdeaSession = { id: string; title?: string | null; archivedAt?: string | null };

/**
 * Drawer "Ideas": next steps agents proposed on this card (IDEAS-SPEC §5.2).
 * Renders nothing without ideas. "Good idea" offers two paths (§6): continue
 * in this card (sent to one of its sessions) or start a new card. Closing an
 * idea (Dismiss, Do it here) is optimistic: the card collapses away at once and
 * comes back with an error toast if the save fails.
 */
export function TaskIdeas({
  taskId,
  sessions,
  disabled,
  onCreate,
  onNewSession,
  onOpenTask,
  onAllIdeas,
  section,
}: {
  taskId: string;
  /** This card's sessions, newest first (archived included, for names). */
  sessions: readonly IdeaSession[];
  disabled: boolean;
  onCreate(idea: Idea): void;
  /** Opens Start session prefilled with the idea (IDEAS-SPEC §6.3). */
  onNewSession(idea: Idea): void;
  onOpenTask(id: string): void;
  /** Opens the project Ideas page showing only this card (IDEAS-INBOX-SPEC §5). */
  onAllIdeas?(): void;
  section: SectionState;
}) {
  const board = useBoardQuery();
  const [closedOpen, setClosedOpen] = useState(false);
  const actions = useIdeaActions({ sessionsOf: () => sessions, onCreate, onNewSession });
  const { hidden, restoring } = actions;
  const ideas = useMemo(() => (board.data?.ideas || []).filter((i) => i.taskId === taskId), [board.data?.ideas, taskId]);
  const open = useMemo(() => ideas.filter((i) => i.status === "open" && !hidden.has(i.id)), [ideas, hidden]);
  const closed = ideas.filter((i) => i.status !== "open" || hidden.has(i.id)).reverse();
  const rows = useExitList(open);
  if (!ideas.length) return null;
  const titleOf = (id: string) => board.data?.tasks.find((t) => t.id === id)?.title;
  return (
    <Section
      id={taskId}
      title={t("Ideas")}
      ai
      count={open.length}
      open={section.open}
      onToggle={section.onToggle}
      actions={
        onAllIdeas && (
          <Button small quiet label={t("Show this card's ideas on the project Ideas page")} onPress={onAllIdeas}>
            {t("All ideas")}</Button>
        )
      }
    >
      {rows.length ? (
        <View>
          {rows.map((row) => (
            <IdeaRow key={row.item.id} leaving={row.leaving} entering={row.entering} swipe={actions.swiped.has(row.item.id)} restored={actions.restored.has(row.item.id)}>
              <IdeaCard idea={row.item} disabled={disabled || row.leaving} onGood={actions.choose} onDismiss={actions.dismiss} />
            </IdeaRow>
          ))}
        </View>
      ) : (
        <Label muted size={font.sm}>{t("No open ideas. Agents add them when they see a worthwhile next step.")}</Label>
      )}
      {closed.length > 0 && (
        <Disclosure title={t("Closed · {n}", { n: closed.length })} open={closedOpen} onChange={setClosedOpen}>
          <View style={{ gap: space[1] }}>
            {closed.map((idea) => (
              <ClosedIdea
                key={idea.id}
                idea={idea}
                acceptedTitle={idea.acceptedTaskId ? titleOf(idea.acceptedTaskId) : undefined}
                sentTo={idea.acceptedAgentId ? sessionName(sessions, idea.acceptedAgentId) : undefined}
                disabled={disabled || !!restoring || hidden.has(idea.id)}
                onOpenTask={onOpenTask}
                onRestore={actions.restore}
              />
            ))}
          </View>
        </Disclosure>
      )}
    </Section>
  );
}

export const sessionName = (sessions: readonly IdeaSession[], id: string) => sessions.find((s) => s.id === id)?.title || t("a session");

/**
 * What both idea lists share (IDEAS-INBOX-SPEC §2.1): the Good idea menu,
 * Dismiss and Restore, with optimistic hiding. `hidden` holds ideas closed
 * here but not yet closed on the board.
 */
export function useIdeaActions({
  sessionsOf,
  onCreate,
  onNewSession,
}: {
  /** The idea's card's sessions, newest first (archived included). */
  sessionsOf(taskId: string): readonly IdeaSession[];
  onCreate(idea: Idea): void;
  onNewSession(idea: Idea): void;
}) {
  const board = useBoardQuery();
  const toast = useToast();
  const queryClient = useQueryClient();
  const openMenu = useMenuOpener();
  const updateIdea = useRpc(rpc.updateIdea);
  const adoptIdea = useRpc(rpc.adoptIdea);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [restoring, setRestoring] = useState("");
  // Ideas dismissed here on desktop: their row swipes out instead of collapsing in place.
  const swiped = useRef(new Set<string>()).current;
  // Ideas restored here: their row opens its slot and the card comes back in, even if it was on the list at first render.
  const restored = useRef(new Set<string>()).current;
  const ideas = board.data?.ideas;
  // A closing is settled once the board shows it; drop it from the optimistic set.
  useEffect(() => {
    if (!hidden.size) return;
    const settled = [...hidden].filter((id) => !ideas?.some((i) => i.id === id && i.status === "open"));
    if (settled.length) setHidden((current) => without(current, settled));
  }, [ideas, hidden]);
  const adopt = async (idea: Idea, session: IdeaSession) => {
    setHidden((current) => new Set(current).add(idea.id));
    try {
      await adoptIdea({ id: idea.id, agentId: session.id });
      await queryClient.invalidateQueries({ queryKey: boardKey });
      toast.show(t("Sent to {session}", { session: session.title || t("the session") }), { variant: "success" });
    } catch (e) {
      setHidden((current) => without(current, [idea.id]));
      toast.show(message(e), { variant: "error" });
    }
  };
  const name = (s: IdeaSession) => s.title || t("this card's session");
  /**
   * Good idea (IDEAS-SPEC §6): continue in a session of this card (the
   * proposer's by default, or another one), start a new session in this card,
   * or start a new card. The agent's suggestion leads. A finished or archived
   * card only offers a new card (IDEAS-INBOX-SPEC §2.3).
   */
  const choose = useStableCallback((idea: Idea, at: Point) => {
    if (!openMenu) return onCreate(idea);
    const card = board.data?.tasks.find((t) => t.id === idea.taskId);
    if (!card || !continuesInCard(card))
      return openMenu(at, t("Good idea"), [
        { id: "card", label: t("Start a new task · Suggested"), icon: "SquarePlus", onPress: () => onCreate(idea) },
        { kind: "separator", id: "divider" },
        {
          kind: "label",
          id: "finished",
          label: card
            ? t(card.archivedAt ? "{title} is archived. Move it back to a work lane to continue in it." : "{title} is finished. Move it back to a work lane to continue in it.", { title: card.title })
            : t("Its card is gone."),
        },
      ]);
    const here = idea.scope === "here";
    const live = sessionsOf(idea.taskId).filter((s) => !s.archivedAt);
    // The session that proposed it keeps its context; otherwise the newest live one.
    const session = live.find((s) => s.id === idea.agentId) || live[0];
    const continueEntries: MenuEntry[] = [
      ...(session
        ? [{ id: "continue", label: `${t("Continue in {session}", { session: name(session) })}${here ? ` · ${t("Suggested")}` : ""}`, icon: "CornerDownRight", onPress: () => void adopt(idea, session) }]
        : []),
      ...(live.length > 1
        ? [{
            id: "other",
            label: t("Send to another session…"),
            icon: "MessagesSquare",
            onPress: () =>
              openMenu(at, t("Send to"), live.map((s) => ({ id: s.id, label: name(s), icon: s.id === session?.id ? "Check" : "MessageSquare", onPress: () => void adopt(idea, s) }))),
          }]
        : []),
      { id: "session", label: `${t("Do it in a new session")}${here && !session ? ` · ${t("Suggested")}` : ""}`, icon: "Plus", onPress: () => onNewSession(idea) },
    ];
    const cardEntry: MenuEntry = { id: "card", label: `${t("Start a new task")}${here ? "" : ` · ${t("Suggested")}`}`, icon: "SquarePlus", onPress: () => onCreate(idea) };
    const divider: MenuEntry = { kind: "separator", id: "divider" };
    openMenu(at, t("Good idea"), here ? [...continueEntries, divider, cardEntry] : [cardEntry, divider, ...continueEntries]);
  });
  const dismiss = useStableCallback(async (idea: Idea) => {
    if (!touch) swiped.add(idea.id);
    restored.delete(idea.id);
    setHidden((current) => new Set(current).add(idea.id));
    try {
      await updateIdea({ id: idea.id, status: "dismissed" });
      await queryClient.invalidateQueries({ queryKey: boardKey });
    } catch (e) {
      swiped.delete(idea.id);
      setHidden((current) => without(current, [idea.id]));
      toast.show(message(e), { variant: "error" });
    }
  });
  const restore = useStableCallback(async (idea: Idea) => {
    swiped.delete(idea.id);
    restored.add(idea.id);
    setRestoring(idea.id);
    try {
      await updateIdea({ id: idea.id, status: "open" });
      await queryClient.invalidateQueries({ queryKey: boardKey });
      // Only this return animates in; a list mounted later (another tab, the drawer reopened) shows it plainly.
      setTimeout(() => restored.delete(idea.id), 1000);
    } catch (e) {
      restored.delete(idea.id);
      toast.show(message(e), { variant: "error" });
    } finally {
      setRestoring("");
    }
  });
  return { hidden, restoring, swiped: swiped as ReadonlySet<string>, restored: restored as ReadonlySet<string>, choose, dismiss, restore };
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
export function useExitList<T extends { id: string }>(items: readonly T[]) {
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
    // forEach, not a for loop: each timer must keep its own id on Hermes (one binding per loop `const`).
    gone.forEach(({ item }) => {
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
        }, rowExitMs + 40),
      );
    });
    // `leaving` is read, not tracked: only a change of the open list starts or cancels exits.
  }, [items]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return useMemo(() => exitRows(items, [...leaving.values()], initial.current), [items, leaving]);
}


/** Dismiss on desktop: the card slides out to the right, then its slot closes. */
const swipeMs = 180;
/** The longest row exit (swipe, then collapse); rows that left are held this long. */
const rowExitMs = swipeMs + motionDuration.reverse;

/**
 * Holds one idea's slot. Arriving (or `restored`) rows open their slot, then
 * the card rises in (on desktop a restored card slides back in from the right,
 * mirroring the dismiss). Leaving rows collapse and fade, or with `swipe` (a
 * desktop dismiss) slide out to the right first.
 */
export function IdeaRow({
  leaving,
  entering,
  swipe = false,
  restored = false,
  spacing = space[2],
  children,
}: {
  leaving: boolean;
  entering: boolean;
  swipe?: boolean;
  /** Restored while the list was showing: animate it in even if it was there at first render. */
  restored?: boolean;
  /** Space below the row, inside the collapsing slot. */
  spacing?: number;
  children: ReactNode;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Height is a layout property, so this value runs on the JS driver.
  const presence = useMotionPresence(leaving ? undefined : true, leaving ? "" : "row", false);
  const body = (
    <View onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })} style={{ paddingBottom: spacing }}>
      {children}
    </View>
  );
  if (leaving && swipe) return <SwipeOut width={size.width} height={size.height}>{body}</SwipeOut>;
  if (leaving)
    return (
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          overflow: "hidden",
          height: size.height ? lerp(presence.progress, [0, size.height]) : undefined,
          opacity: presence.progress,
          transform: [{ scale: lerp(presence.progress, [0.97, 1]) }],
        }}
      >
        {body}
      </Animated.View>
    );
  return entering || restored ? <InsertIn slide={restored && !touch}>{body}</InsertIn> : body;
}

/**
 * Opens a slot for its child (height from 0), then brings the child in: from
 * the right with `slide`, otherwise rising a few points; both fade in. Once in,
 * the same views lay out normally so the card can still grow (Show more).
 * JS driver: height is layout.
 */
function InsertIn({ slide, children }: { slide: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [open] = useState(() => new Animated.Value(0));
  const [show] = useState(() => new Animated.Value(0));
  const [done, setDone] = useState(reduced);
  const measured = size.height > 0;
  useEffect(() => {
    if (done || !measured) return;
    const animation = Animated.sequence([
      Animated.timing(open, { toValue: 1, duration: motionDuration.reverse, easing: Easing.out(Easing.quad), useNativeDriver: false }),
      Animated.timing(show, { toValue: 1, duration: motionDuration.forward, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
    ]);
    animation.start(({ finished }) => finished && setDone(true));
    return () => animation.stop();
  }, [open, show, done, measured]);
  return (
    <Animated.View style={done ? undefined : { overflow: "hidden", height: lerp(open, [0, size.height || 1]) }}>
      <Animated.View
        onLayout={done ? undefined : (e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
        style={
          done
            ? undefined
            : {
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                opacity: show,
                transform: slide ? [{ translateX: lerp(show, [Math.max(size.width, 1), 0]) }] : [{ translateY: lerp(show, [8, 0]) }],
              }
        }
      >
        {children}
      </Animated.View>
    </Animated.View>
  );
}

/** Slides its child out to the right while fading, then closes the slot. JS driver: desktop only, and height is layout. */
function SwipeOut({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  const reduced = useReducedMotion();
  const [slide] = useState(() => new Animated.Value(0));
  const [close] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduced) {
      slide.setValue(1);
      close.setValue(1);
      return;
    }
    const animation = Animated.sequence([
      Animated.timing(slide, { toValue: 1, duration: swipeMs, easing: Easing.in(Easing.cubic), useNativeDriver: false }),
      Animated.timing(close, { toValue: 1, duration: motionDuration.reverse, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [slide, close, reduced]);
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ overflow: "hidden", height: height ? lerp(close, [height, 0]) : undefined }}
    >
      <Animated.View style={{ opacity: lerp(slide, [1, 0]), transform: [{ translateX: lerp(slide, [0, Math.max(width, 1)]) }] }}>
        {children}
      </Animated.View>
    </Animated.View>
  );
}

export const IdeaCard = memo(function IdeaCard({
  idea,
  disabled,
  source,
  onGood,
  onDismiss,
}: {
  idea: Idea;
  disabled: boolean;
  /** The source card line on the Ideas page (IDEAS-INBOX-SPEC §4.2). */
  source?: ReactNode;
  onGood(idea: Idea, at: Point): void;
  onDismiss(idea: Idea): void;
}) {
  const { colors } = useTheme();
  const meta = [
    <CardMeta
      key="scope"
      icon={<Icon name={idea.scope === "here" ? "CornerDownRight" : "SquarePlus"} size={12} color={colors.foregroundMuted} />}
      text={idea.scope === "here" ? t("Continues this task") : t("New task")}
    />,
    idea.type && (
      <CardMeta key="type" icon={<TypeIcon type={idea.type} size={12} />} text={taskTypeLabels[idea.type]} />
    ),
    idea.priority && idea.priority !== "normal" && (
      // Low's single-bar glyph reads as stray punctuation at this size; only the High/Urgent arrows add meaning.
      <CardMeta
        key="priority"
        icon={idea.priority === "low" ? null : <PriorityIcon priority={idea.priority} size={12} />}
        text={idea.priority === "low" ? t("Low priority") : priorityLabels[idea.priority]}
      />
    ),
  ].filter(Boolean);
  return (
    <ContentCard
      after={source}
      footer={
        <View style={{ flexShrink: 1, flexDirection: "row", justifyContent: "flex-end", gap: space[2] }}>
          <Button quiet disabled={disabled} label={t("Dismiss {title}", { title: idea.title })} onPress={() => onDismiss(idea)}>
            {t("Dismiss")}</Button>
          <Button
            primary
            icon="ThumbsUp"
            disabled={disabled}
            label={t("Good idea: {title}. Choose to do it in this task or start a new task.", { title: idea.title })}
            onPress={(event) => onGood(idea, eventPoint(event))}
          >
            {t("Good idea")}</Button>
        </View>
      }
    >
      <CardBody>
        {/* Title and meta stay together. */}
        <View style={{ gap: space[1.5] }}>
          <CardHeadline selectable={false}>{idea.title}</CardHeadline>
          <CardMetaRow>
            {meta}
            <CardMeta text={relativeTime(idea.createdAt)} />
          </CardMetaRow>
        </View>
        {!!idea.rationale.trim() && <CardText>{idea.rationale}</CardText>}
        <CardField title={t("What to do")} text={idea.detail} />
        <CardField title={t("Context")} text={idea.context} />
      </CardBody>
    </ContentCard>
  );
});

export function ClosedIdea({
  idea,
  acceptedTitle,
  sentTo,
  disabled,
  onOpenTask,
  onRestore,
}: {
  idea: Idea;
  acceptedTitle?: string;
  /** Accepted in this card: the session it was sent to. */
  sentTo?: string;
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
          (sentTo ? (
            <Label muted size={font.xs} lines={1} selectable={false}>{`→ ${t("Sent to {session}", { session: sentTo })}`}</Label>
          ) : acceptedTitle && idea.acceptedTaskId ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t("Open task {title}",  { title: acceptedTitle })}
              onPress={() => onOpenTask(idea.acceptedTaskId!)}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <Label size={font.xs} color={colors.accent} lines={1} selectable={false}>→ {acceptedTitle}</Label>
            </Pressable>
          ) : (
            <Label muted size={font.xs} selectable={false}>{`→ ${t("deleted card")}`}</Label>
          ))}
      </View>
      {!accepted && (
        <Button small quiet icon="Undo2" disabled={disabled} label={t("Restore {title}", { title: idea.title })} onPress={() => onRestore(idea)}>
          {t("Restore")}</Button>
      )}
    </View>
  );
}

