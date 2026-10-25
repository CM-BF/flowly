import { memo, useCallback, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, View } from "react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import * as rpc from "../shared/rpc";
import type { BoardEvent } from "../shared/model";
import { commentLimits } from "../shared/comments";
import {
  chooseRecipient,
  commentList,
  commentTransport,
  composerNote,
  dismissFailure,
  editComment,
  postComment,
  recipientPicker,
  resendComment,
  resolveTarget,
  shownComments,
  subscribeComments,
  type CommentDelivery,
  type CommentMemory,
  type CommentTarget,
  type CommentTargets,
  type ComposerNote,
  type FailedDelivery,
} from "./card-comments";
import { Section, type SectionState } from "./disclosure";
import { useComposer } from "./composer";
import { useBoardView } from "./board-view";
import { eventPoint, useMenuOpener, type MenuEntry } from "./context-menu";
import { useShortcutBlock } from "./shortcuts";
import { composerKeys } from "./session-input";
import { useStableCallback } from "./stable";
import { Button, Label, Notice, TextBox, font, noFocusRing, radius, relativeTime, space, touch, useTheme } from "./ui";
import { msg, t, tn } from "../shared/i18n";

const sessionName = (target: Pick<CommentTarget, "title"> | null | undefined) => target?.title || t("Session");

const noteText: Record<ComposerNote, string> = {
  "no-session": msg("No agent session on this card yet: the comment is saved, and an agent reads it when one starts."),
  archived: msg("This card's sessions are archived: the comment is saved on the card and not sent."),
  reviewers: msg("This card's only live sessions are reviewers: the comment is saved on the card, and sent only if you choose one in To:."),
};

/**
 * The drawer's Comments section (CARD-COMMENTS-SPEC §1): the recent comments
 * and a composer. Posting records the comment on the card, then sends the exact
 * text to the chosen session through the session composer's path. The draft,
 * recipient, undelivered comments and the post in flight live in `memory`, so
 * opening a session and coming back loses none of them. Memoized: the drawer
 * passes stable callbacks and content-compared lists.
 */
