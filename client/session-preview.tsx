import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
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
  message,
  tint,
  verticalScroll,
  verticalContent,
} from "./ui";
import { sessionTone } from "./status";
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
import { MotionReveal, PulseDot } from "./motion";
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
    [feedback, setFeedback] = useState(""),
    [showTools, setShowTools] = useState(false),
    [inputHeight, setInputHeight] = useState(36),
    [focused, setFocused] = useState(false),
    [composerOpen, setComposerOpen] = useState(false),
    [confirmArchive, setConfirmArchive] = useState(false),
    [sendMode, setSendMode] = useState<"steer" | "interrupt">("steer");
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
  const submitState = useRef({ canWrite, mode: sendMode });
  submitState.current = { canWrite, mode: sendMode };
  async function perform(action: () => Promise<unknown>) {
    if (!mounted.current || lock.current || !beginOperation(sessionId)) return;
    lock.current = true;
    setSending(true);
    setError("");
    setFeedback("");
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
  async function submitInstruction() {
    const { canWrite: writable, mode } = submitState.current;
    const instruction = draftBuffer.read();
    if (!mounted.current || !writable || !instruction.trim()) return;
    await perform(async () => {
      await sendCardInstruction(paseo, task, sessionId, contextRead, instruction, mode);
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
  const sendSize = touch ? 34 : 28;
  // Native phones type in the host bottom sheet: it tracks the real IME height
  // (candidate bars, keyboard switches) which plugin-side keyboard events cannot.
  const sheetComposer = Platform.OS !== "web";
  const renderComposer = (inSheet: boolean) => {
    if (!active) return null;
    return (
      <>
          {((!inSheet && !tail.following) || active.status === "running") && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
              {active.status === "running" && (
                <Choices
                  title="Running session action"
                  hideTitle
                  value={sendMode}
                  options={[
                    { value: "steer", label: "Steer", disabled: busy || !canWrite },
                    { value: "interrupt", label: compact ? "Interrupt" : "Interrupt and send", disabled: busy || !canWrite },
                  ]}
                  onChange={setSendMode}
                />
              )}
              <View style={{ flex: 1 }} />
              {!inSheet && !tail.following && (
                <Button quiet icon="ArrowDown" onPress={tail.jumpToLatest}>
                  Jump to latest
                </Button>
              )}
            </View>
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
                if (action === "submit") void submitInstruction();
              }}
              onSubmitEditing={(event) => {
                if (Platform.OS === "web") return;
                const action = composerEnterAction({ ...event.nativeEvent, key: "Enter" });
                if (action === "submit") void submitInstruction();
              }}
              scrollEnabled
              editable={canWrite}
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={busy ? "Sending instruction" : "Send instruction"}
              accessibilityHint={active.status === "running" ? (sendMode === "interrupt" ? "Interrupts the running turn, then sends" : "Steers the running turn") : undefined}
              accessibilityState={{ disabled: !canSend, busy }}
              disabled={!canSend}
              onPress={() => void submitInstruction()}
              hitSlop={6}
              style={(state) => {
                const { pressed, hovered } = state as typeof state & { hovered?: boolean };
                return {
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
                  name={active.status === "running" && sendMode === "interrupt" ? "CornerDownLeft" : "ArrowUp"}
                  size={touch ? 18 : 16}
                  color={canSend ? colors.accentForeground : colors.foregroundMuted}
                />
              )}
            </Pressable>
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
                setFeedback(
                  "Marked this session update as read in Ultra Kanban.",
                );
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
                        ? { activeTurnBehavior: sendMode }
                        : {},
                    );
                    setFeedback(
                      "Kanban work instructions sent. Your follow-up draft is retained.",
                    );
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
              output.map((entry) => <TranscriptEntry key={entry.key} entry={entry} />)
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
      {active && (
        <View
          testID="session-composer"
          style={{
            flexShrink: 0,
            minWidth: 0,
            paddingHorizontal: space[3],
            paddingTop: space[2],
            paddingBottom: space[3],
            gap: space[2],
          }}
        >
          {(!!error || !!feedback) && (
            <Notice tone={error ? "danger" : "success"}>{error || feedback}</Notice>
          )}
          {sheetComposer ? (
            <>
              {!tail.following && (
                <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                  <Button quiet icon="ArrowDown" onPress={tail.jumpToLatest}>
                    Jump to latest
                  </Button>
                </View>
              )}
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
                {active.status === "running" && (
                  <Label muted size={font.xs} selectable={false}>
                    {sendMode === "interrupt" ? "Interrupt" : "Steer"}
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
            <Label muted size={font.xs} selectable={false}>
              Enter to send · Shift+Enter for a new line
            </Label>
          )}
        </View>
      )}
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
              {(!!error || !!feedback) && (
                <Notice tone={error ? "danger" : "success"}>{error || feedback}</Notice>
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
}: {
  entry: ReturnType<typeof recentSessionOutput>[number];
}) {
  const { colors } = useTheme();
  if (entry.author === "You")
    return (
      <View style={{ alignItems: "flex-end", paddingLeft: space[6] + space[2] }}>
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
          <Label size={font.base}>{entry.text}</Label>
        </View>
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
      <View accessibilityLabel="Agent" style={{ minWidth: 0 }}>
        <SessionMarkdown text={entry.text} />
      </View>
    );
  return (
    <View style={{ gap: 2, minWidth: 0 }}>
      <Label muted size={font.xs}>{entry.author}</Label>
      <Label muted size={font.md}>{entry.text}</Label>
    </View>
  );
}
