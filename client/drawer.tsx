import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { Modal } from "./modal";
import {
  usePaseo,
  useRpc,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { Task, Project, BoardEvent } from "../shared/model";
import { type Status } from "../shared/model";
import { enabledStatuses, laneName } from "../shared/lanes";
import * as rpc from "../shared/rpc";
import {
  Badge,
  Button,
  Divider,
  IconButton,
  Label,
  Notice,
  Row,
  SectionHeader,
  Theme,
  font,
  radius,
  relativeTime,
  tint,
  space,
  touch,
  useTheme,
  message,
  verticalScroll,
  verticalContent, noFocusRing } from "./ui";
import { PriorityIcon, StatusIcon, priorityLabels } from "./status";
import { listAgents } from "./resources";
import { isLegacyScope } from "../shared/scope";
import { SessionCard } from "./session-card";
import { SessionCreate } from "./session-create";
import { SessionPreview } from "./session-preview";
import { useSessionReads } from "./session-reads";
import { sessionAttention } from "../shared/session-attention";
import type { SessionEntry } from "./session-link";
import { Enter, MotionReveal } from "./motion";
import { TaskMetadata } from "./task-metadata";
import { Disclosure } from "./disclosure";
import { WrapupModal } from "./wrapup";
import { useComposer } from "./composer";
import { eventPoint, menuHandlers, useMenuOpener, type MenuEntry } from "./context-menu";
import { openNativeSession } from "./session-state";
import { cardQuestions } from "../shared/progress";

export function TaskDrawer({
  task,
  project,
  events,
  compact,
  width = 440,
  hostId,
  navigation,
  onClose,
  onEdit,
  refresh,
  sessionEntry,
  onSessionEntryConsumed,
  active = true,
  sessionDefaults,
  startRequest,
  escapeRequest,
}: {
  task: Task;
  project: Project;
  events: BoardEvent[];
  compact: boolean;
  width?: number;
  hostId: string;
  navigation: PluginSurfaceProps["navigation"];
  onClose(): void;
  onEdit(): void;
  refresh(): void;
  sessionEntry?: SessionEntry;
  onSessionEntryConsumed?(requestId: string): void;
  active?: boolean;
  sessionDefaults?: { provider: string; model: string; mode: string } | null;
  /** Changes when the card's action menu asks to start a session. */
  startRequest?: string;
  /** Changes on each board Esc shortcut: leave the session preview, else close. */
  escapeRequest?: string;
}) {
  const toast = useToast();
  const theme = useTheme();
  const { colors } = theme;
  const paseo = usePaseo(),
    update = useRpc(rpc.updateTask),
    contextRead = useRpc(rpc.taskContext),
    configure = useRpc(rpc.configureSession);
  const { query: readState, receipts, markRead, markUnread } = useSessionReads();
  const [selected, setSelected] = useState(sessionEntry?.sessionId || ""),
    [highlighted, setHighlighted] = useState(""),
    [showNew, setShowNew] = useState(false),
    [showWrapup, setShowWrapup] = useState(false),
    [showArchived, setShowArchived] = useState(false),
    [statusMenuOpen, setStatusMenuOpen] = useState(false),
    [detailsOpen, setDetailsOpen] = useState(false),
    [sending, setSending] = useState(false),
    [error, setError] = useState(""),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [pendingSessions, setPendingSessions] = useState<Record<string, boolean>>(
      {},
    );
  const lock = useRef(false);
  // Restore unsent drafts saved on the daemon (once per session, local edits win).
  const composer = useComposer(active);
  const seeded = useRef(new Set<string>());
  useEffect(() => {
    const sessions = composer.state?.sessions;
    if (!sessions) return;
    const restore: Record<string, string> = {};
    for (const [agentId, entry] of Object.entries(sessions)) {
      if (seeded.current.has(agentId) || entry.taskId !== task.id) continue;
      seeded.current.add(agentId);
      if (entry.draft) restore[agentId] = entry.draft;
    }
    if (Object.keys(restore).length)
      setDrafts((current) => {
        const next = { ...current };
        for (const [id, text] of Object.entries(restore)) if (!next[id]) next[id] = text;
        return next;
      });
  }, [composer.state, task.id]);
  const detailActive = useRef(active && !selected);
  detailActive.current = active && !selected;
  useEffect(() => {
    if (!active || selected) setStatusMenuOpen(false);
  }, [active, selected]);
  const sessionLocks = useRef(new Set<string>());
  const consumedEntry = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!active || !sessionEntry) return;
    const key = JSON.stringify([
      task.id,
      sessionEntry.sessionId,
      sessionEntry.requestId,
    ]);
    if (consumedEntry.current === key) return;
    consumedEntry.current = key;
    setSelected(sessionEntry.sessionId);
    setShowNew(false);
    setError("");
    onSessionEntryConsumed?.(sessionEntry.requestId);
  }, [
    sessionEntry?.requestId,
    sessionEntry?.sessionId,
    task.id,
    onSessionEntryConsumed,
    active,
  ]);
  const consumedStart = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!active || !startRequest || consumedStart.current === startRequest) return;
    consumedStart.current = startRequest;
    setSelected("");
    setShowNew(true);
  }, [active, startRequest]);
  const consumedEscape = useRef(escapeRequest);
  useEffect(() => {
    if (!active || !escapeRequest || consumedEscape.current === escapeRequest) return;
    consumedEscape.current = escapeRequest;
    if (selected) setSelected("");
    else onClose();
  }, [active, escapeRequest]);
  const workspace = useQuery({
    queryKey: ["ultra", "workspace", task.workspaceId],
    queryFn: () => paseo.workspaces.ref(task.workspaceId).refresh(),
    enabled: active,
    refetchInterval: 3000,
  });
  const scope = useQuery({
    queryKey: ["ultra", "context", task.id, task.revision, project.revision],
    queryFn: () => contextRead({ id: task.id }),
    enabled: active,
    refetchInterval: 5000,
    // A revision bump (e.g. an automatic status move) must not blank the
    // context and briefly mark the workspace unavailable.
    placeholderData: (previous) => previous,
  });
  const sessions = useQuery({
    queryKey: ["ultra", "sessions", task.workspaceId],
    queryFn: () => listAgents(paseo, task.workspaceId),
    enabled: active,
    refetchInterval: 3000,
  });
  const unavailable =
    !workspace.data ||
    workspace.isError ||
    scope.isError ||
    !scope.data?.available;
  const legacy = isLegacyScope(task, project);
  const resourceIssue = workspace.error
    ? message(workspace.error)
    : scope.error
      ? message(scope.error)
      : scope.data?.reason || (!workspace.isPending && !workspace.data ? "Workspace unavailable." : "");
  const statusDisabled = !active || sending || !!task.archivedAt || !!project.archivedAt;
  const refreshAll = () => {
    refresh();
    void sessions.refetch();
  };
  const questions = cardQuestions(task, events);
  const ordered = [...(sessions.data || [])].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
  const liveSessions = ordered.filter((a) => !a.archivedAt);
  const archivedSessions = ordered.filter((a) => !!a.archivedAt);
  const openMenu = useMenuOpener();
  const finished = task.status === "done" || task.status === "cancelled";
  const taskActions = (): MenuEntry[] => [
    {
      id: "start",
      label: "Start session",
      icon: "Play",
      disabled: unavailable || !!task.archivedAt,
      onPress: () => setShowNew(true),
    },
    ...(finished && !task.archivedAt && !project.archivedAt
      ? [{ id: "wrap", label: "Wrap up…", icon: "PackageCheck", onPress: () => setShowWrapup(true) }]
      : []),
    { kind: "separator" as const, id: "s" },
    {
      id: "archive",
      label: task.archivedAt ? "Restore card" : "Archive card",
      icon: task.archivedAt ? "ArchiveRestore" : "Archive",
      danger: !task.archivedAt,
      disabled: sending,
      onPress: () =>
        void perform(
          () => update({ id: task.id, revision: task.revision, archived: !task.archivedAt }),
          task.archivedAt ? "Card restored" : "Card archived",
        ),
    },
  ];
  const sessionMenu = (a: (typeof ordered)[number]): MenuEntry[] => {
    const running = a.status === "running" || a.status === "initializing";
    return [
      { id: "open", label: a.archivedAt ? "Open to restore" : "Open", icon: "MessageSquare", onPress: () => setSelected(a.id) },
      ...(typeof navigation?.openAgent === "function"
        ? [{ id: "native", label: "Open in Paseo", icon: "ArrowUpRight", onPress: () => openNativeSession(navigation, a.id, hostId) }]
        : []),
      ...(!a.archivedAt && active
        ? (() => {
            const attention = sessionAttention(a, task.id, receipts, events);
            const unavailable = readState.isPending || readState.isError;
            return [
              attention.unread
                ? {
                    id: "read",
                    label: "Mark as read",
                    icon: "MailCheck",
                    disabled: unavailable,
                    onPress: () =>
                      void perform(
                        () => markRead({ taskId: task.id, agentId: a.id, ...(attention.token ? { token: attention.token } : {}) }),
                        "Marked as read",
                      ),
                  }
                : {
                    id: "unread",
                    label: "Mark as unread",
                    icon: "Mail",
                    disabled: unavailable,
                    onPress: () => void perform(() => markUnread({ taskId: task.id, agentId: a.id }), "Marked as unread"),
                  },
            ];
          })()
        : []),
      ...(running
        ? [{
            id: "stop",
            label: "Stop",
            icon: "Square",
            onPress: () =>
              void perform(() => configure({ taskId: task.id, agentId: a.id, stop: true }), "Session stopped"),
          }]
        : []),
      ...(!a.archivedAt
        ? [
            { kind: "separator" as const, id: "s1" },
            {
              id: "archive",
              label: running ? "Archive (stop it first)" : "Archive session",
              icon: "Archive",
              danger: true,
              disabled: running || !active,
              onPress: () =>
                void perform(async () => {
                  await paseo.agents.ref(a.id).archive();
                }, "Session archived"),
            },
          ]
        : []),
    ];
  };
  const renderSession = (a: (typeof ordered)[number], index: number) => (
    <SessionCard
      key={a.id}
      agent={a}
      events={events}
      first={index === 0}
      highlighted={highlighted === a.id}
      attention={sessionAttention(a, task.id, receipts, events)}
      readStateUnavailable={readState.isPending || readState.isError}
      onPress={() => {
        setSelected(a.id);
        setError("");
      }}
      menu={menuHandlers(openMenu, a.title || "Session", () => sessionMenu(a))}
    />
  );
  // Routine turn start/end records drive rules and markers; the timeline shows
  // what changed or needs a person (failed turns, permission requests stay).
  const meaningful = events.filter(
    (e) =>
      e.action !== "agent.turn_started" &&
      !(e.action === "agent.turn_ended" && e.outcome !== "failed"),
  );
  async function perform(action: () => Promise<unknown>, success = "") {
    if (!detailActive.current || lock.current) return;
    lock.current = true;
    setSending(true);
    setError("");
    try {
      await action();
      if (success) toast.show(success, { variant: "success" });
      refreshAll();
    } catch (e) {
      setError(message(e));
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  function changeStatus(status: Status) {
    if (statusDisabled || !detailActive.current || status === task.status) return;
    void perform(
      () => update({ id: task.id, revision: task.revision, status }),
      `Moved to ${laneName(project, status)}`,
    );
  }
  return (
    <View
      style={{
        width: compact ? "100%" : width,
        flex: compact ? 1 : undefined,
        minHeight: 0,
        flexShrink: 0,
        maxWidth: "100%",
        backgroundColor: colors.surface0,
      }}
    >
      <MotionReveal
        testID="task-session-motion"
        transitionKey={`${task.id}|${selected || "details"}`}
        direction={selected ? 1 : -1}
        style={{ flex: 1, minHeight: 0, minWidth: 0 }}
      >
      {selected ? (
        <SessionPreview
          key={selected}
          task={task}
          sessionId={selected}
          compact={compact}
          visible={active}
          hostId={hostId}
          events={events}
          unavailable={!active || unavailable}
          unavailableReason={
            workspace.error
              ? message(workspace.error)
              : scope.error
                ? message(scope.error)
                : scope.data?.reason ||
                  "Checking task and workspace availability…"
          }
          navigation={navigation}
          draft={drafts[selected] || ""}
          pending={!!pendingSessions[selected]}
          beginOperation={(id) => {
            if (sessionLocks.current.has(id)) return false;
            sessionLocks.current.add(id);
            setPendingSessions((current) => ({ ...current, [id]: true }));
            return true;
          }}
          endOperation={(id) => {
            sessionLocks.current.delete(id);
            setPendingSessions((current) => ({ ...current, [id]: false }));
          }}
          onDraftChange={(id, text, expected) => {
            setDrafts((current) =>
              expected !== undefined && current[id] !== expected
                ? current
                : { ...current, [id]: text },
            );
            // Persist on the daemon (debounced; immediate when a send clears it).
            composer.saveDraft(task.id, id, text, expected !== undefined);
          }}
          onBack={() => setSelected("")}
          onClose={onClose}
          refresh={refreshAll}
        />
      ) : (
        <>
          <View style={{ paddingHorizontal: space[4], paddingTop: space[2], paddingBottom: space[3], gap: space[2] }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[1], marginLeft: compact ? -space[2] : 0 }}>
              {compact && (
                <IconButton icon="ArrowLeft" label="Back to board" onPress={onClose} />
              )}
              <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space[1.5] }}>
                <Icon name="Folder" size={13} color={colors.foregroundMuted} />
                <View style={{ flexShrink: 1, minWidth: 0 }}>
                  <Label muted size={font.sm} lines={1} selectable={false}>
                    {project.title}
                  </Label>
                </View>
                {!!task.archivedAt && <Badge>Archived</Badge>}
                {legacy && <Badge>Legacy</Badge>}
              </View>
              <IconButton icon="Pencil" label="Edit task" disabled={!active || sending} onPress={onEdit} />
              <IconButton
                icon="Ellipsis"
                label="More task actions"
                disabled={!active}
                onPress={(event) => openMenu?.(eventPoint(event), task.title, taskActions())}
              />
              {!compact && <IconButton icon="X" label="Close side bar" onPress={onClose} />}
            </View>
            <Label bold size={font.xl} lines={3}>{task.title}</Label>
            <View testID="task-actions" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space[2] }}>
              <Property
                icon={<StatusIcon status={task.status} />}
                text={laneName(project, task.status)}
                label={`Status: ${laneName(project, task.status)}`}
                disabled={statusDisabled}
                onPress={() => setStatusMenuOpen(true)}
              />
              <Property
                icon={<PriorityIcon priority={task.priority} always />}
                text={priorityLabels[task.priority]}
                label={`Priority: ${priorityLabels[task.priority]}. Edit task to change`}
                disabled={!active || sending}
                onPress={onEdit}
              />
            </View>
            {!!error && <Notice>{error}</Notice>}
          </View>
          <Divider />
          <ScrollView
            {...verticalScroll}
            style={{ flex: 1, minHeight: 0 }}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ ...verticalContent, padding: space[4], paddingBottom: space[6] + space[2], gap: space[5] }}
          >
            {!!resourceIssue && (
              <View style={{ gap: space[2] }}>
                <Notice tone="warning">{resourceIssue}</Notice>
                <View style={{ flexDirection: "row" }}>
                  <Button quiet icon="RefreshCw" disabled={!active} onPress={() => {
                    refreshAll();
                    void workspace.refetch();
                    void scope.refetch();
                  }}>Refresh details</Button>
                </View>
              </View>
            )}
            {questions.map((q) => (
              <Enter key={q.id}>
              <View
                accessibilityLabel={`Question from ${sessions.data?.find((a) => a.id === q.agentId)?.title || "agent"}: ${q.note || ""}`}
                style={{
                  gap: space[2],
                  padding: space[3],
                  borderRadius: radius.lg,
                  borderWidth: 1,
                  borderColor: tint(colors.statusWarning, 0.4),
                  backgroundColor: tint(colors.statusWarning, 0.07),
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                  <Icon name="MessageCircleQuestion" size={15} color={colors.statusWarning} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Label medium size={font.sm} lines={1} selectable={false}>
                      {sessions.data?.find((a) => a.id === q.agentId)?.title || "Agent"} needs you
                    </Label>
                  </View>
                  <Label muted size={font.xs} selectable={false}>{relativeTime(q.at)}</Label>
                </View>
                <Label size={font.base} selectable>{q.note || "The agent asked a question."}</Label>
                <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                  <Button
                    primary
                    icon="Reply"
                    disabled={!active || !q.agentId}
                    onPress={() => {
                      if (q.agentId) setSelected(q.agentId);
                      setError("");
                    }}
                  >
                    Reply
                  </Button>
                </View>
              </View>
              </Enter>
            ))}
            {(task.status === "done" || task.status === "cancelled") && !task.archivedAt && !project.archivedAt && (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space[3],
                  padding: space[3],
                  borderRadius: radius.lg,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface1,
                }}
              >
                <Icon name="PackageCheck" size={16} color={colors.foregroundMuted} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label medium size={font.md}>{task.status === "done" ? "Finished" : "Cancelled"}</Label>
                  <Label muted size={font.sm}>Wrap up to archive its sessions, worktree and the card.</Label>
                </View>
                <Button icon="Archive" disabled={!active || sending} onPress={() => setShowWrapup(true)}>
                  Wrap up
                </Button>
              </View>
            )}
            {!!task.description && (
              <Label size={font.base} selectable>{task.description}</Label>
            )}
            <View style={{ gap: space[2] }}>
              <SectionHeader title="Sessions" count={liveSessions.length}>
                <Button
                  quiet
                  icon="Plus"
                  disabled={!active || unavailable}
                  onPress={() => setShowNew(true)}
                >
                  Start session
                </Button>
              </SectionHeader>
              {sessions.error && (
                <View style={{ gap: space[2] }}>
                  <Notice>
                    {message(sessions.error)}
                    {sessions.data?.length
                      ? " Showing the last known session state."
                      : ""}
                  </Notice>
                  <View style={{ flexDirection: "row" }}>
                    <Button quiet icon="RefreshCw" onPress={() => void sessions.refetch()}>
                      Retry sessions
                    </Button>
                  </View>
                </View>
              )}
              {readState.error && (
                <Notice tone="warning">
                  Read state unavailable: {message(readState.error)}
                </Notice>
              )}
              {sessions.isPending ? (
                <Label muted>Loading sessions…</Label>
              ) : !liveSessions.length && !sessions.error ? (
                <View
                  style={{
                    paddingVertical: space[5],
                    paddingHorizontal: space[4],
                    alignItems: "center",
                    gap: space[1],
                    borderRadius: radius.lg,
                    borderWidth: 1,
                    borderStyle: "dashed",
                    borderColor: colors.border,
                  }}
                >
                  <Label muted size={font.md}>No sessions yet</Label>
                  <Label muted size={font.sm}>Start one to put an agent on this task.</Label>
                  <View style={{ paddingTop: space[2] }}>
                    <Button primary icon="Play" disabled={!active || unavailable} onPress={() => setShowNew(true)}>
                      Start session
                    </Button>
                  </View>
                </View>
              ) : (
                <SessionGroup list={liveSessions} render={renderSession} />
              )}
              {archivedSessions.length > 0 && (
                <Disclosure
                  title={`Archived · ${archivedSessions.length}`}
                  open={showArchived}
                  onChange={setShowArchived}
                >
                  <Label muted size={font.sm}>
                    Open one and send a message to restore it.
                  </Label>
                  <SessionGroup list={archivedSessions} render={renderSession} />
                </Disclosure>
              )}
            </View>
            <TaskMetadata
              task={task}
              project={project}
              open={detailsOpen}
              onChange={setDetailsOpen}
              disabled={!active}
              summary={workspace.isPending || scope.isPending ? "Checking…" : unavailable ? "Unavailable" : legacy ? "Legacy" : workspace.data?.name}
              legacy={legacy}
              workspaceName={workspace.data?.name}
              workspaceDirectory={workspace.data?.workspaceDirectory}
              workspaceStatus={workspace.isPending ? "Checking…" : workspace.data?.status || "Unavailable"}
              owner={scope.data?.owner}
              directories={scope.data?.directories || []}
            />
            {meaningful.length > 0 && (
              <View style={{ gap: space[2] }}>
                <SectionHeader title="Activity" />
                <View>
                  {meaningful
                    .slice(-12)
                    .reverse()
                    .map((e, index, list) => (
                      <ActivityItem
                        key={e.id}
                        event={e}
                        nameOf={(status) => laneName(project, status)}
                        last={index === list.length - 1}
                        actor={
                          e.agentId
                            ? sessions.data?.find((a) => a.id === e.agentId)?.title || "Agent"
                            : e.actor === "human"
                              ? "You"
                              : e.actor === "system"
                                ? "Kanban"
                                : "Agent"
                        }
                      />
                    ))}
                </View>
              </View>
            )}
          </ScrollView>
        </>
      )}
      </MotionReveal>
      <Modal
        open={statusMenuOpen && active && !selected}
        title="Status"
        onOpenChange={(open) => {
          if (!open) setStatusMenuOpen(false);
        }}
      >
        <Modal.Content contentContainerStyle={{ padding: space[3], gap: space[1] }}>
          <Theme.Provider value={theme}>
            {enabledStatuses(project).map((status) => (
              <Row
                key={status}
                title={laneName(project, status)}
                leading={<StatusIcon status={status} size={16} />}
                selected={status === task.status}
                disabled={statusDisabled}
                onPress={() => {
                  setStatusMenuOpen(false);
                  changeStatus(status);
                }}
              />
            ))}
          </Theme.Provider>
        </Modal.Content>
      </Modal>
      <SessionCreate
        task={task}
        open={active && showNew}
        workspaceDirectory={workspace.data?.workspaceDirectory}
        unavailable={!active || unavailable}
        onClose={() => setShowNew(false)}
        onCreated={(id, text) => {
          setHighlighted(id);
          toast.show(text, { variant: "success" });
          setSelected("");
        }}
        refresh={refreshAll}
        defaults={sessionDefaults}
      />
      <WrapupModal
        task={task}
        open={active && showWrapup}
        onClose={() => setShowWrapup(false)}
        onDone={(summary) => {
          setShowWrapup(false);
          toast.show(summary, { variant: "success" });
          refreshAll();
        }}
      />
    </View>
  );
}

