import { memo, useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import * as rpc from "../shared/rpc";
import type { BoardEvent } from "../shared/model";
import { commentLimits } from "../shared/comments";
import {
  commentList,
  commentOperation,
  deliverComment,
  postComment,
  resolveTarget,
  shownComments,
  type CommentDelivery,
  type CommentTarget,
  type CommentTargets,
  type CommentTransport,
} from "./card-comments";
import { Section, type SectionState } from "./disclosure";
import { useComposer } from "./composer";
import { useBoardView } from "./board-view";
import { sendCardInstruction, workspaceSession } from "./session";
import { eventPoint, useMenuOpener, type MenuEntry } from "./context-menu";
import { useShortcutBlock } from "./shortcuts";
import { composerEnterAction, type ComposerKey } from "./session-input";
import { Button, Label, Notice, TextBox, font, message, noFocusRing, radius, relativeTime, space, touch, useTheme } from "./ui";
import { t, tn } from "../shared/i18n";

/** What a card's comment composer keeps while the drawer shows a session instead (the section unmounts then). */
export type CommentMemory = {
  draft: string;
  chosen: string | null;
  failed: FailedDelivery | null;
  /** The last post that got no answer: retrying the same text reuses its operation. */
  last: { text: string; operationId: string } | null;
};
type FailedDelivery = { text: string; agentId: string; title: string; error: string };

export const newCommentMemory = (): CommentMemory => ({ draft: "", chosen: null, failed: null, last: null });

const sessionName = (target: Pick<CommentTarget, "title"> | null | undefined) => target?.title || t("Session");

/**
 * The drawer's Comments section (CARD-COMMENTS-SPEC §1): the recent comments
 * and a composer. Posting records the comment on the card, then sends the exact
 * text to the chosen session through the session composer's path. Memoized:
 * the drawer passes stable callbacks and content-compared lists.
 */
export const TaskComments = memo(function TaskComments({
  taskId,
  workspaceId,
  events,
  targets,
  loading,
  lockedReason,
  active,
  section,
  memory,
  onPosted,
  onStartSession,
}: {
  taskId: string;
  workspaceId: string;
  /** This card's comment events (the drawer compares them by id). */
  events: readonly BoardEvent[];
  targets: CommentTargets;
  /** The card's sessions are still loading: the recipient is not known yet. */
  loading: boolean;
  /** Set when the card or its project is archived: no new comments. */
  lockedReason: string;
  active: boolean;
  section: SectionState;
  memory: CommentMemory;
  onPosted(): void;
  onStartSession?(): void;
}) {
  const { colors } = useTheme();
  const toast = useToast();
  const paseo = usePaseo();
  const record = useRpc(rpc.commentTask);
  const contextRead = useRpc(rpc.taskContext);
  // Queues through the daemon like the session composer; no polling of its own.
  const composer = useComposer(false);
  const view = useBoardView();
  const openMenu = useMenuOpener();
  const [draft, setDraftState] = useState(memory.draft);
  const [chosen, setChosenState] = useState(memory.chosen);
  const [failed, setFailedState] = useState(memory.failed);
  const [posted, setPosted] = useState<BoardEvent[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [focused, setFocused] = useState(false);
  useShortcutBlock(focused);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  // Set before the first await: a second Enter in the same frame must not post or send again.
  const lock = useRef(false);
  const setDraft = (text: string) => {
    memory.draft = text;
    if (mounted.current) setDraftState(text);
  };
  const setFailed = (next: FailedDelivery | null) => {
    memory.failed = next;
    if (mounted.current) setFailedState(next);
  };
  const setChosen = (id: string) => {
    memory.chosen = id;
    setChosenState(id);
  };
  const target = resolveTarget(targets, chosen);
  const behavior = view.values?.sendBehavior || "steer";
  const locked = !!lockedReason || !active;
  const transport: CommentTransport = {
    send: async (agentId, text, mode) => {
      // A comment never restores an archived session (CARD-COMMENTS-SPEC §1).
      await workspaceSession(paseo, agentId, workspaceId, true);
      await sendCardInstruction(paseo, { id: taskId, workspaceId }, agentId, contextRead, text, mode);
    },
    queue: (agentId, text) => composer.queue(taskId, agentId, text),
  };
  /** `resent`: the delivery of the failed comment itself, which clears its notice; a newer comment's success does not. */
  const report = (delivery: CommentDelivery, text: string, to: CommentTarget | null, resent = false) => {
    if (delivery.kind === "failed") {
      setFailed({ text, agentId: delivery.agentId, title: sessionName(to), error: delivery.error });
      return;
    }
    if (resent) setFailed(null);
    toast.show(
      delivery.kind === "sent"
        ? t("Comment sent to {session}", { session: sessionName(to) })
        : delivery.kind === "queued"
          ? t("Comment saved; it goes to {session} when its turn ends", { session: sessionName(to) })
          : t("Comment saved on the card"),
      { variant: "success" },
    );
  };
  const submit = async (alternate = false) => {
    const text = memory.draft;
    if (lock.current || locked || loading || !text.trim()) return;
    lock.current = true;
    const to = target;
    const operationId = commentOperation(memory.last, text);
    memory.last = { text, operationId };
    setBusy(true);
    setError("");
    try {
      const { event, delivery } = await postComment({ record, ...transport }, { taskId, text, operationId, target: to, behavior, alternate });
      memory.last = null;
      if (memory.draft === text) setDraft("");
      if (mounted.current) setPosted((list) => [...list, event]);
      onPosted();
      report(delivery, text, to);
    } catch (e) {
      // Not recorded: the text stays in the box, and the same text retries the same operation.
      if (mounted.current) setError(message(e));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const resend = async () => {
    if (!failed || !target || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      report(await deliverComment(transport, target, failed.text, behavior), failed.text, target, true);
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const all = commentList(events, taskId, posted);
  const shown = shownComments(all, expanded);
  const latest = all[all.length - 1];
  const pickTarget = (event: Parameters<typeof eventPoint>[0]) => {
    const entries: MenuEntry[] = targets.candidates.map((c) => ({
      id: c.id,
      label: c.role === "reviewer" ? t("{session} (reviewer)", { session: sessionName(c) }) : c.role === "implementer" ? t("{session} (automation)", { session: sessionName(c) }) : sessionName(c),
      icon: "MessageSquare",
      checked: c.id === target?.id,
      onPress: () => setChosen(c.id),
    }));
    openMenu?.(eventPoint(event), t("Send comments to"), entries);
  };
  const canSend = !locked && !loading && !busy && !!draft.trim();
  return (
    <Section
      id={taskId}
      title={t("Comments")}
      count={all.length || undefined}
      open={section.open}
      onToggle={section.onToggle}
      summary={latest ? latest.text.replace(/\s+/g, " ").trim() : undefined}
    >
      {all.length > shown.length && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tn(all.length, "Show all {n} comments", "Show all {n} comments")}
          onPress={() => setExpanded(true)}
          style={({ pressed }) => ({ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: space[1.5], minHeight: touch ? 44 : 30, opacity: pressed ? 0.7 : 1 })}
        >
          <Icon name="ChevronUp" size={14} color={colors.foregroundMuted} />
          <Label muted size={font.sm} selectable={false}>{tn(all.length, "Show all {n} comments", "Show all {n} comments")}</Label>
        </Pressable>
      )}
      {shown.map((c) => (
        <CommentRow key={c.id} text={c.text} at={c.at} />
      ))}
      <View testID="comment-composer" style={{ gap: space[1.5] }}>
        {!locked && targets.candidates.length > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("To: {session}. Change", { session: sessionName(target) })}
            disabled={busy || !openMenu || targets.candidates.length < 2}
            onPress={pickTarget}
            hitSlop={6}
            style={{ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: 2, alignSelf: "flex-start", minHeight: touch ? 32 : 22 }}
          >
            <Label muted size={font.sm} lines={1} selectable={false}>
              {t("To:")} <Label size={font.sm} medium selectable={false}>{sessionName(target)}</Label>
            </Label>
            {targets.candidates.length > 1 && <Icon name="ChevronDown" size={12} color={colors.foregroundMuted} />}
          </Pressable>
        )}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2] }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <TextBox
              accessibilityLabel={t("New comment")}
              value={draft}
              onChangeText={setDraft}
              editable={!locked && !busy}
              multiline
              maxLength={commentLimits.text}
              placeholder={t("Comment or ask the agent…")}
              placeholderTextColor={colors.foregroundMuted}
              {...(Platform.OS === "web"
                ? {
                    onKeyPress: (event: { nativeEvent: unknown; preventDefault(): void }) => {
                      const action = composerEnterAction(event.nativeEvent as ComposerKey);
                      if (action === "native") return;
                      event.preventDefault();
                      if (action === "submit" || action === "alternate") void submit(action === "alternate");
                    },
                  }
                : {})}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={{
                borderWidth: 1,
                borderColor: focused ? colors.foregroundMuted : colors.border,
                borderRadius: radius.md,
                paddingHorizontal: space[2] + 2,
                paddingVertical: space[1.5] + 2,
                minHeight: touch ? 44 : 34,
                maxHeight: 160,
                color: locked ? colors.foregroundMuted : colors.foreground,
                backgroundColor: locked ? colors.surface1 : colors.surface0,
                fontSize: font.md,
                textAlignVertical: "top",
                outlineStyle: "none",
              } as never}
            />
          </View>
          <Button primary small icon="Send" label={t("Post comment")} disabled={!canSend} onPress={() => void submit()}>
            {busy ? t("Posting…") : t("Comment")}
          </Button>
        </View>
        {!!lockedReason && <Label muted size={font.sm}>{lockedReason}</Label>}
        {!!error && <Notice>{error}</Notice>}
        {!!failed && (
          <View style={{ gap: space[1.5] }}>
            <Notice tone="warning">
              {`${failed.error} ${t("Saved on the card; not delivered to {session}.", { session: failed.title })}`}
            </Notice>
            <View style={{ flexDirection: "row", gap: space[2] }}>
              <Button small icon="RotateCw" disabled={busy || !target || locked} onPress={() => void resend()}>
                {target && target.id !== failed.agentId ? t("Resend to {session}", { session: sessionName(target) }) : t("Resend")}
              </Button>
              <Button small quiet onPress={() => setFailed(null)}>{t("Dismiss")}</Button>
            </View>
          </View>
        )}
        {!locked && !loading && !target && (
          <View style={{ gap: space[1.5] }}>
            <Label muted size={font.sm}>
              {targets.archivedOnly
                ? t("This card's sessions are archived: the comment is saved on the card and not sent.")
                : t("No agent session on this card yet: the comment is saved, and an agent reads it when one starts.")}
            </Label>
            {!targets.archivedOnly && onStartSession && (
              <View style={{ flexDirection: "row" }}>
                <Button small quiet icon="Play" onPress={onStartSession}>{t("Start session")}</Button>
              </View>
            )}
          </View>
        )}
      </View>
    </Section>
  );
});

/** One comment: who and when, then the text. */
const CommentRow = memo(function CommentRow({ text, at }: { text: string; at: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 2, paddingVertical: space[2], paddingHorizontal: space[3], borderRadius: radius.lg, backgroundColor: colors.surface1 }}>
      <Label muted size={font.xs} selectable={false}>
        <Label medium size={font.xs} selectable={false}>{t("You")}</Label>
        {` · ${relativeTime(at)}`}
      </Label>
      <Label size={font.md} selectable>{text}</Label>
    </View>
  );
});
