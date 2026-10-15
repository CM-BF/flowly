import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
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
  useSettings,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { Task, BoardEvent } from "../shared/model";
import * as rpc from "../shared/rpc";
import {
  Button,
  Label,
  Choices,
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
import { extractImages } from "../shared/images";
import { SessionImage } from "./session-image";
import { menuHandlers, useMenuOpener } from "./context-menu";
import { boardViewSettings, boardViewValues } from "../shared/settings";
import { ComposerChips, useSessionConfig, type ChipMenuId } from "./session-settings";
import {
  openNativeSession,
  recentSessionOutput,
  sessionState,
} from "./session-state";
import { sendCardInstruction, workspaceSession } from "./session";
import { SessionMarkdown } from "./session-content";
import { coalescedRefresh, useSessionFollowTail } from "./session-follow";
import { useSessionReads } from "./session-reads";
import { sessionAttention } from "../shared/session-attention";
import { MotionReveal, PulseDot, motionDuration, useMotionPresence, useMotionValue } from "./motion";
import { composerEnterAction, createDraftBuffer, type ComposerKey } from "./session-input";

export function SessionPreview({
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
  onBack,
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
  onBack(): void;
  refresh(): void;
  visible?: boolean;
}) {
  const theme = useTheme(),
    { colors } = theme,
    paseo = usePaseo(),
    contextRead = useRpc(rpc.taskContext),
    healthRead = useRpc(rpc.toolsHealth),
    prepareExisting = useRpc(rpc.prepareExisting),
    accessRead = useRpc(rpc.accessState);
  const reads = useSessionReads();
  const toast = useToast();
  const [draftBuffer] = useState(() => createDraftBuffer(draft));
  draftBuffer.sync(draft);
  const [sending, setSending] = useState(false),
    [error, setError] = useState(""),
    [showTools, setShowTools] = useState(false),
    [inputHeight, setInputHeight] = useState(36),
    [focused, setFocused] = useState(false),
    [composerOpen, setComposerOpen] = useState(false),
    [confirmArchive, setConfirmArchive] = useState(false),
    [chipMenu, setChipMenu] = useState<ChipMenuId | null>(null),
    [modePicker, setModePicker] = useState(false);
  useShortcutBlock(focused);
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
  const previewId = useId();
  const agent = useMemo(() => paseo.agents.ref(sessionId), [paseo, sessionId]);
  const current = useQuery({
    queryKey: ["ultra", "agent", sessionId, "preview", previewId],
    gcTime: 0,
    queryFn: () => agent.refresh(),
    enabled: visible,
    refetchInterval: 2000,
  });
  const actor = current.data?.agent;
  const belongs = !!actor && actor.workspaceId === task.workspaceId;
  const active = belongs ? actor : undefined;
  const timeline = useQuery({
    queryKey: ["ultra", "timeline", sessionId],
    queryFn: async () => {
      const response = await agent.timeline.refetch({
        direction: "tail",
        limit: 35,
        projection: "projected",
      });
      if (response.error) throw new Error(response.error);
      return response;
    },
    enabled: visible && belongs && !current.isError,
    refetchInterval: 3000,
  });
  const tools = useQuery({
    queryKey: ["ultra", "tools"],
    queryFn: () => healthRead({}),
    enabled: visible && belongs,
    refetchInterval: 5000,
  });
  const access = useQuery({
    queryKey: ["ultra", "access", task.id, sessionId],
    queryFn: () => accessRead({ id: task.id, agentId: sessionId }),
    enabled: visible && belongs && !current.isError,
    refetchInterval: 3000,
  });
  useEffect(() => {
    if (!visible || !belongs || current.isError) return;
    let alive = true;
    const updates = coalescedRefresh(() => {
      void timeline.refetch();
      void current.refetch();
    });
    const subscription = agent.timeline.subscribe(() => {
      if (alive) updates.trigger();
    });
    void subscription.ready.catch((e) => {
      if (alive) setError(message(e));
    });
    return () => {
      alive = false;
      updates.dispose();
      subscription();
    };
  }, [agent, belongs, current.isError, visible]);
  const state = active ? sessionState(active, events) : null;
  const attention = active
    ? sessionAttention(active, task.id, reads.receipts, events)
    : null;
  const output = useMemo(
    () => recentSessionOutput(timeline.data?.entries || []),
    [timeline.data?.entries],
  );
  const outputSignature = JSON.stringify(
    output.map((entry) => [entry.key, entry.text]),
  );
  useEffect(() => {
    tail.scrollToTail();
  }, [outputSignature, active?.status]);
  const busy = sending || pending;
  const canWrite =
    visible &&
    !!active &&
    !active.providerUnavailable &&
    !unavailable &&
    !current.isError &&
    !busy;
  const view = useSettings(boardViewSettings);
  const preferred: SendBehavior = view.status === "ready" ? boardViewValues(view.values).sendBehavior : "steer";
  const setPreferred = (next: SendBehavior) => {
    if (view.status === "ready" && boardViewValues(view.values).sendBehavior !== next)
      void view.save({ ...boardViewValues(view.values), sendBehavior: next }, view.revision);
  };
  const composer = useComposer(visible);
  const openMenu = useMenuOpener();
  const latest = useMotionPresence(!tail.following ? true : undefined, !tail.following ? "latest" : "");
  const config = useSessionConfig(task.id, active, visible, () => void current.refetch());
  const queueEntry = composer.entry(sessionId);
  const queued = queueEntry?.queue || [];
  const running = active?.status === "running" || active?.status === "initializing";
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
  async function archiveSession() {
    setConfirmArchive(false);
    let archived = false;
    await perform(async () => {
      await workspaceSession(paseo, sessionId, task.workspaceId);
      await agent.archive();
      archived = true;
    });
    if (archived && mounted.current) {
      toast.show("Session archived. Send it a message later to restore it.", { variant: "success" });
      onBack();
    }
  }
  async function submitInstruction(alternate = false) {
    const { canWrite: writable, preferred: behavior, running: busyTurn, pendingPermission } = submitState.current;
    const instruction = draftBuffer.read();
    if (!mounted.current || !writable || !instruction.trim()) return;
    const action = resolveSend(behavior, { running: busyTurn, alternate, pendingPermission });
    if (action.kind === "queue") {
      // Paseo parity: queued messages are sent when the current turn ends.
      void composer.queue(task.id, sessionId, instruction).catch((e) => {
        // Never lose the text: put it back in the composer.
        onDraftChange(sessionId, instruction);
        setError(message(e));
      });
      draftBuffer.clear(instruction);
      onDraftChange(sessionId, "", instruction);
      setComposerOpen(false);
      return;
    }
    await perform(async () => {
      await sendCardInstruction(paseo, task, sessionId, contextRead, instruction, action.activeTurnBehavior);
      draftBuffer.clear(instruction);
      onDraftChange(sessionId, "", instruction);
      if (mounted.current) setComposerOpen(false);
      if (mounted.current) tail.jumpToLatest();
      await current.refetch();
      await timeline.refetch();
    });
  }
  const tone = state ? sessionTone(colors, state, !!attention?.unread) : colors.foregroundMuted;
  const canSend = canWrite && !!draft.trim();
  // Paseo parity: a running session with an empty composer shows Stop.
  const stopMode = running && !draft.trim() && canWrite && !busy;
  const sendSize = touch ? 34 : 28;
  // Native phones type in the host bottom sheet: it tracks the real IME height
  // (candidate bars, keyboard switches) which plugin-side keyboard events cannot.
  const sheetComposer = Platform.OS !== "web";
  const renderComposer = (inSheet: boolean) => {
    if (!active) return null;
    return (
      <>
          {!!queueEntry?.lastError && (
            <Notice>Queued message not sent: {queueEntry.lastError}</Notice>
          )}
          {queued.length > 0 && (
            <View style={{ gap: 4 }}>
              {queued.map((m) => (
                <QueuedRow
                  key={m.id}
                  menu={menuHandlers(openMenu, "Queued message", () => [
                    ...(running && !m.id.startsWith("pending-")
                      ? [{ id: "steer", label: "Send now (steer)", icon: "CornerDownRight", onPress: () =>
                          void composer.sendNow(task.id, sessionId, m.id)
                            .then(() => toast.show("Sent to the running turn", { variant: "success" }))
                            .catch((e) => setError(message(e))) }]
                      : []),
                    { id: "edit", label: "Edit", icon: "Pencil", disabled: m.id.startsWith("pending-"), onPress: () =>
                        void composer.remove(sessionId, m.id).then(() =>
                          onDraftChange(sessionId, draft.trim() ? `${draft}\n${m.text}` : m.text)) },
                    { kind: "separator", id: "s" },
                    { id: "remove", label: "Remove", icon: "Trash2", danger: true, disabled: m.id.startsWith("pending-"), onPress: () =>
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
                    <Label size={font.sm} lines={1} selectable={false}>{m.text.replace(/\s+/g, " ")}</Label>
                  </View>
                  <Label muted size={font.xs} selectable={false}>Queued</Label>
                  {running && !m.id.startsWith("pending-") && (
                    <Button
                      quiet
                      icon="CornerDownRight"
                      label="Send now and steer the running turn"
                      onPress={() =>
                        void composer
                          .sendNow(task.id, sessionId, m.id)
                          .then(() => toast.show("Sent to the running turn", { variant: "success" }))
                          .catch((e) => setError(message(e)))
                      }
                    >
                      Steer
                    </Button>
                  )}
                  <IconButton
                    icon="X"
                    size={26}
                    label="Remove queued message"
                    disabled={m.id.startsWith("pending-")}
                    onPress={() => void composer.remove(sessionId, m.id).catch((e) => setError(message(e)))}
                  />
                </QueuedRow>
              ))}
            </View>
          )}
          {inSheet && (
            <Choices
              title="When the session is running"
              value={preferred}
              options={sendBehaviors.map((b) => ({ value: b, label: sendBehaviorText[b].label }))}
              onChange={setPreferred}
            />
          )}
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-end",
              gap: space[2],
              paddingLeft: space[3],
              paddingRight: space[1.5],
              paddingVertical: space[1.5],
              borderWidth: 1,
              borderColor: focused ? colors.foregroundMuted : colors.border,
              borderRadius: 18,
              backgroundColor: canWrite ? colors.surface0 : colors.surface1,
            }}
          >
            <TextInput
              accessibilityLabel="Follow-up instruction"
              accessibilityHint={
                Platform.OS === "web"
                  ? "Enter sends; Shift and Enter inserts a new line."
                  : "Use the keyboard Send action or the send button."
              }
              value={draft}
              onChangeText={(text) => {
                draftBuffer.edit(text);
                onDraftChange(sessionId, text);
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onContentSizeChange={(event) => {
                const next = Math.max(
                  36,
                  Math.min(
                    compact && !inSheet ? 108 : 160,
                    // Web reports scrollHeight (padding included); native reports text height only.
                    Math.ceil(event.nativeEvent.contentSize.height + (Platform.OS === "web" ? 0 : 2 * space[2])),
                  ),
                );
                setInputHeight((current) => current === next ? current : next);
              }}
              multiline
              autoFocus={inSheet}
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
                  ? "Send a message to restore this session…"
                  : compact
                    ? "Message this session…"
                    : "Tell this session what to do next…"
              }
              placeholderTextColor={colors.foregroundMuted}
              style={{
                flex: 1,
                height: inputHeight,
                minHeight: 36,
                maxHeight: compact && !inSheet ? 108 : 160,
                minWidth: 0,
                paddingVertical: space[2],
                fontSize: font.base,
                lineHeight: 20,
                color: colors.foreground,
                textAlignVertical: "top",
                outlineStyle: "none",
              } as never}
            />
            {stopMode ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Stop session"
                onPress={() => void config.apply({ stop: true }, "Session stopped")}
                hitSlop={6}
                style={(state) => {
                  const { pressed } = state;
                  return {
                    ...noFocusRing,
                    width: sendSize,
                    height: sendSize,
                    marginBottom: (36 - sendSize) / 2,
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
              accessibilityLabel={busy ? "Sending instruction" : "Send instruction"}
              accessibilityHint={running ? sendBehaviorText[preferred].detail : undefined}
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
                  marginBottom: (36 - sendSize) / 2,
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
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], zIndex: 2 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <ComposerChips
                config={config}
                menu={chipMenu}
                setMenu={setChipMenu}
                inline={inSheet}
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
      style={{ flex: 1, minHeight: 0, minWidth: 0 }}
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
        <IconButton icon="ArrowLeft" label="Back to task" onPress={onBack} />
        <View style={{ flex: 1, minWidth: 0, paddingHorizontal: space[1] }}>
          <Label medium size={font.base} lines={1}>
            {active?.title || "Session preview"}
          </Label>
          {state ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[1.5], minWidth: 0 }}>
              <PulseDot color={tone} size={7} active={state.active} />
              <View style={{ flexShrink: 1, minWidth: 0 }}>
                <Label muted size={font.sm} lines={1} selectable={false}>
                  <Label size={font.sm} medium color={state.active || state.label === "Error" || state.label === "Waiting for approval" ? tone : colors.foregroundMuted} selectable={false}>
                    {state.label}
                  </Label>
                  {reads.query.isPending
                    ? " · Loading read state…"
                    : reads.query.isError
                      ? " · Read state unavailable"
                      : !attention?.readKnown
                        ? " · Read state unknown"
                        : attention.unread
                          ? " · Unread"
                          : ""}
                  {active?.provider ? ` · ${active.provider}${active.model ? `/${active.model}` : ""}` : ""}
                </Label>
              </View>
            </View>
          ) : (
            <Label muted size={font.sm}>{task.title}</Label>
          )}
        </View>
        {attention?.unread && (
          <IconButton
            icon="MailCheck"
            label="Mark as read"
            disabled={
              !canWrite ||
              reads.query.isPending ||
              reads.query.isError ||
              !attention.token
            }
            onPress={() =>
              void perform(async () => {
                await reads.markRead({
                  taskId: task.id,
                  agentId: sessionId,
                  token: attention.token!,
                });
                toast.show("Marked as read", { variant: "success" });
                await current.refetch();
              })
            }
          />
        )}
        {active && (
          <IconButton
            icon="RefreshCw"
            label="Refresh output"
            onPress={() => {
              void current.refetch();
              void timeline.refetch();
            }}
          />
        )}
        {active && (
          <IconButton
            icon="Wrench"
            label={showTools ? "Hide Kanban tools" : "Kanban tools"}
            active={showTools}
            onPress={() => setShowTools(!showTools)}
          />
        )}
        {active && !active.archivedAt && (
          <IconButton
            icon="Archive"
            label="Archive session"
            disabled={!visible || busy}
            onPress={() =>
              active.status === "running" || active.status === "initializing"
                ? setConfirmArchive(true)
                : void archiveSession()
            }
          />
        )}
        {typeof navigation?.openAgent === "function" && (
          <IconButton
            icon="ArrowUpRight"
            label="Open in Paseo"
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
              <Label medium size={font.md}>Kanban tools</Label>
              <View style={{ flex: 1 }} />
              <Dot color={tools.data?.ready ? colors.statusSuccess : colors.statusWarning} size={7} />
              <Label muted size={font.sm}>{tools.data?.ready ? "Ready" : "Not ready"}</Label>
            </View>
            <Label muted size={font.sm}>
              Lets this agent read its task, report progress and move it to In progress, Blocked or In review. You confirm Done or Cancelled.
            </Label>
            <Label muted size={font.sm}>
              {access.data?.methods.length
                ? `Configuration provided: ${access.data.methods.join(" + ").toUpperCase()}`
                : "No Kanban configuration recorded."}
              {" · "}
              {access.data?.lastSuccessAt
                ? `Last call: ${access.data.lastAction} ${relativeTime(access.data.lastSuccessAt)}`
                : "No successful tool call yet."}
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
                    toast.show("Kanban instructions sent", { variant: "success" });
                    await access.refetch();
                    await current.refetch();
                  })
                }
              >
                Send Kanban work instructions
              </Button>
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
        scrollEventThrottle={16}
        onScroll={tail.onScroll}
        onScrollBeginDrag={tail.onScrollBeginDrag}
        onScrollEndDrag={tail.onScrollEndDrag}
        onContentSizeChange={tail.scrollToTail}
        onLayout={tail.scrollToTail}
        contentContainerStyle={{ ...verticalContent, padding: space[4], paddingBottom: space[5], gap: space[4] }}
      >
        {current.isPending && <Label muted>Loading session…</Label>}
        {current.error && <Notice>{message(current.error)}</Notice>}
        {!current.isPending && !current.error && !belongs && (
          <Notice tone="warning">
            Session is unavailable or belongs to a different workspace. Return
            to the task to choose another session.
          </Notice>
        )}
        {active && (
          <>
            {unavailable && (
              <Notice tone="warning">
                {unavailableReason ||
                  "Task or workspace is unavailable. Return to task details for more information."}
              </Notice>
            )}
            {!!active.lastError && <Notice>{active.lastError}</Notice>}
            {active.providerUnavailable && (
              <Notice tone="warning">
                This session's provider is unavailable. Open in Paseo to inspect
                its configuration.
              </Notice>
            )}
            {!!active.archivedAt && (
              <Notice tone="info">
                This session is archived. Sending a message restores it and continues the conversation.
              </Notice>
            )}
            {reads.query.error && <Notice>{message(reads.query.error)}</Notice>}
            {attention?.unread && !attention.token && (
              <Notice tone="info">
                This host did not provide a readable attention timestamp. Open
                in Paseo to acknowledge this session.
              </Notice>
            )}
            <View style={{ alignItems: "center" }}>
              <Label muted size={font.xs} selectable={false}>
                Recent output · open in Paseo for the full conversation
              </Label>
            </View>
            {timeline.error && (
              <Notice>
                {message(timeline.error)}
                {output.length ? " Showing the last known output." : ""}
              </Notice>
            )}
            {timeline.isPending ? (
              <Label muted>Loading output…</Label>
            ) : !output.length ? (
              timeline.error ? null : (
                <View style={{ alignItems: "center", paddingVertical: space[6] }}>
                  <Label muted>No output yet.</Label>
                </View>
              )
            ) : (
              output.map((entry) => <TranscriptEntry key={entry.key} entry={entry} taskId={task.id} agentId={sessionId} />)
            )}
            {state?.active && (
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
                    ? "Starting session…"
                    : "Agent is working…"}
                </Label>
              </View>
            )}
          </>
        )}
        {!active && !!error && <Notice>{error}</Notice>}
      </ScrollView>
      {!!chipMenu && !sheetComposer && (
        <Pressable
          accessibilityLabel="Close menu"
          onPress={() => setChipMenu(null)}
          style={{ ...noFocusRing, position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 }}
        />
      )}
      {active && (
        <View
          testID="session-composer"
          style={{
            flexShrink: 0,
            minWidth: 0,
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
                transform: [{ translateY: latest.progress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Jump to latest"
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
                <Label size={font.sm} medium selectable={false}>Latest</Label>
              </Pressable>
            </Animated.View>
          )}
          {sheetComposer ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Write a follow-up instruction"
                accessibilityState={{ disabled: !canWrite }}
                disabled={!canWrite}
                onPress={() => setComposerOpen(true)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space[2],
                  minHeight: 44,
                  paddingLeft: space[3] + 2,
                  paddingRight: space[1.5],
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 22,
                  backgroundColor: canWrite ? (pressed ? colors.surface1 : colors.surface0) : colors.surface1,
                })}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label size={font.base} lines={1} muted={!draft.trim()} selectable={false}>
                    {draft.trim()
                      ? draft.trim().replace(/\s+/g, " ")
                      : active.archivedAt
                        ? "Send a message to restore…"
                        : "Message this session…"}
                  </Label>
                </View>
                {(running || queued.length > 0) && (
                  <Label muted size={font.xs} selectable={false}>
                    {queued.length ? `${queued.length} queued · ` : ""}{sendBehaviorText[preferred].label}
                  </Label>
                )}
                <View
                  style={{
                    width: sendSize,
                    height: sendSize,
                    borderRadius: sendSize / 2,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: draft.trim() && canWrite ? colors.accent : tint(colors.foregroundMuted, 0.14),
                  }}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={colors.accentForeground} />
                  ) : (
                    <Icon name="Pencil" size={15} color={draft.trim() && canWrite ? colors.accentForeground : colors.foregroundMuted} />
                  )}
                </View>
              </Pressable>
            </>
          ) : (
            renderComposer(false)
          )}
          {!compact && Platform.OS === "web" && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], minHeight: 20 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Label muted size={font.xs} lines={1} selectable={false}>
                  {running
                    ? `Enter: ${sendBehaviorText[preferred].label} · ⌘/Ctrl+Enter: ${preferred === "queue" ? "Send now" : "Queue"} · Shift+Enter: new line`
                    : "Enter to send · Shift+Enter for a new line"}
                </Label>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`When running: ${sendBehaviorText[preferred].label}. Change`}
                onPress={() => setModePicker(true)}
                hitSlop={6}
                style={{ flexDirection: "row", alignItems: "center", gap: 2 }}
              >
                <Label muted size={font.xs} selectable={false}>
                  When running: <Label size={font.xs} medium selectable={false}>{sendBehaviorText[preferred].label}</Label>
                </Label>
                <Icon name="ChevronDown" size={12} color={colors.foregroundMuted} />
              </Pressable>
            </View>
          )}
        </View>
      )}
      <Modal
        open={modePicker && visible}
        title="When the session is running"
        onOpenChange={(open) => {
          if (!open) setModePicker(false);
        }}
      >
        <Modal.Content contentContainerStyle={{ padding: space[3], gap: space[1] }}>
          <Theme.Provider value={theme}>
            {sendBehaviors.map((b) => (
              <Row
                key={b}
                title={sendBehaviorText[b].label}
                detail={sendBehaviorText[b].detail}
                selected={preferred === b}
                onPress={() => {
                  setPreferred(b);
                  setModePicker(false);
                }}
              />
            ))}
            <View style={{ paddingHorizontal: space[3], paddingTop: space[1] }}>
              <Label muted size={font.xs}>
                Same options as Paseo's “Default send” setting. Plugins cannot read that setting, so choose it here.
              </Label>
            </View>
          </Theme.Provider>
        </Modal.Content>
      </Modal>
      <Modal
        open={confirmArchive && visible}
        title="Archive running session?"
        onOpenChange={(open) => {
          if (!open) setConfirmArchive(false);
        }}
      >
        <Modal.Content>
          <Theme.Provider value={theme}>
            <Label size={font.base}>
              Archiving interrupts the current turn. The conversation is kept; send it a message later to restore it.
            </Label>
            <Actions>
              <Button quiet onPress={() => setConfirmArchive(false)}>Cancel</Button>
              <Button danger icon="Archive" onPress={() => void archiveSession()}>Archive</Button>
            </Actions>
          </Theme.Provider>
        </Modal.Content>
      </Modal>
      {sheetComposer && active && (
        <Modal
          open={composerOpen && visible}
          title={active.title ? `Message · ${active.title}` : "Message session"}
          onOpenChange={(open) => {
            if (!open) setComposerOpen(false);
          }}
        >
          <Modal.Content scrollable={false} contentContainerStyle={{ padding: space[4], gap: space[3] }}>
            <Theme.Provider value={theme}>
              {!!error && (
                <Notice>{error}</Notice>
              )}
              {renderComposer(true)}
            </Theme.Provider>
          </Modal.Content>
        </Modal>
      )}
    </View>
  );
}