function Property({
  icon,
  text,
  label,
  disabled,
  onPress,
}: {
  icon: ReactNode;
  text: string;
  label: string;
  disabled?: boolean;
  onPress(): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover || focused;
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: touch ? 40 : 28,
          paddingHorizontal: space[2] + 2,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: hovered || pressed ? colors.surface2 : colors.surface0,
          opacity: disabled ? 0.5 : 1,
        };
      }}
    >
      {icon}
      <Label medium size={font.md} selectable={false}>
        {text}
      </Label>
    </Pressable>
  );
}

const activityText: Record<string, string> = {
  created: "Created the task",
  edited: "Edited the task",
  status_changed: "Changed status",
  archive_changed: "Changed archive state",
  progress_reported: "Reported progress",
  "agent.turn_started": "Started a turn",
  "agent.turn_ended": "Finished a turn",
};

function ActivityItem({
  event,
  actor,
  last,
  nameOf,
}: {
  event: BoardEvent;
  nameOf(status: Status): string;
  actor: string;
  last: boolean;
}) {
  const { colors } = useTheme();
  const question = event.reportKind === "question";
  const verb = question
    ? "Asked"
    : event.action === "agent.turn_ended" && event.outcome === "failed"
      ? "Turn failed"
      : activityText[event.action] ||
        event.action.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());
  return (
    <View style={{ flexDirection: "row", gap: space[3] }}>
      <View style={{ width: 14, alignItems: "center" }}>
        <View style={{ height: 6 }} />
        {event.to ? (
          <StatusIcon status={event.to} size={13} />
        ) : (
          <View style={{ width: 7, height: 7, borderRadius: 4, marginVertical: 3, backgroundColor: colors.border }} />
        )}
        {!last && <View style={{ flex: 1, width: 1, marginTop: 4, backgroundColor: colors.border }} />}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : space[3], gap: 2 }}>
        <Label size={font.md}>
          <Label medium size={font.md}>{actor}</Label>
          {` ${verb.charAt(0).toLowerCase()}${verb.slice(1)}`}
          {event.to ? ` → ${nameOf(event.to)}` : ""}
          {event.reportKind && !question && event.reportKind !== "progress" ? ` · ${event.reportKind}` : ""}
        </Label>
        {!!event.rule && (
          <View style={{ flexDirection: "row" }}>
            <Badge>Auto</Badge>
          </View>
        )}
        {!!event.note && (
          <Label muted={!question} size={font.sm} lines={question ? 8 : 4}>
            {event.note}
          </Label>
        )}
        <Label muted size={font.xs}>
          {relativeTime(event.at)}
        </Label>
      </View>
    </View>
  );
}

function SessionGroup<T>({ list, render }: { list: T[]; render(item: T, index: number): ReactNode }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        overflow: "hidden",
      }}
    >
      {list.map(render)}
    </View>
  );
}