export const TaskComments = memo(function TaskComments({
  taskId,
  workspaceId,
  events,
  targets,
  loading,
  archivedKnown,
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
  /** The archived sessions were read, so a card without live sessions can be told from a wrapped-up one. */
  archivedKnown: boolean;
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
  const handoffRecord = useRpc(rpc.recordHandoffInput), handoffConfirm = useRpc(rpc.confirmHandoffInput);
  const handoffSend = useRpc(rpc.sendHandoffInput);
  // Queues through the daemon like the session composer; no polling of its own.
  const composer = useComposer(false);
  const view = useBoardView();
  const openMenu = useMenuOpener();
  useSyncExternalStore(
    useCallback((listener: () => void) => subscribeComments(memory, listener), [memory]),
    () => memory.version,
  );
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  useShortcutBlock(focused);
  const target = resolveTarget(targets, memory.chosen);
  const picker = recipientPicker(targets, target);
  const note = composerNote(targets, target, { loading, archivedKnown });
  const locked = !!lockedReason || !active;
  const busy = memory.busy;
  const transport = commentTransport({ paseo, contextRead, handoff: { record: handoffRecord, send: handoffSend, confirm: handoffConfirm }, queue: (task, agentId, text, messageId) => composer.queue(task, agentId, text, [], messageId) }, { taskId, workspaceId });
  // A failed delivery shows in the list below instead.
  const announce = (delivery: CommentDelivery, to: CommentTarget | null) => {
    if (delivery.kind === "failed") return;
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
    if (locked || loading) return;
    const to = target;
    const result = await postComment(memory, { record, ...transport }, { taskId, target: to, settings: view.values, alternate });
    if (result.kind !== "posted") return;
    onPosted();
    announce(result.delivery, to);
  };
  const resend = useStableCallback(async (eventId: string) => {
    if (locked) return;
    const to = target;
    const delivery = await resendComment(memory, transport, eventId, to, view.values);
    if (delivery) announce(delivery, to);
  });
  const dismiss = useStableCallback((eventId: string) => dismissFailure(memory, eventId));
  const all = commentList(events, taskId, memory.posted);
  const shown = shownComments(all, expanded);
  const latest = all[all.length - 1];
  const pickTarget = (event: Parameters<typeof eventPoint>[0]) => {
    const entries: MenuEntry[] = targets.candidates.map((c) => ({
      id: c.id,
      label: c.role === "reviewer" ? t("{session} (reviewer)", { session: sessionName(c) }) : c.role === "implementer" ? t("{session} (automation)", { session: sessionName(c) }) : sessionName(c),
      icon: "MessageSquare",
      checked: c.id === target?.id,
      onPress: () => chooseRecipient(memory, c.id),
    }));
    openMenu?.(eventPoint(event), t("Send comments to"), entries);
  };
  const recipient = target ? sessionName(target) : t("Nobody (saved on the card)");
  const canSend = !locked && !loading && !busy && !!memory.draft.trim();
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
        {!locked && picker.shown && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("To: {session}. Change", { session: recipient })}
            disabled={busy || !openMenu || !picker.opens}
            onPress={pickTarget}
            hitSlop={6}
            style={{ ...noFocusRing, flexDirection: "row", alignItems: "center", gap: 2, alignSelf: "flex-start", minHeight: touch ? 32 : 22 }}
          >
            <Label muted size={font.sm} lines={1} selectable={false}>
              {t("To:")} <Label size={font.sm} medium selectable={false}>{recipient}</Label>
            </Label>
            {picker.opens && <Icon name="ChevronDown" size={12} color={colors.foregroundMuted} />}
          </Pressable>
        )}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2] }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <TextBox
              accessibilityLabel={t("New comment")}
              value={memory.draft}
              onChangeText={(text) => editComment(memory, text)}
              editable={!locked && !busy}
              multiline
              maxLength={commentLimits.text}
              placeholder={t("Comment or ask the agent…")}
              placeholderTextColor={colors.foregroundMuted}
              {...composerKeys(Platform.OS, (alternate) => void submit(alternate))}
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
        {!!memory.error && <Notice>{memory.error}</Notice>}
        {memory.failed.map((f) => (
          <FailedComment
            key={f.eventId}
            failed={f}
            resendTo={target && target.id !== f.agentId ? sessionName(target) : ""}
            disabled={busy || !target || locked}
            onResend={resend}
            onDismiss={dismiss}
          />
        ))}
        {!locked && note && (
          <View style={{ gap: space[1.5] }}>
            <Label muted size={font.sm}>{t(noteText[note])}</Label>
            {note === "no-session" && onStartSession && (
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

/** A comment saved on the card but not delivered: which one, why, and Resend or Dismiss (CARD-COMMENTS-SPEC §7.6). */
const FailedComment = memo(function FailedComment({
  failed,
  resendTo,
  disabled,
  onResend,
  onDismiss,
}: {
  failed: FailedDelivery;
  /** The current recipient's name when it is not the session the delivery failed for. */
  resendTo: string;
  disabled: boolean;
  onResend(eventId: string): void;
  onDismiss(eventId: string): void;
}) {
  return (
    <View style={{ gap: space[1.5] }}>
      <Notice tone="warning">
        {`${failed.error} ${t("Saved on the card; not delivered to {session}.", { session: sessionName(failed) })}`}
      </Notice>
      <Label muted size={font.sm} lines={1}>{failed.text.replace(/\s+/g, " ").trim()}</Label>
      <View style={{ flexDirection: "row", gap: space[2] }}>
        <Button small icon="RotateCw" disabled={disabled} onPress={() => onResend(failed.eventId)}>
          {resendTo ? t("Resend to {session}", { session: resendTo }) : t("Resend")}
        </Button>
        <Button small quiet onPress={() => onDismiss(failed.eventId)}>{t("Dismiss")}</Button>
      </View>
    </View>
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
