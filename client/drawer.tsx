import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { Pressable, View } from "react-native";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import {
  usePaseo,
  useRpc,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import type { Task, Project, BoardEvent, Idea } from "../shared/model";
import { historyStatusLabel, legacyStatus, priorities, taskTypeLabels, taskTypes, type Status } from "../shared/model";
import { enabledStatuses, laneName } from "../shared/lanes";
import * as rpc from "../shared/rpc";
import {
  Badge,
  Button,
  Divider,
  IconButton,
  Label,
  Notice,
  SectionHeader,
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
import { PriorityIcon, StatusIcon, TypeIcon, priorityLabels } from "./status";
import { useLiveAgents } from "./queries";
import { shallowEqual } from "./stable";
import { isLegacyScope } from "../shared/scope";
import { SessionCard } from "./session-card";
import { SessionCreate } from "./session-create";
import { SessionPreview } from "./session-preview";
import { useSessionReads } from "./session-reads";
import { sessionAttention } from "../shared/session-attention";
import type { SessionEntry } from "./session-link";
import { Enter, MotionReveal, useSettled } from "./motion";
import { TaskMetadata } from "./task-metadata";
import { Disclosure } from "./disclosure";
import { WrapupModal } from "./wrapup";
import { currentWrapup } from "../shared/wrapup-state";
import { useComposer } from "./composer";
import { eventPoint, menuHandlers, useMenuOpener, type MenuEntry, type Point } from "./context-menu";
import { openNativeSession } from "./session-state";
import { cardQuestions } from "../shared/progress";
import { TaskProgress } from "./task-progress";
import { TaskUsage } from "./task-usage";
import { IdeaOrigin, TaskIdeas } from "./task-ideas";

type TaskDrawerProps = Parameters<typeof TaskDrawerView>[0];

export const TaskDrawer = memo(TaskDrawerView, (a, b) => sameDrawerProps(a, b));

function TaskDrawerView({
  task,
  project,
  events,
  compact,
  width = 440,
  hostId,
  navigation,
  onClose,
  onEdit,
  onDelete,
  onCreateFromIdea,
  onOpenTask,
  onStatusChanged,
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
  /** Opens the permanent-delete confirmation (archived cards only). */
  onDelete?(): void;
  /** Opens the new-task form prefilled from an idea (IDEAS-SPEC §6). */
  onCreateFromIdea?(idea: Idea): void;
  /** Opens another card's drawer (idea source or result). */
  onOpenTask?(id: string): void;
  /** After this drawer changed the card's status (the board may ask to wrap up). */
  onStatusChanged?(from: Status, to: Status): void;
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
    [detailsOpen, setDetailsOpen] = useState(false),
    // Activity is history, not status: collapsed until asked for (USAGE-STATS-SPEC §5).
    [activityOpen, setActivityOpen] = useState(false),
    [sending, setSending] = useState(false),
    [error, setError] = useState(""),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [pendingSessions, setPendingSessions] = useState<Record<string, boolean>>(
      {},
    );
  const lock = useRef(false);
  // Heavy sections and their reads start once the open transition is over.
  const settled = useSettled(task.id);
  const ready = active && settled;
  // Restore unsent drafts saved on the daemon (once per session, local edits win).
  const composer = useComposer(ready);
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
    enabled: ready,
    // Availability rarely changes; sends re-check it fresh anyway.
    refetchInterval: 10000,
  });
  const scope = useQuery({
    queryKey: ["ultra", "context", task.id, task.revision, project.revision],
    queryFn: () => contextRead({ id: task.id }),
    enabled: ready,
    refetchInterval: 10000,
    // A revision bump (e.g. an automatic status move) must not blank the
    // context and briefly mark the workspace unavailable.
    placeholderData: (previous) => previous,
  });
  // Live sessions come from the board's streamed agent list, so the cards show
  // at once; archived ones (a full host scan) are read slowly (PERFORMANCE-SPEC §3).
  const workspaceId = task.workspaceId;
  const liveAgents = useLiveAgents({
    poll: false,
    select: useCallback((agents: PaseoAgent[]) => agents.filter((a) => a.workspaceId === workspaceId), [workspaceId]),
  });
  // Archived ones come from the daemon (it pages every agent on the host).
  const archivedRead = useRpc(rpc.archivedSessions);
  const workspaceSessions = useQuery({
    queryKey: ["ultra", "sessions", "archived", task.id],
    queryFn: async () => (await archivedRead({ taskId: task.id })) as unknown as PaseoAgent[],
    enabled: ready,
    refetchInterval: 30000,
  });
  const liveHere = liveAgents.data;
  const sessionsData = useMemo(() => {
    if (!liveHere && !workspaceSessions.data) return undefined;
    const live = liveHere ?? (workspaceSessions.data || []).filter((a) => !a.archivedAt);
    const ids = new Set(live.map((a) => a.id));
    return [...live, ...(workspaceSessions.data || []).filter((a) => a.archivedAt && !ids.has(a.id))];
  }, [liveHere, workspaceSessions.data]);
  // A session that left the live list was probably archived: show it there now.
  const liveIds = (liveHere || []).map((a) => a.id).sort().join(",");
  const previousLive = useRef(liveIds);
  useEffect(() => {
    const before = previousLive.current.split(",").filter(Boolean);
    previousLive.current = liveIds;
    if (active && before.some((id) => !liveIds.split(",").includes(id))) void workspaceSessions.refetch();
  }, [liveIds]);
  const sessions = {
    data: sessionsData,
    error: liveAgents.error ?? workspaceSessions.error,
    isPending: sessionsData === undefined && (liveAgents.isPending || workspaceSessions.isPending),
    refetch: () => Promise.all([liveAgents.refetch(), workspaceSessions.refetch()]),
  };
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
  // Wrapped up while kept on the board: its workspace/sessions are archived on
  // purpose, so neither offer Wrap up again nor warn that they are unavailable.
  const wrapped = finished ? currentWrapup(events, task.id) : null;
  const taskActions = (): MenuEntry[] => [
    {
      id: "start",
      label: "Start session",
      icon: "Play",
      disabled: unavailable || !!task.archivedAt,
      onPress: () => setShowNew(true),
    },
    ...(finished && !wrapped && !task.archivedAt && !project.archivedAt
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
    ...(onDelete
      ? [{ id: "delete", label: "Delete permanently…", icon: "Trash2", danger: true, disabled: sending || !!project.archivedAt, onPress: onDelete }]
      : []),
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
    const from = task.status;
    void perform(
      async () => {
        await update({ id: task.id, revision: task.revision, status });
        onStatusChanged?.(from, status);
      },
      `Moved to ${laneName(project, status)}`,
    );
  }
  // Status, type and priority open a dropdown next to their button (a sheet on phones).
  const statusEntries = (): MenuEntry[] =>
    enabledStatuses(project).map((status) => ({
      id: status,
      label: laneName(project, status),
      leading: <StatusIcon status={status} />,
      checked: status === task.status,
      onPress: () => changeStatus(status),
    }));
  const editField = (edit: { type: Task["type"] | null } | { priority: Task["priority"] }, success: string) => {
    if (!active || sending || !detailActive.current) return;
    void perform(() => update({ id: task.id, revision: task.revision, ...edit }), success);
  };
  const typeEntries = (): MenuEntry[] => [
    {
      id: "none",
      label: "No type",
      leading: <TypeIcon always />,
      checked: !task.type,
      onPress: () => task.type && editField({ type: null }, "Type cleared"),
    },
    ...taskTypes.map((type) => ({
      id: type,
      label: taskTypeLabels[type],
      leading: <TypeIcon type={type} />,
      checked: type === task.type,
      onPress: () => type !== task.type && editField({ type }, `Type set to ${taskTypeLabels[type]}`),
    })),
  ];
  const priorityEntries = (): MenuEntry[] =>
    [...priorities].reverse().map((priority) => ({
      id: priority,
      label: priorityLabels[priority],
      leading: <PriorityIcon priority={priority} always />,
      checked: priority === task.priority,
      onPress: () => priority !== task.priority && editField({ priority }, `Priority set to ${priorityLabels[priority]}`),
    }));
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
          onComposerFocus={(id) => {
            // A late daemon restore must not replace (remount) an input the user is in.
            seeded.current.add(id);
          }}
          onDraftChange={(id, text, expected) => {
            seeded.current.add(id);
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
                disabled={statusDisabled || !openMenu}
                onPress={(at) => openMenu?.(at, "Status", statusEntries())}
              />
              <Property
                icon={<PriorityIcon priority={task.priority} always />}
                text={priorityLabels[task.priority]}
                label={`Priority: ${priorityLabels[task.priority]}`}
                disabled={!active || sending || !openMenu}
                onPress={(at) => openMenu?.(at, "Priority", priorityEntries())}
              />
              <Property
                icon={<TypeIcon type={task.type} always />}
                text={task.type ? taskTypeLabels[task.type] : "No type"}
                label={`Type: ${task.type ? taskTypeLabels[task.type] : "none"}`}
                disabled={!active || sending || !openMenu}
                onPress={(at) => openMenu?.(at, "Type", typeEntries())}
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
            {!!resourceIssue && !wrapped && (
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
                <Icon
                  name={wrapped ? "CircleCheck" : "PackageCheck"}
                  size={16}
                  color={wrapped ? colors.statusSuccess : colors.foregroundMuted}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Label medium size={font.md}>
                    {wrapped ? "Wrapped up" : task.status === "done" ? "Finished" : "Cancelled"}
                  </Label>
                  <Label muted size={font.sm}>
                    {wrapped
                      ? `${/(^|; )workspace kept(;|$)/.test(wrapped.note || "") ? "Sessions" : "Workspace and sessions"} archived ${relativeTime(wrapped.at)}. Move the card out of ${task.status === "done" ? "Done" : "Cancelled"} to bring them back.`
                      : "Wrap up to archive its sessions, worktree and the card."}
                  </Label>
                </View>
                {!wrapped && (
                  <Button icon="Archive" disabled={!active || sending} onPress={() => setShowWrapup(true)}>
                    Wrap up
                  </Button>
                )}
              </View>
            )}
            {onOpenTask && <IdeaOrigin task={task} onOpenTask={onOpenTask} />}
            {!!task.description && (
              <Label size={font.base} selectable>{task.description}</Label>
            )}
            <TaskProgress taskId={task.id} active={active} />
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
            {onCreateFromIdea && onOpenTask && (
              <TaskIdeas
                taskId={task.id}
                disabled={!active || !!task.archivedAt || !!project.archivedAt}
                onCreate={onCreateFromIdea}
                onOpenTask={onOpenTask}
              />
            )}
            {settled && (
            // Below the sessions, so mounting them after the transition moves nothing above.
            <Enter distance={4} style={{ gap: space[5] }}>
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
            <TaskUsage taskId={task.id} active={ready} />
            {meaningful.length > 0 && (
              <Disclosure
                title="Activity"
                summary={`${meaningful.length}`}
                open={activityOpen}
                onChange={setActivityOpen}
              >
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
              </Disclosure>
            )}
            </Enter>
            )}
          </ScrollView>
        </>
      )}
      </MotionReveal>
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

/**
 * Re-render only for its own data: the board passes stable callbacks and
 * re-renders often (live agents, polls); its session defaults are a fresh
 * object each time (PERFORMANCE-SPEC §3).
 */
function sameDrawerProps(a: TaskDrawerProps, b: TaskDrawerProps) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof TaskDrawerProps>;
  for (const key of keys)
    if (!Object.is(a[key], b[key]) && !(key === "sessionDefaults" && shallowEqual(a[key], b[key]))) return false;
  return true;
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
  /** Receives the point just below the button's left edge, where its dropdown opens. */
  onPress(at: Point): void;
}) {
  const { colors } = useTheme();
  const ref = useRef<View>(null);
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={(event) => {
        const fallback = eventPoint(event);
        const node = ref.current;
        if (!node) return onPress(fallback);
        node.measureInWindow((x, y, _width, height) =>
          onPress(Number.isFinite(x) && height ? { x, y: y + height + 4 } : fallback),
        );
      }}
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
  workspace_auto_archived: "Archived the workspace",
  workspace_auto_archive_skipped: "Kept the workspace",
  workspace_restored: "Restored the workspace",
  workspace_restore_skipped: "Workspace not restored",
  sessions_restored: "Restored the sessions",
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
          {event.to ? ` → ${event.to === legacyStatus ? historyStatusLabel(event.to) : nameOf(event.to)}` : ""}
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
