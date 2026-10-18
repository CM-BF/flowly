import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import {
  ActivityIndicator,
  Animated,
  Image,
  Platform,
  Pressable,
  Text as NativeText,
  View,
} from "react-native";
import {
  ScrollView,
  Icon,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import { Modal } from "./modal";
import { useShortcutBlock } from "./shortcuts";
import {
  usePaseo,
  useRpc,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { Task, BoardEvent } from "../shared/model";
import * as rpc from "../shared/rpc";
import {
  Button,
  Label,
  Notice,
  IconButton,
  Dot,
  font,
  radius,
  relativeTime,
  space,
  touch,
  useTheme,
  Theme,
  Actions,
  Row,
  message,
  tint,
  verticalScroll,
  verticalContent, noFocusRing } from "./ui";
import { sessionTone } from "./status";
import { resolveSend, sendBehaviorText, sendBehaviors, type SendBehavior } from "./send-queue";
import { useComposer } from "./composer";
import { useLiveAgents } from "./queries";
import { extractImages } from "../shared/images";
import { SessionImage } from "./session-image";
import { imageInputSupported, listenForImages, pickImageFiles, readImages, type Attachment } from "./web-images";
import { maxImages } from "../shared/composer";
import { newMessageId, rememberSentImages, sentImages } from "./sent-images";
import { eventPoint, menuHandlers, useMenuOpener, type MenuEntry } from "./context-menu";
import { useBoardView } from "./board-view";
import { ComposerChips, useSessionConfig, type ChipMenuId } from "./session-settings";
import { RenameSession } from "./session-rename";
import {
  activitySummary,
  groupTranscript,
  openNativeSession,
  recentSessionOutput,
  samePreviewTask,
  sessionState,
  turnEventKey,
  type TranscriptBlock,
} from "./session-state";
import { sendCardInstruction, workspaceSession } from "./session";
import { useStableCallback } from "./stable";
import { SessionMarkdown } from "./session-content";
import { PendingRequests } from "./session-question";
import { pendingRequests, type PendingRequest, type PermissionReply } from "../shared/permission-question";
import { coalescedRefresh, useSessionFollowTail } from "./session-follow";
import { useSessionReads } from "./session-reads";
import { sessionAttention } from "../shared/session-attention";
import { Enter, MotionReveal, PulseDot, motionDuration, useMotionPresence, useMotionValue, useReducedMotion, useSettled, lerp } from "./motion";
import { useKeyboardInset } from "./keyboard";
import { composerEnterAction, createDraftBuffer, createDraftReporter, restoredDraft, type ComposerKey } from "./session-input";
import { t, tn } from "../shared/i18n";

/** Composer text area: vertical padding and the one-line height (20 px line). */
const inputPad = 4;
const inputMin = 20 + 2 * inputPad;

type SessionPreviewProps = Parameters<typeof SessionPreviewView>[0];

/**
 * Memoized: the drawer re-renders on every board change, and a card moving
 * lane (an agent's stage update, a status rule after a send) used to re-render
 * the whole session view, transcript and composer while the user typed, a long
 * JS frame on a phone. Only what this view reads is compared: the card's
 * identity fields and this session's turn events.
 */
export const SessionPreview = memo(SessionPreviewView, sameSessionPreviewProps);

export function sameSessionPreviewProps(a: SessionPreviewProps, b: SessionPreviewProps) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof SessionPreviewProps>;
  for (const key of keys) {
    if (key === "task") {
      if (!samePreviewTask(a.task, b.task)) return false;
    } else if (key === "events") {
      if (turnEventKey(a.events, a.sessionId) !== turnEventKey(b.events, b.sessionId)) return false;
    } else if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

function SessionPreviewView({
  task,
  sessionId,
  compact = false,
  hostId,
  events,
  unavailable,
  unavailableReason,
  navigation,
  draft,
  pending,
  beginOperation,
  endOperation,
  onDraftChange,
  onComposerFocus,
  onBack,
  onClose,
  refresh,
  visible = true,
}: {
  task: Task;
  sessionId: string;
  compact?: boolean;
  hostId: string;
  events: BoardEvent[];
  unavailable: boolean;
  unavailableReason?: string;
  navigation: PluginSurfaceProps["navigation"];
  draft: string;
  pending: boolean;
  beginOperation(sessionId: string): boolean;
  endOperation(sessionId: string): void;
  onDraftChange(sessionId: string, text: string, expectedDraft?: string): void;
  /** The composer got focus (the drawer stops restoring a saved draft into it). */
  onComposerFocus?(sessionId: string): void;
  onBack(): void;
  /** Close the whole side bar (from any level). */
  onClose?(): void;
  refresh(): void;
  visible?: boolean;
}) {
  const theme = useTheme(),
    { colors } = theme,
    paseo = usePaseo(),
    contextRead = useRpc(rpc.taskContext),
    healthRead = useRpc(rpc.toolsHealth),
    prepareExisting = useRpc(rpc.prepareExisting),
    accessRead = useRpc(rpc.accessState),
    tailRead = useRpc(rpc.sessionTail);
  const reads = useSessionReads();
  const toast = useToast();
  const [draftBuffer] = useState(() => createDraftBuffer(draft));
  // Native (phone) typing: the input owns its text. Pushing every keystroke
  // through the drawer's state and back as a controlled value re-renders the
  // whole session view and can reset the IME's composition, so the screen
  // jumps and the next group of characters is disturbed (worse over a remote
  // connection). The drawer hears about changes after a short pause (at once
  // when the box turns empty/non-empty); only outside changes (restore, clear
  // after send, edit a queued message) reset the input.
  const ownInput = Platform.OS !== "web";
  // Web: the controlled value is authoritative. Native: the buffer follows the
  // input and only outside changes (below) replace it, since the drawer's copy
  // may lag behind what was typed.
  if (!ownInput) draftBuffer.sync(draft);
  const [inputKey, setInputKey] = useState(0);
  // Native: the text a mount starts from. Never follow `draft` here — RN sends a
  // changed defaultValue to the native input as new text, so a debounced (stale)
  // report would overwrite what was typed meanwhile and drop characters.
  const [inputSeed, setInputSeed] = useState(draft);
  const latestChange = useRef(onDraftChange);
  latestChange.current = onDraftChange;
  const [reporter] = useState(() => createDraftReporter(draft, (text) => latestChange.current(sessionId, text)));
  const flushReport = () => reporter.flush();
  const reportDraft = (text: string) => (ownInput ? reporter.change(text) : onDraftChange(sessionId, text));
  useEffect(() => () => reporter.flush(), []);
  const inputRef = useRef<{ clear?(): void; focus?(): void } | null>(null);
  const refocus = useRef(false);
  useEffect(() => {
    // An outside change (restore, clear after send, edit a queued message): show it in the input.
    if (!ownInput || !reporter.external(draft)) return;
    draftBuffer.set(draft);
    // Clearing after a send keeps the keyboard up; other text remounts the input with it.
    if (!draft && inputRef.current?.clear) {
      inputRef.current.clear();
      setInputSeed("");
      return;
    }
    refocus.current = focusedRef.current;
    setInputSeed(draft);
    setInputKey((k) => k + 1);
  }, [draft]);
  const [sending, setSending] = useState(false),
    [error, setError] = useState(""),
    [showTools, setShowTools] = useState(false),
    [inputHeight, setInputHeight] = useState(inputMin),
    [focused, setFocused] = useState(false),
    [confirmArchive, setConfirmArchive] = useState(false),
    [renaming, setRenaming] = useState(false),
    [chipMenu, setChipMenu] = useState<ChipMenuId | null>(null),
    [modePicker, setModePicker] = useState(false);
  useShortcutBlock(focused);
  const focusedRef = useRef(false);
  focusedRef.current = focused;
  const keyboard = useKeyboardInset(visible, useReducedMotion());
  const lock = useRef(false);
  const tail = useSessionFollowTail();
  const mounted = useRef(visible);
  mounted.current = visible;
  useEffect(() => {
    mounted.current = visible;
    return () => {
      mounted.current = false;
    };
  }, [visible]);
  const agent = useMemo(() => paseo.agents.ref(sessionId), [paseo, sessionId]);
  // The board's streamed agent list has this session already: show it at once
  // and revalidate (PERFORMANCE-SPEC §3). Archived sessions are not in it.
  const liveAgents = useLiveAgents({
    poll: false,
    select: useCallback((agents: PaseoAgent[]) => agents.find((a) => a.id === sessionId) ?? null, [sessionId]),
  });
  const streamed = liveAgents.data ?? undefined;
  const current = useQuery({
    queryKey: ["ultra", "agent", sessionId],
    queryFn: () => agent.refresh(),
    enabled: visible,
    refetchInterval: 10000,
    placeholderData: () => (streamed ? { agent: streamed, project: null } : undefined),
  });
  // The stream is fresher than the last poll while it runs.
  const polled = current.data?.agent;
  const actor = streamed && (!polled || streamed.updatedAt >= polled.updatedAt) ? streamed : polled;
  const belongs = !!actor && actor.workspaceId === task.workspaceId;
  const active = belongs ? actor : undefined;
  const [streamReady, setStreamReady] = useState(false);
  // The transcript (markdown, images) and the slower reads wait for the open
  // transition to finish (PERFORMANCE-SPEC §3).
  const settled = useSettled(sessionId);
  // Slim tail from the daemon (no tool payloads); it checks membership itself,
  // so it loads in parallel with the agent.
  const timeline = useQuery({
    queryKey: ["ultra", "timeline", task.id, sessionId],
    queryFn: () => tailRead({ taskId: task.id, agentId: sessionId, limit: 35 }),
    enabled: visible && settled && !current.isError,
    refetchInterval: streamReady ? 15000 : 3000,
  });
  // Only the Kanban tools section shows these.
  const tools = useQuery({
    queryKey: ["ultra", "tools"],
    queryFn: () => healthRead({}),
    enabled: visible && belongs && showTools,
    refetchInterval: 5000,
  });
  const access = useQuery({
    queryKey: ["ultra", "access", task.id, sessionId],
    queryFn: () => accessRead({ id: task.id, agentId: sessionId }),
    enabled: visible && belongs && !current.isError && showTools,
    refetchInterval: 3000,
  });
  useEffect(() => {
    if (!visible || !belongs || current.isError) return;
    let alive = true;
    // Status comes from the agent stream; stream events only refresh the transcript.
    const updates = coalescedRefresh(() => void timeline.refetch(), 400);
    const subscription = agent.timeline.subscribe(() => {
      if (alive) updates.trigger();
    });
    void subscription.ready.then(
      () => alive && setStreamReady(true),
      (e) => {
        if (alive) setError(message(e));
      },
    );
    return () => {
      alive = false;
      setStreamReady(false);
      updates.dispose();
      subscription();
    };
  }, [agent, belongs, current.isError, visible]);
  const state = active ? sessionState(active, events) : null;
  const attention = active
    ? sessionAttention(active, task.id, reads.receipts, events)
    : null;
  // Reading is something the user does: opening the session, or interacting
  // with it (pointer down inside, focusing the composer, sending). A turn that
  // finishes while the view merely stays open — e.g. while the user works
  // elsewhere in Paseo — stays unread. "Mark as unread" holds until the next
  // interaction or the next open.
  const holdUnread = useRef(false);
  const [readIntent, setReadIntent] = useState(1);
  const handledIntent = useRef(0);
  const readsReady = !reads.query.isPending && !reads.query.isError;
  const noteInteraction = () => {
    holdUnread.current = false;
    setReadIntent((n) => n + 1);
  };
  useEffect(() => {
    if (!visible || !active || !readsReady || handledIntent.current === readIntent) return;
    // Each open/interaction reads what is unread at that moment, once.
    handledIntent.current = readIntent;
    if (active.archivedAt || task.archivedAt || !attention?.unread || holdUnread.current) return;
    void reads
      .markRead({ taskId: task.id, agentId: sessionId, ...(attention.token ? { token: attention.token } : {}) })
      .catch(() => undefined);
  }, [visible, active?.id, active?.archivedAt, task.archivedAt, attention?.unread, attention?.token, readsReady, readIntent]);
  const output = useMemo(
    () => recentSessionOutput(timeline.data?.entries || []),
    [timeline.data?.entries],
  );
  const blocks = useMemo(() => groupTranscript(output), [output]);
  // Following the tail happens on the transcript's own layout/size changes
  // (after layout, so it lands on the new end in one step).
  const busy = sending || pending;
  const canWrite =
    visible &&
    !!active &&
    !active.providerUnavailable &&
    !unavailable &&
    !current.isError &&
    !busy;
  const view = useBoardView();
  const preferred: SendBehavior = view.values?.sendBehavior || "steer";
  const setPreferred = (next: SendBehavior) => {
    if (view.values && view.values.sendBehavior !== next) void view.update({ sendBehavior: next });
  };
  const composer = useComposer(visible && settled);
  const openMenu = useMenuOpener();
  const latest = useMotionPresence(!tail.following ? true : undefined, !tail.following ? "latest" : "");
  const config = useSessionConfig(task.id, active, visible && settled, () => void current.refetch());
  const queueEntry = composer.entry(sessionId);
  const queued = queueEntry?.queue || [];
  const running = active?.status === "running" || active?.status === "initializing";
  // Images attached to the next message (web: paste, drop or the attach button).
  const [attachments, setAttachmentsState] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const setAttachments = (next: Attachment[]) => {
    attachmentsRef.current = next;
    setAttachmentsState(next);
  };
  const addImageFiles = async (files: Parameters<typeof readImages>[0]) => {
    if (!files.length) return;
    try {
      const { images, problems } = await readImages(files, maxImages - attachmentsRef.current.length);
      if (!mounted.current) return;
      if (images.length) setAttachments([...attachmentsRef.current, ...images].slice(0, maxImages));
      if (problems.length) toast.error(problems.join(" "));
    } catch (e) {
      toast.error(message(e));
    }
  };
  const addImages = useRef(addImageFiles);
  addImages.current = addImageFiles;
  const [composerNode, setComposerNode] = useState<View | null>(null);
  useEffect(() => listenForImages(composerNode, (files) => void addImages.current(files)), [composerNode]);
  const submitState = useRef({ canWrite, preferred, running, pendingPermission: false });
  submitState.current = {
    canWrite,
    preferred,
    running,
    pendingPermission: !!active?.pendingPermissions?.length,
  };
  async function perform(action: () => Promise<unknown>) {
    if (!mounted.current || lock.current || !beginOperation(sessionId)) return;
    lock.current = true;
    setSending(true);
    setError("");
    try {
      await action();
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      lock.current = false;
      endOperation(sessionId);
      setSending(false);
    }
  }
  // Header overflow: everything that is not navigation lives here.
  const sessionActions = (): MenuEntry[] => {
    if (!active) return [];
    const runningNow = active.status === "running" || active.status === "initializing";
    return [
      attention?.unread
        ? {
            id: "read",
            label: t("Mark as read"),
            icon: "MailCheck",
            disabled: !canWrite || reads.query.isPending || reads.query.isError,
            onPress: () =>
              void perform(async () => {
                holdUnread.current = false;
                await reads.markRead({ taskId: task.id, agentId: sessionId, ...(attention.token ? { token: attention.token } : {}) });
                toast.show(t("Marked as read"), { variant: "success" });
                await current.refetch();
              }),
          }
        : {
            id: "unread",
            label: t("Mark as unread"),
            icon: "Mail",
            disabled: !canWrite || reads.query.isPending || reads.query.isError || !!active.archivedAt,
            onPress: () =>
              void perform(async () => {
                // Stay unread while this view is open; opening it again reads it.
                holdUnread.current = true;
                await reads.markUnread({ taskId: task.id, agentId: sessionId });
                toast.show(t("Marked as unread"), { variant: "success" });
              }),
          },
      ...(!active.archivedAt
        ? [{ id: "rename", label: t("Rename session"), icon: "Pencil", disabled: !canWrite || busy, onPress: () => setRenaming(true) }]
        : []),
      { id: "tools", label: showTools ? t("Hide Kanban tools") : t("Kanban tools"), icon: "Wrench", onPress: () => setShowTools(!showTools) },
      ...(runningNow
        ? [{ id: "stop", label: t("Stop"), icon: "Square", onPress: () => void config.apply({ stop: true }, t("Session stopped")) }]
        : []),
      ...(!active.archivedAt
        ? [
            { kind: "separator" as const, id: "s" },
            {
              id: "archive",
              label: t("Archive session"),
              icon: "Archive",
              danger: true,
              disabled: !visible || busy,
              onPress: () => (runningNow ? setConfirmArchive(true) : void archiveSession()),
            },
          ]
        : []),
    ];
  };
  async function archiveSession() {
    setConfirmArchive(false);
    let archived = false;
    await perform(async () => {
      await workspaceSession(paseo, sessionId, task.workspaceId);
      await agent.archive();
      archived = true;
    });
    if (archived && mounted.current) {
      toast.show(t("Session archived. Send it a message later to restore it."), { variant: "success" });
      onBack();
    }
  }
  async function submitInstruction(alternate = false) {
    noteInteraction();
    // The drawer must hold the latest text before the send clears it.
    flushReport();
    const { canWrite: writable, preferred: behavior, running: busyTurn, pendingPermission } = submitState.current;
    const instruction = draftBuffer.read();
    const attached = attachmentsRef.current;
    const images = attached.map(({ data, mimeType }) => ({ data, mimeType }));
    if (!mounted.current || !writable || (!instruction.trim() && !images.length)) return;
    const action = resolveSend(behavior, { running: busyTurn, alternate, pendingPermission });
    if (action.kind === "queue") {
      // Paseo parity: queued messages are sent when the current turn ends.
      void composer.queue(task.id, sessionId, instruction, images).then((item) =>
        rememberSentImages(item.id, attached.map((a) => a.uri)),
      ).catch((e) => {
        // Never lose the text or images: put them back in the composer.
        flushReport();
        onDraftChange(sessionId, restoredDraft(instruction, draftBuffer.read()));
        if (mounted.current) setAttachments([...attached, ...attachmentsRef.current].slice(0, maxImages));
        setError(message(e));
      });
      draftBuffer.clear(instruction);
      onDraftChange(sessionId, "", instruction);
      setAttachments([]);
      return;
    }
    await perform(async () => {
      const messageId = newMessageId();
      rememberSentImages(messageId, attached.map((a) => a.uri));
      // Clear at once, so text typed while the send is in flight is never
      // erased by it; a failed send puts the text back (PERFORMANCE-SPEC §2).
      draftBuffer.clear(instruction);
      onDraftChange(sessionId, "", instruction);
      setAttachments(attachmentsRef.current.filter((a) => !attached.includes(a)));
      try {
        await sendCardInstruction(paseo, task, sessionId, contextRead, instruction, action.activeTurnBehavior, images, messageId);
      } catch (e) {
        flushReport();
        const typed = draftBuffer.read();
        onDraftChange(sessionId, restoredDraft(instruction, typed));
        if (mounted.current) setAttachments([...attached, ...attachmentsRef.current].slice(0, maxImages));
        throw e;
      }
      if (mounted.current) tail.jumpToLatest();
      void current.refetch();
      void timeline.refetch();
    });
  }
  // Open agent questions and approvals, answered here instead of in Paseo (SESSION-QUESTION-SPEC).
  const requestsKey = JSON.stringify(active?.pendingPermissions ?? []);
  const requests = useMemo(() => pendingRequests(active), [requestsKey]);
  const respond = useStableCallback((request: PendingRequest, reply: PermissionReply) => {
    noteInteraction();
    void perform(async () => {
      const latest = await workspaceSession(paseo, sessionId, task.workspaceId, true);
      if (!pendingRequests(latest).some((r) => r.id === request.id))
        throw new Error(t("This request was already answered or withdrawn."));
      await agent.respondToPermission({ requestId: request.id, response: reply });
      toast.show(reply.behavior === "allow" && request.kind === "question" ? t("Answer sent") : t("Response sent"), { variant: "success" });
      if (mounted.current) tail.jumpToLatest();
      await current.refetch();
      void timeline.refetch();
    });
  });
  const tone = state ? sessionTone(colors, state, !!attention?.unread) : colors.foregroundMuted;
  const canSend = canWrite && (!!draft.trim() || attachments.length > 0);
  // Paseo parity: a running session with an empty composer shows Stop.
  const stopMode = running && !draft.trim() && !attachments.length && canWrite && !busy;
  const sendSize = touch ? 34 : 28;
  const inputMax = compact ? 108 : 160;
  // Touch has no Enter/Shift+Enter: the "When running" choice stays, the key hints go.
  const keyHints = !compact && Platform.OS === "web";
  const fitInput = (contentHeight: number) => {
    const next = Math.max(inputMin, Math.min(inputMax, Math.ceil(contentHeight)));
    setInputHeight((current) => (current === next ? current : next));
  };
  const renderComposer = () => {
    if (!active) return null;
    return (
      <>
          {!!queueEntry?.lastError && (
            <Notice>{t("Queued message not sent: {error}", { error: queueEntry.lastError })}</Notice>
          )}
          {queued.length > 0 && (
            <View style={{ gap: 4 }}>
              {queued.map((m) => (
                <QueuedRow
                  key={m.id}
                  menu={menuHandlers(openMenu, t("Queued message"), () => [
                    ...(running && !m.id.startsWith("pending-")
                      ? [{ id: "steer", label: t("Send now (steer)"), icon: "CornerDownRight", onPress: () =>
                          void composer.sendNow(task.id, sessionId, m.id)
                            .then(() => toast.show(t("Sent to the running turn"), { variant: "success" }))
                            .catch((e) => setError(message(e))) }]
                      : []),
                    { id: "edit", label: t("Edit"), icon: "Pencil", disabled: m.id.startsWith("pending-") || !!m.images?.length, onPress: () =>
                        void composer.remove(sessionId, m.id).then(() =>
                          onDraftChange(sessionId, draftBuffer.read().trim() ? `${draftBuffer.read()}\n${m.text}` : m.text)) },
                    { kind: "separator", id: "s" },
                    { id: "remove", label: t("Remove"), icon: "Trash2", danger: true, disabled: m.id.startsWith("pending-"), onPress: () =>
                        void composer.remove(sessionId, m.id).catch((e) => setError(message(e))) },
                  ])}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space[2],
                    paddingLeft: space[3],
                    paddingRight: 2,
                    minHeight: 30,
                    borderRadius: radius.md,
                    backgroundColor: colors.surface2,
                  }}
                >
                  <Icon name="Clock" size={13} color={colors.foregroundMuted} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Label size={font.sm} lines={1} selectable={false}>
                      {m.text.replace(/\s+/g, " ") || (m.images?.length === 1 ? t("Image") : tn(m.images?.length || 0, "{n} image", "{n} images"))}
                    </Label>
                  </View>
                  {!!m.images?.length && !!m.text.trim() && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                      <Icon name="Image" size={12} color={colors.foregroundMuted} />
                      <Label muted size={font.xs} selectable={false}>{m.images.length}</Label>
                    </View>
                  )}
                  <Label muted size={font.xs} selectable={false}>{t("Queued")}</Label>
                  {running && !m.id.startsWith("pending-") && (
                    <Button
                      quiet
                      icon="CornerDownRight"
                      label={t("Send now and steer the running turn")}
                      onPress={() =>
                        void composer
                          .sendNow(task.id, sessionId, m.id)
                          .then(() => toast.show(t("Sent to the running turn"), { variant: "success" }))
                          .catch((e) => setError(message(e)))
                      }
                    >
                      {t("Steer")}</Button>
                  )}
                  <IconButton
                    icon="X"
                    size={26}
                    label={t("Remove queued message")}
                    disabled={m.id.startsWith("pending-")}
                    onPress={() => void composer.remove(sessionId, m.id).catch((e) => setError(message(e)))}
                  />
                </QueuedRow>
              ))}
            </View>
          )}
          <View
            ref={setComposerNode}
            // Text spans the full width; actions sit on their own row below (attach left, send right).
            style={{
              gap: space[1],
              paddingHorizontal: space[1.5],
              paddingTop: space[2],
              paddingBottom: space[1.5],
              borderWidth: 1,
              borderColor: focused ? colors.foregroundMuted : colors.border,
              borderRadius: 18,
              backgroundColor: canWrite ? colors.surface0 : colors.surface1,
            }}
          >
            {attachments.length > 0 && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[1.5], paddingHorizontal: space[1.5], paddingTop: 2 }}>
                {attachments.map((a) => (
                  <AttachmentThumb key={a.id} attachment={a} onRemove={() => setAttachments(attachmentsRef.current.filter((x) => x.id !== a.id))} />
                ))}
              </View>
            )}
            <View style={{ minWidth: 0, paddingHorizontal: space[1.5] }}>
            {Platform.OS === "web" && (
              // Invisible copy of the draft at the input's width and font: its height is the input's height.
              <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, opacity: 0 }}>
                <NativeText
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  onLayout={(e) => fitInput(e.nativeEvent.layout.height)}
                  style={{ paddingVertical: inputPad, fontSize: font.base, lineHeight: 20 }}
                >
                  {draft ? (draft.endsWith("\n") ? `${draft} ` : draft) : " "}
                </NativeText>
              </View>
            )}
            <TextInput
              key={ownInput ? `input-${inputKey}` : "input"}
              ref={inputRef as never}
              accessibilityLabel={t("Follow-up instruction")}
              accessibilityHint={
                Platform.OS === "web"
                  ? t("Enter sends; Shift and Enter inserts a new line.")
                  : t("Use the keyboard Send action or the send button.")
              }
              {...(ownInput ? { defaultValue: inputSeed } : { value: draft })}
              onChangeText={(text) => {
                draftBuffer.edit(text);
                reportDraft(text);
              }}
              onFocus={() => {
                onComposerFocus?.(sessionId);
                setFocused(true);
                keyboard.onInputFocus();
                if (attention?.unread) noteInteraction();
              }}
              onBlur={() => {
                setFocused(false);
                keyboard.onInputBlur();
              }}
              multiline
              autoFocus={refocus.current}
              blurOnSubmit={false}
              submitBehavior={Platform.OS === "web" ? "newline" : "submit"}
              returnKeyType="send"
              onKeyPress={(event) => {
                if (Platform.OS !== "web") return;
                const action = composerEnterAction(event.nativeEvent as ComposerKey);
                if (action === "native") return;
                event.preventDefault();
                if (action === "submit" || action === "alternate") void submitInstruction(action === "alternate");
              }}
              onSubmitEditing={(event) => {
                if (Platform.OS === "web") return;
                const action = composerEnterAction({ ...event.nativeEvent, key: "Enter" });
                if (action === "submit") void submitInstruction();
              }}
              scrollEnabled
              editable={!!active}
              placeholder={
                active.archivedAt
                  ? t("Send a message to restore this session…")
                  : compact
                    ? t("Message this session…")
                    : t("Tell this session what to do next…")
              }
              placeholderTextColor={colors.foregroundMuted}
              style={{
                // Native multiline inputs size themselves within min/max on the
                // UI thread; a JS height round trip re-rendered the session on
                // every wrapped line and lagged a frame (PERFORMANCE-SPEC §3).
                // Web: the mirror above measures (a textarea never shrinks).
                ...(Platform.OS === "web" ? { height: inputHeight } : {}),
                minHeight: inputMin,
                maxHeight: inputMax,
                minWidth: 0,
                paddingVertical: inputPad,
                fontSize: font.base,
                lineHeight: 20,
                color: colors.foreground,
                textAlignVertical: "top",
                outlineStyle: "none",
              } as never}
            />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            {imageInputSupported ? (
              <IconButton
                icon="ImagePlus"
                size={sendSize}
                label={t("Attach images")}
                disabled={!canWrite || attachments.length >= maxImages}
                onPress={() => void pickImageFiles().then((files) => addImages.current(files))}
              />
            ) : (
              <View />
            )}
            {stopMode ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Stop session")}
                onPress={() => void config.apply({ stop: true }, t("Session stopped"))}
                hitSlop={6}
                style={(state) => {
                  const { pressed } = state;
                  return {
                    ...noFocusRing,
                    width: sendSize,
                    height: sendSize,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: sendSize / 2,
                    backgroundColor: colors.foreground,
                    transform: [{ scale: pressed ? 0.92 : 1 }],
                  };
                }}
              >
                <Icon name="Square" size={touch ? 14 : 12} color={colors.surface0} />
              </Pressable>
            ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={busy ? t("Sending instruction") : t("Send instruction")}
              accessibilityHint={running ? t(sendBehaviorText[preferred].detail) : undefined}
              accessibilityState={{ disabled: !canSend, busy }}
              disabled={!canSend}
              onPress={() => void submitInstruction()}
              hitSlop={6}
              style={(state) => {
                const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover || focused;
                return {
                  ...noFocusRing,
                  width: sendSize,
                  height: sendSize,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: sendSize / 2,
                  backgroundColor: canSend || busy
                    ? colors.accent
                    : tint(colors.foregroundMuted, 0.14),
                  opacity: canSend && hovered && !pressed ? 0.9 : 1,
                  transform: [{ scale: canSend && pressed ? 0.92 : 1 }],
                };
              }}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.accentForeground} />
              ) : (
                <Icon
                  name={running ? (preferred === "queue" ? "ListPlus" : preferred === "interrupt" ? "CornerDownLeft" : "ArrowUp") : "ArrowUp"}
                  size={touch ? 18 : 16}
                  color={canSend ? colors.accentForeground : colors.foregroundMuted}
                />
              )}
            </Pressable>
            )}
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], zIndex: 2 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <ComposerChips
                config={config}
                menu={chipMenu}
                setMenu={setChipMenu}
                inline={false}
                disabled={!!active.archivedAt}
                onOpenInPaseo={
                  typeof navigation?.openAgent === "function"
                    ? () => {
                        setChipMenu(null);
                        openNativeSession(navigation, sessionId, hostId);
                      }
                    : undefined
                }
              />
            </View>
          </View>
      </>
    );
  };

  return (
    <View
      ref={keyboard.ref}
      onLayout={keyboard.onLayout}
      style={{ flex: 1, minHeight: 0, minWidth: 0 }}
      // Any press inside the session counts as looking at it (does not claim the responder).
      onPointerDown={() => attention?.unread && !holdUnread.current && noteInteraction()}
    >
      <View
        style={{
          paddingLeft: space[2],
          paddingRight: space[2],
          paddingVertical: space[2],
          flexDirection: "row",
          alignItems: "center",
          gap: space[1],
          borderBottomWidth: 1,
          borderColor: colors.border,
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <IconButton icon="ArrowLeft" label={t("Back to task")} onPress={onBack} />
        <View style={{ flex: 1, minWidth: 0, paddingHorizontal: space[1] }}>
          <Label medium size={font.base} lines={1}>
            {active?.title || t("Session preview")}
          </Label>
          {state ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], minWidth: 0 }}>
              <PulseDot color={tone} size={7} active={state.active} />
              <View style={{ flexShrink: 1, minWidth: 0 }}>
                <Label muted size={font.sm} lines={1} selectable={false}>
                  <Label size={font.sm} medium color={state.active || state.label === "Error" || "waiting" in state ? tone : colors.foregroundMuted} selectable={false}>
                    {t(state.label)}
                  </Label>
                  {reads.query.isPending
                    ? ` · ${t("Loading read state…")}`
                    : reads.query.isError
                      ? ` · ${t("Read state unavailable")}`
                      : !attention?.readKnown
                        ? ` · ${t("Read state unknown")}`
                        : attention.unread
                          ? ` · ${t("Unread")}`
                          : ""}
                  {active?.provider ? ` · ${active.provider}${active.model ? `/${active.model}` : ""}` : ""}
                </Label>
              </View>
            </View>
          ) : (
            <Label muted size={font.sm}>{task.title}</Label>
          )}
        </View>
        {typeof navigation?.openAgent === "function" && (
          <IconButton
            icon="ArrowUpRight"
            label={t("Open in Paseo")}
            disabled={!visible || !active || current.isError || busy}
            onPress={() =>
              void perform(async () => {
                await workspaceSession(paseo, sessionId, task.workspaceId);
                if (mounted.current)
                  openNativeSession(navigation, sessionId, hostId);
              })
            }
          />
        )}
        {active && (
          <IconButton
            icon="Ellipsis"
            label={t("More session actions")}
            onPress={(event) => openMenu?.(eventPoint(event), active.title || t("Session"), sessionActions())}
          />
        )}
        {onClose && <IconButton icon="X" label={t("Close side bar")} onPress={onClose} />}
      </View>
      {active && showTools && (
        <MotionReveal transitionKey="session-tools" distance={8} style={{ flexShrink: 0 }}>
          <View
            style={{
              margin: space[3],
              marginBottom: 0,
              padding: space[3],
              gap: space[2],
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface1,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
              <Icon name="Wrench" size={14} color={colors.foregroundMuted} />
              <Label medium size={font.md}>{t("Kanban tools")}</Label>
              <View style={{ flex: 1 }} />
              <Dot color={tools.data?.ready ? colors.statusSuccess : colors.statusWarning} size={7} />
              <Label muted size={font.sm}>{tools.data?.ready ? t("Ready") : t("Not ready")}</Label>
            </View>
            <Label muted size={font.sm}>
              {t("Lets this agent read its task, report progress and move it between Design, Development and Test, to Blocked or to In review. You confirm Done or Cancelled.")}</Label>
            <Label muted size={font.sm}>
              {access.data?.methods.length
                ? t("Configuration provided: {methods}", { methods: access.data.methods.join(" + ").toUpperCase() })
                : t("No Kanban configuration recorded.")}
              {" · "}
              {access.data?.lastSuccessAt
                ? t("Last call: {lastAction} {time}", { lastAction: access.data.lastAction ?? "", time: relativeTime(access.data.lastSuccessAt) })
                : t("No successful tool call yet.")}
            </Label>
            {access.error && <Notice>{message(access.error)}</Notice>}
            {tools.error && <Notice>{message(tools.error)}</Notice>}
            {access.data && !access.data.ready && (
              <Notice tone="warning">{access.data.reason}</Notice>
            )}
            <View style={{ flexDirection: "row" }}>
              <Button
                icon="Send"
                disabled={!canWrite || !tools.data?.ready}
                onPress={() =>
                  void perform(async () => {
                    const latest = await workspaceSession(
                      paseo,
                      sessionId,
                      task.workspaceId,
                      true,
                    );
                    const prepared = await prepareExisting({
                      id: task.id,
                      agentId: sessionId,
                    });
                    await agent.send(
                      prepared.instructions,
                      latest.status === "running"
                        ? { activeTurnBehavior: "steer" }
                        : {},
                    );
                    toast.show(t("Kanban instructions sent"), { variant: "success" });
                    await access.refetch();
                    await current.refetch();
                  })
                }
              >
                {t("Send Kanban work instructions")}</Button>
            </View>
          </View>
        </MotionReveal>
      )}
      <ScrollView
        testID="session-output"
        {...verticalScroll}
        ref={tail.scrollRef}
        style={{ flex: 1, minHeight: 0, minWidth: 0 }}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        // Web: react-native-web's "on-drag" blurs the focused input on every
        // scroll event, including the follow-tail scroll when output arrives,
        // which kicked the user out of the composer while a session ran.
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : Platform.OS === "web" ? "none" : "on-drag"}
        scrollEventThrottle={16}
        onScroll={tail.onScroll}
        onScrollBeginDrag={tail.onScrollBeginDrag}
        onScrollEndDrag={tail.onScrollEndDrag}
        onContentSizeChange={tail.scrollToTail}
        onLayout={tail.scrollToTail}
        contentContainerStyle={{ ...verticalContent, padding: space[4], paddingBottom: space[5] + keyboard.inset, gap: space[4] }}
      >
        {current.isPending && <Label muted>{t("Loading session…")}</Label>}
        {current.error && <Notice>{message(current.error)}</Notice>}
        {!current.isPending && !current.error && !belongs && (
          <Notice tone="warning">
            {t("Session is unavailable or belongs to a different workspace. Return to the task to choose another session.")}</Notice>
        )}
        {active && (
          <>
            {unavailable && (
              <Notice tone="warning">
                {unavailableReason ||
                  t("Task or workspace is unavailable. Return to task details for more information.")}
              </Notice>
            )}
            {!!active.lastError && <Notice>{active.lastError}</Notice>}
            {active.providerUnavailable && (
              <Notice tone="warning">
                {t("This session's provider is unavailable. Open in Paseo to inspect its configuration.")}</Notice>
            )}
            {!!active.archivedAt && (
              <Notice tone="info">
                {t("This session is archived. Sending a message restores it and continues the conversation.")}</Notice>
            )}
            {reads.query.error && <Notice>{message(reads.query.error)}</Notice>}
            {attention?.unread && !attention.token && (
              <Notice tone="info">
                {t("This host did not provide a readable attention timestamp. Open in Paseo to acknowledge this session.")}</Notice>
            )}
            <View style={{ alignItems: "center" }}>
              <Label muted size={font.xs} selectable={false}>
                {t("Recent output · open in Paseo for the full conversation")}</Label>
            </View>
            {timeline.error && (
              <Notice>
                {message(timeline.error)}
                {output.length ? ` ${t("Showing the last known output.")}` : ""}
              </Notice>
            )}
            {!settled ? null : timeline.isPending ? (
              <Label muted>{t("Loading output…")}</Label>
            ) : !output.length ? (
              timeline.error ? null : (
                <View style={{ alignItems: "center", paddingVertical: space[6] }}>
                  <Label muted>{t("No output yet.")}</Label>
                </View>
              )
            ) : (
              <Enter distance={0} style={{ gap: space[4] }}>
                <TranscriptBlocks blocks={blocks} live={!!state?.active} taskId={task.id} agentId={sessionId} />
              </Enter>
            )}
            {state?.active && blocks.at(-1)?.kind !== "activity" && (
              <View
                testID="session-running-tail"
                style={{
                  flexDirection: "row",
                  gap: space[2],
                  alignItems: "center",
                  minHeight: 24,
                }}
              >
                <ActivityIndicator size="small" color={colors.accent} />
                <Label muted size={font.md}>
                  {active.status === "initializing"
                    ? t("Starting session…")
                    : t("Agent is working…")}
                </Label>
              </View>
            )}
          </>
        )}
        {!active && !!error && <Notice>{error}</Notice>}
      </ScrollView>
      {!!chipMenu && (
        <Pressable
          accessibilityLabel={t("Close menu")}
          onPress={() => setChipMenu(null)}
          style={{ ...noFocusRing, position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 }}
        />
      )}
      {active && (
        <Animated.View
          testID="session-composer"
          style={{
            flexShrink: 0,
            minWidth: 0,
            // Rides above the keyboard on the native driver; opaque so the transcript does not show through.
            backgroundColor: colors.surface0,
            transform: [{ translateY: keyboard.translate }],
            // Above the dismiss layer so chip menus can open upward over the transcript.
            zIndex: 25,
            paddingHorizontal: space[3],
            paddingTop: space[2],
            paddingBottom: space[3],
            gap: space[2],
          }}
        >
          {!!error && (
            <Notice>{error}</Notice>
          )}
          {latest.item && (
            // Floats above the composer so it never pushes the input around.
            <Animated.View
              pointerEvents={latest.active ? "box-none" : "none"}
              style={{
                position: "absolute",
                top: -40,
                right: space[3],
                zIndex: 2,
                opacity: latest.progress,
                transform: [{ translateY: lerp(latest.progress, [6, 0]) }],
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Jump to latest")}
                onPress={tail.jumpToLatest}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  height: 30,
                  paddingHorizontal: space[2] + 2,
                  borderRadius: 15,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface0,
                  shadowColor: "#000",
                  shadowOpacity: 0.08,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 2 },
                }}
              >
                <Icon name="ArrowDown" size={13} color={colors.foreground} />
                <Label size={font.sm} medium selectable={false}>{t("Latest")}</Label>
              </Pressable>
            </Animated.View>
          )}
          <PendingRequests requests={requests} disabled={!canWrite || busy} compact={compact} onRespond={respond} />
          {renderComposer()}
          {(keyHints || running || queued.length > 0) && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: 20 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                {keyHints && (
                  <Label muted size={font.xs} lines={1} selectable={false}>
                    {running
                      ? t("Enter: {action} · ⌘/Ctrl+Enter: {other} · Shift+Enter: new line", { action: t(sendBehaviorText[preferred].label), other: preferred === "queue" ? t("Send now") : t("Queue") })
                      : t("Enter to send · Shift+Enter for a new line")}
                  </Label>
                )}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("When running: {label}. Change", { label: t(sendBehaviorText[preferred].label) })}
                onPress={() => setModePicker(true)}
                hitSlop={6}
                style={{ flexDirection: "row", alignItems: "center", gap: 2 }}
              >
                <Label muted size={font.xs} selectable={false}>
                  {t("When running:")}{" "}<Label size={font.xs} medium selectable={false}>{t(sendBehaviorText[preferred].label)}</Label>
                </Label>
                <Icon name="ChevronDown" size={12} color={colors.foregroundMuted} />
              </Pressable>
            </View>
          )}
        </Animated.View>
      )}
      <Modal
        open={modePicker && visible}
        title={t("When the session is running")}
        onOpenChange={(open) => {
          if (!open) setModePicker(false);
        }}
      >
        <Modal.Content contentContainerStyle={{ padding: space[3], gap: space[1] }}>
          <Theme.Provider value={theme}>
            {sendBehaviors.map((b) => (
              <Row
                key={b}
                title={t(sendBehaviorText[b].label)}
                detail={t(sendBehaviorText[b].detail)}
                selected={preferred === b}
                onPress={() => {
                  setPreferred(b);
                  setModePicker(false);
                }}
              />
            ))}
            <View style={{ paddingHorizontal: space[3], paddingTop: space[1] }}>
              <Label muted size={font.xs}>
                {t("Same options as Paseo's “Default send” setting. Plugins cannot read that setting, so choose it here.")}</Label>
            </View>
          </Theme.Provider>
        </Modal.Content>
      </Modal>
      {renaming && visible && active && (
        <RenameSession
          title={active.title || ""}
          onSave={(title) => config.apply({ title }, t("Session renamed"))}
          onClose={() => setRenaming(false)}
        />
      )}
      <Modal
        open={confirmArchive && visible}
        title={t("Archive running session?")}
        onOpenChange={(open) => {
          if (!open) setConfirmArchive(false);
        }}
      >
        <Modal.Content>
          <Theme.Provider value={theme}>
            <Label size={font.base}>
              {t("Archiving interrupts the current turn. The conversation is kept; send it a message later to restore it.")}</Label>
            <Actions>
              <Button quiet onPress={() => setConfirmArchive(false)}>{t("Cancel")}</Button>
              <Button danger icon="Archive" onPress={() => void archiveSession()}>{t("Archive")}</Button>
            </Actions>
          </Theme.Provider>
        </Modal.Content>
      </Modal>
    </View>
  );
}