function TranscriptEntry({
  entry,
  taskId,
  agentId,
}: {
  entry: ReturnType<typeof recentSessionOutput>[number];
  taskId: string;
  agentId: string;
}) {
  const { colors } = useTheme();
  const { text, images } = useMemo(
    () => (entry.author === "You" || entry.author === "Agent" ? extractImages(entry.text) : { text: entry.text, images: [] }),
    [entry.author, entry.text],
  );
  const pictures = images.map((image) => (
    <SessionImage key={image.src} taskId={taskId} agentId={agentId} image={image} />
  ));
  if (entry.author === "You")
    return (
      <View style={{ alignItems: "flex-end", paddingLeft: space[6] + space[2], gap: space[1.5] }}>
        {!!text && (
          <View
            accessibilityLabel="You"
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
  if (entry.author === "Tool")
    return (
      <View
        accessibilityLabel="Tool"
        style={{ flexDirection: "row", alignItems: "center", gap: space[2], minWidth: 0, marginVertical: -space[2] }}
      >
        <Icon name="Wrench" size={12} color={colors.foregroundMuted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label muted mono size={font.sm} lines={1}>
            {entry.text}
          </Label>
        </View>
      </View>
    );
  if (entry.author === "Thinking")
    return (
      <View accessibilityLabel="Thinking" style={{ flexDirection: "row", gap: space[2], minWidth: 0 }}>
        <View style={{ paddingTop: 3 }}>
          <Icon name="Brain" size={12} color={colors.foregroundMuted} />
        </View>
        <View style={{ flex: 1, minWidth: 0, opacity: 0.75 }}>
          <Label muted italic size={font.md} lines={6}>
            {entry.text}
          </Label>
        </View>
      </View>
    );
  if (entry.author === "Agent")
    return (
      <View accessibilityLabel="Agent" style={{ minWidth: 0, gap: space[2] }}>
        {!!text && <SessionMarkdown text={text} />}
        {pictures}
      </View>
    );
  return (
    <View style={{ gap: 2, minWidth: 0 }}>
      <Label muted size={font.xs}>{entry.author}</Label>
      <Label muted size={font.md}>{entry.text}</Label>
    </View>
  );
}

/** A queued message row: enters with a short rise, supports a context menu. */
function QueuedRow({ menu, style, children }: { menu: object; style: object; children: ReactNode }) {
  const enter = useMotionValue(1, motionDuration.forward, 0);
  return (
    <Animated.View
      style={{
        opacity: enter,
        transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
      }}
    >
      <Pressable {...menu} accessibilityRole="none" style={{ ...noFocusRing, ...style }}>
        {children}
      </Pressable>
    </Animated.View>
  );
}