type OutputEntry = ReturnType<typeof recentSessionOutput>[number];
const sameEntry = (a: OutputEntry, b: OutputEntry) =>
  a === b || (a.key === b.key && a.text === b.text && a.author === b.author && a.messageId === b.messageId);

/**
 * The transcript, memoized: composer state (focus, keyboard, drafts) and polls
 * that return the same output do not re-render it, and each block re-renders
 * only when its own content changes (PERFORMANCE-SPEC §3).
 */
const TranscriptBlocks = memo(function TranscriptBlocks({
  blocks,
  live,
  taskId,
  agentId,
}: {
  blocks: TranscriptBlock[];
  live: boolean;
  taskId: string;
  agentId: string;
}) {
  return (
    <>
      {blocks.map((block, index) =>
        block.kind === "activity" ? (
          <ActivityBlock key={block.key} block={block} live={live && index === blocks.length - 1} />
        ) : (
          <TranscriptEntry key={block.key} entry={block.entry} taskId={taskId} agentId={agentId} />
        ),
      )}
    </>
  );
});

const TranscriptEntry = memo(function TranscriptEntry({
  entry,
  taskId,
  agentId,
}: {
  entry: OutputEntry;
  taskId: string;
  agentId: string;
}) {
  const { colors } = useTheme();
  const { text, images } = useMemo(
    () => (entry.author === "You" || entry.author === "Agent" ? extractImages(entry.text) : { text: entry.text, images: [] }),
    [entry.author, entry.text],
  );
  const sent = entry.author === "You" ? sentImages(entry.messageId) : [];
  const pictures = [...images, ...sent.map((src, i) => ({ src, alt: t("Image {n}", { n: i + 1 }) }))].map((image) => (
    // Your own images stay compact beside your message.
    <SessionImage key={image.src} taskId={taskId} agentId={agentId} image={image} maxWidth={entry.author === "You" ? 200 : 360} />
  ));
  if (entry.author === "You" && !text && !pictures.length) return null;
  if (entry.author === "You")
    return (
      <View style={{ alignItems: "flex-end", paddingLeft: space[6] + space[2], gap: space[1.5] }}>
        {!!text && (
          <View
            accessibilityLabel={t("You")}
            style={{
              maxWidth: "100%",
              paddingHorizontal: space[3],
              paddingVertical: space[2],
              borderRadius: radius.xl,
              backgroundColor: colors.surface2,
            }}
          >
            <Label size={font.base}>{text}</Label>
          </View>
        )}
        {pictures.length > 0 && <View style={{ width: "100%", alignItems: "flex-end", gap: space[1.5] }}>{pictures}</View>}
      </View>
    );
  if (entry.author === "Agent")
    return (
      <View accessibilityLabel={t("Agent")} style={{ minWidth: 0, gap: space[2] }}>
        {!!text && <SessionMarkdown text={text} />}
        {pictures}
      </View>
    );
  return (
    <View style={{ gap: 2, minWidth: 0 }}>
      <Label muted size={font.xs}>{t(entry.author)}</Label>
      <Label muted size={font.md}>{entry.text}</Label>
    </View>
  );
}, (a, b) => a.taskId === b.taskId && a.agentId === b.agentId && sameEntry(a.entry, b.entry));

/** An image waiting to be sent: thumbnail with a remove button. */
function AttachmentThumb({ attachment, onRemove }: { attachment: Attachment; onRemove(): void }) {
  const { colors } = useTheme();
  return (
    <Enter distance={4}>
      <View style={{ width: 52, height: 52 }}>
        <Image
          source={{ uri: attachment.uri }}
          accessibilityLabel={attachment.name}
          resizeMode="cover"
          style={{ width: 52, height: 52, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2 }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Remove {name}", { name: attachment.name })}
          onPress={onRemove}
          hitSlop={6}
          style={{
            ...noFocusRing,
            position: "absolute",
            top: -5,
            right: -5,
            width: 18,
            height: 18,
            borderRadius: 9,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.foreground,
            borderWidth: 1.5,
            borderColor: colors.surface0,
          }}
        >
          <Icon name="X" size={10} color={colors.surface0} />
        </Pressable>
      </View>
    </Enter>
  );
}

/**
 * Consecutive thinking and tool calls, collapsed by default to one summary
 * line. Expanded, each step shows a short preview (thinking is clipped; the
 * full transcript lives in Paseo).
 */
const ActivityBlock = memo(function ActivityBlock({ block, live }: { block: Extract<TranscriptBlock, { kind: "activity" }>; live: boolean }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const turn = useMotionValue(open ? 1 : 0, motionDuration.feedback);
  const latest = block.items.at(-1);
  return (
    <View accessibilityLabel={t("Agent activity")} style={{ minWidth: 0, marginVertical: -space[1] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${activitySummary(block)}. ${open ? t("Collapse") : t("Expand")}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={(state) => {
          const { hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
          return {
            ...noFocusRing,
            flexDirection: "row",
            alignItems: "center",
            gap: space[1.5],
            alignSelf: "flex-start",
            maxWidth: "100%",
            minHeight: touch ? 32 : 24,
            paddingHorizontal: space[1.5],
            marginHorizontal: -space[1.5],
            borderRadius: radius.md,
            backgroundColor: hover || focused ? colors.surface2 : "transparent",
          };
        }}
      >
        {live ? (
          <PulseDot color={colors.accent} size={7} />
        ) : (
          <Icon name={block.tools ? "Wrench" : "Brain"} size={12} color={colors.foregroundMuted} />
        )}
        <Label muted size={font.sm} medium selectable={false}>
          {live ? t("Working") : activitySummary(block)}
        </Label>
        {live && latest && (
          <View style={{ flexShrink: 1, minWidth: 0 }}>
            <Label muted size={font.sm} lines={1} mono={latest.author === "Tool"} selectable={false}>
              {latest.author === "Tool" ? latest.text : t("Thinking…")}
            </Label>
          </View>
        )}
        <Animated.View style={{ transform: [{ rotate: lerp(turn, ["0deg", "90deg"]) }] }}>
          <Icon name="ChevronRight" size={12} color={colors.foregroundMuted} />
        </Animated.View>
      </Pressable>
      {open && (
        <Enter distance={4} style={{ marginTop: space[1], marginLeft: 5, paddingLeft: space[3], borderLeftWidth: 1, borderColor: colors.border, gap: space[1.5] }}>
          {block.items.map((item) =>
            item.author === "Tool" ? (
              <View key={item.key} accessibilityLabel={t("Tool")} style={{ flexDirection: "row", alignItems: "center", gap: space[2], minWidth: 0 }}>
                <Icon name="Wrench" size={12} color={colors.foregroundMuted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label muted mono size={font.sm} lines={1}>{item.text}</Label>
                </View>
              </View>
            ) : (
              <View key={item.key} accessibilityLabel={t("Thinking")} style={{ flexDirection: "row", gap: space[2], minWidth: 0 }}>
                <View style={{ paddingTop: 2 }}>
                  <Icon name="Brain" size={12} color={colors.foregroundMuted} />
                </View>
                <View style={{ flex: 1, minWidth: 0, opacity: 0.8 }}>
                  <Label muted italic size={font.sm} lines={2}>{item.text}</Label>
                </View>
              </View>
            ),
          )}
        </Enter>
      )}
    </View>
  );
}, (a, b) =>
  a.live === b.live &&
  a.block.key === b.block.key &&
  a.block.items.length === b.block.items.length &&
  a.block.items.every((item, i) => sameEntry(item, b.block.items[i])));

/** A queued message row: enters with a short rise, supports a context menu. */
function QueuedRow({ menu, style, children }: { menu: object; style: object; children: ReactNode }) {
  const enter = useMotionValue(1, motionDuration.forward, 0);
  return (
    <Animated.View
      style={{
        opacity: enter,
        transform: [{ translateY: lerp(enter, [6, 0]) }],
      }}
    >
      <Pressable {...menu} accessibilityRole="none" style={{ ...noFocusRing, ...style }}>
        {children}
      </Pressable>
    </Animated.View>
  );
}
