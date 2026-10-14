import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Animated, Platform, Pressable, View } from "react-native";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { Modal } from "./modal";
import {
  usePaseo,
  useRpc,
  type PluginSurfaceProps,
  type PluginWorkspacePanelProps,
  type PluginScreenParams,
} from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as rpc from "../shared/rpc";
import {
  statuses,
  statusLabels,
  priorities,
  type Status,
  type Task,
} from "../shared/model";
import {
  Theme,
  Label,
  CountPill,
  Button,
  Field,
  Choices,
  Notice,
  Row,
  Dot,
  Badge,
  Divider,
  Actions,
  IconButton,
  message,
  font,
  radius,
  space,
  touch,
  useTheme,
  verticalScroll,
  verticalContent,
} from "./ui";
import { StatusIcon, priorityLabels } from "./status";
import {
  attentionBadgeText,
  attentionFromSources,
  attentionOpenToken,
  lastSessionSettings,
  type AttentionItem,
} from "./attention";
import { relativeTime } from "./ui";
import { ProjectForm, TaskForm } from "./forms";
import { TaskDrawer } from "./drawer";
import { listAgents } from "./resources";
import { isLegacyScope } from "../shared/scope";
import { LiveTaskCard, type CardDrag } from "./card";
import { pickOutputSession } from "./card-output";
import { DesktopColumns, type Placement } from "./columns";
import { ResizeGrip } from "./resize";
import { drawerWidth, isCompactLayout } from "./geometry";
import { useSessionReads } from "./session-reads";
import { sessionAttentionSummary } from "../shared/session-attention";
import { MotionProvider, MotionReveal, useMotionPresence } from "./motion";
import {
  parseSessionLink,
  resolveSessionLink,
  sessionLinkKey,
  type SessionEntry,
} from "./session-link";
import {
  navigateGrid,
  parseBoardIntent,
  resolveShortcut,
  shortcutHelp,
  shortcutsBlocked,
  taskGrid,
  type BoardIntent,
} from "./shortcuts";

/** RN-Web forwards React keyboard events on View; React Native's types omit them. */
type WebKeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  nativeEvent?: { isComposing?: boolean };
  preventDefault(): void;
  stopPropagation(): void;
};

// Module scope: a remounted board must not reopen a modal for a token it already handled.
const appliedAttentionTokens = new Set<string>();
const consumedIntents = new Set<string>();

export function BoardScreen(
  props: PluginSurfaceProps & { workspaceId?: string; params?: PluginScreenParams },
) {
  return <MotionProvider><BoardContent {...props} /></MotionProvider>;
}

function BoardContent(
  props: PluginSurfaceProps & {
    workspaceId?: string;
    params?: PluginScreenParams;
  },
) {
  const toast = useToast();
  const read = useRpc(rpc.readBoard),
    resourcesRead = useRpc(rpc.listResources),
    updateProject = useRpc(rpc.updateProject),
    updateTask = useRpc(rpc.updateTask),
    reorder = useRpc(rpc.moveTask),
    placeTask = useRpc(rpc.placeTask),
    paseo = usePaseo();
  const queryClient = useQueryClient();
  const linkMount = useId();
  const input = useMemo(() => {
    try {
      return { link: parseSessionLink(props.params), error: "" };
    } catch (error) {
      return { link: null, error: message(error) };
    }
  }, [
    props.params?.taskId,
    props.params?.sessionId,
    props.params?.workspaceId,
    props.params?.requestId,
  ]);
  const linkKey = input.link
    ? JSON.stringify([props.host.id, sessionLinkKey(input.link)])
    : "";
  const resolvedLink = useQuery({
    queryKey: ["ultra", "cardLink", linkMount, linkKey],
    queryFn: () => resolveSessionLink(paseo, () => read({}), input.link!),
    enabled: !!input.link,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const appliedLink = useRef("");
  const [sessionEntry, setSessionEntry] = useState<
    (SessionEntry & { taskId: string }) | null
  >(null);
  const { query: readState, receipts } = useSessionReads();
  const data = useQuery({
    queryKey: ["ultra", "board"],
    queryFn: () => read({}),
    refetchInterval: 3000,
  });
  const resources = useQuery({
    queryKey: ["ultra", "resources"],
    queryFn: () => resourcesRead({}),
    refetchInterval: 5000,
  });
  const agents = useQuery({
    queryKey: ["ultra", "activity"],
    queryFn: () => listAgents(paseo),
    refetchInterval: 5000,
  });
  const [projectId, setProject] = useState(""),
    [taskId, setTask] = useState(""),
    [search, setSearch] = useState(""),
    [priority, setPriority] = useState("all"),
    [archived, setArchived] = useState(false),
    [hideFinished, setHideFinished] = useState(true),
    [menu, setMenu] = useState<"projects" | "filters" | "status" | "attention" | "shortcuts" | null>(null),
    [escapeRequest, setEscapeRequest] = useState<{ taskId: string; key: string } | null>(null),
    [startRequest, setStartRequest] = useState<{ taskId: string; key: string } | null>(null),
    [mobileStatus, setMobileStatus] = useState<Status>("todo"),
    [actionTask, setActionTask] = useState<Task | null>(null),
    [projectForm, setProjectForm] = useState<"new" | "edit" | null>(null),
    [taskForm, setTaskForm] = useState<{ task?: Task; status: Status } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [surfaceWidth, setSurfaceWidth] = useState(0),
    [preferredWidth, setPreferredWidth] = useState(440);
  const mutationLock = useRef(false);
  useEffect(() => {
    setSessionEntry(null);
    setMenu(null);
    setActionTask(null);
    if (input.error || resolvedLink.error) setTask("");
  }, [linkKey, input.error, resolvedLink.error]);
  const attentionToken = attentionOpenToken(props.params);

  useEffect(() => {
    if (!attentionToken || appliedAttentionTokens.has(attentionToken)) return;
    appliedAttentionTokens.add(attentionToken);
    setMenu("attention");
  }, [attentionToken]);
  useEffect(() => {
    const target = resolvedLink.data;
    if (
      !target ||
      !input.link ||
      sessionLinkKey(target.link) !== sessionLinkKey(input.link) ||
      appliedLink.current === linkKey
    )
      return;
    let cancelled = false;
    void (async () => {
      await queryClient.cancelQueries({
        queryKey: ["ultra", "board"],
        exact: true,
      });
      if (cancelled) return;
      appliedLink.current = linkKey;
      queryClient.setQueryData(["ultra", "board"], target.board);
      setProject(target.project.id);
      setTask(target.task.id);
      setSearch("");
      setPriority("all");
      setArchived(
        (current) =>
          current || !!target.project.archivedAt || !!target.task.archivedAt,
      );
      if (target.task.status === "done" || target.task.status === "cancelled")
        setHideFinished(false);
      setMobileStatus(target.task.status);
      setError("");
      setSessionEntry({
        taskId: target.task.id,
        sessionId: target.actor.id,
        requestId: target.link.requestId,
      });
    })().catch((error) => {
      if (!cancelled) {
        setTask("");
        setError(message(error));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [resolvedLink.data, linkKey, queryClient]);
  const { colors } = props.theme;
  const compact = isCompactLayout(
    props.layout.compact,
    props.layout.platform,
    surfaceWidth,
  );
  const width = drawerWidth(preferredWidth, surfaceWidth || 1000);
  const board = data.data;
  const linked = props.workspaceId
    ? board?.tasks.find((t) => t.workspaceId === props.workspaceId)
    : undefined;
  useEffect(() => {
    if (linked) {
      setProject(linked.projectId);
      setTask(linked.id);
    }
  }, [linked?.id]);
  useEffect(() => {
    if (
      hideFinished &&
      (mobileStatus === "done" || mobileStatus === "cancelled")
    )
      setMobileStatus("todo");
  }, [hideFinished, mobileStatus]);
  const projects = (board?.projects || []).filter(
    (p) => archived || !p.archivedAt,
  );
  const project = projects.find((p) => p.id === projectId) || projects[0];
  useEffect(() => {
    setActionTask(null);
  }, [project?.id]);
  const task = board?.tasks.find(
    (t) => t.id === taskId && t.projectId === project?.id,
  );
  const drawerTarget = useMemo(() => task && project ? {
    task, project, events: board?.events.filter((e) => e.taskId === task.id) || [],
  } : undefined, [task, project, board?.events]);
  const drawer = useMotionPresence(drawerTarget, drawerTarget ? `${project.id}|${task!.id}` : "");
  const tasks = (board?.tasks || []).filter(
    (t) => t.projectId === project?.id && (archived || !t.archivedAt),
  );
  const visible = tasks.filter(
    (t) =>
      `${t.title}\n${t.description}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (priority === "all" || t.priority === priority),
  );
  const shownStatuses = statuses.filter(
    (s) => !hideFinished || (s !== "done" && s !== "cancelled"),
  );
  const list = visible
    .filter((t) => t.status === mobileStatus)
    .sort(
      (a, b) =>
        a.position - b.position || a.createdAt.localeCompare(b.createdAt),
    );
  const readUnavailable = readState.isPending || readState.isError;
  const attention = useMemo(
    () =>
      attentionFromSources({ board, agents: agents.data, receipts, readUnavailable }) || [],
    [board, agents.data, receipts, readUnavailable],
  );
  const sessionDefaults = useMemo(
    () =>
      lastSessionSettings(
        agents.data || [],
        new Set((board?.tasks || []).map((t) => t.workspaceId)),
      ),
    [agents.data, board?.tasks],
  );
  const openAttention = (item: AttentionItem) => {
    setMenu(null);
    setProject(item.project.id);
    setTask(item.task.id);
    setMobileStatus(item.task.status);
    if (item.sessionId)
      setSessionEntry({
        taskId: item.task.id,
        sessionId: item.sessionId,
        requestId: `attention-${Date.now()}`,
      });
  };
  const filterCount =
    Number(!!search) +
    Number(priority !== "all") +
    Number(archived) +
    Number(!hideFinished);
  const refresh = () => {
    void data.refetch();
    void resources.refetch();
    void agents.refetch();
    void readState.refetch();
  };
  async function doAction(action: () => Promise<unknown>, success = "") {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setPending(true);
    setError("");
    try {
      await action();
      if (success) toast.show(success, { variant: "success" });
    } catch (e) {
      setError(message(e));
    } finally {
      mutationLock.current = false;
      setPending(false);
      refresh();
    }
  }
  const move = (input: { id: string; revision: number; status: Status }) => {
    void doAction(
      () => updateTask(input),
      `Moved to ${statusLabels[input.status]}`,
    );
  };
  const place = (input: Placement) => {
    const from = data.data?.tasks.find((t) => t.id === input.id)?.status;
    void doAction(
      () => placeTask(input),
      from === input.status ? "" : `Moved to ${statusLabels[input.status]}`,
    );
  };
  const renderCard = (t: Task, drag?: CardDrag, dragging = false) => {
    const workspace = resources.data?.workspaces.find(
      (w) => w.id === t.workspaceId,
    );
    const sessions = (agents.data || []).filter(
      (a) => a.workspaceId === t.workspaceId,
    );
    const summaryState =
      agents.isPending || readState.isPending
        ? "loading"
        : agents.isError || readState.isError
          ? agents.data && readState.data
            ? "stale"
            : "unavailable"
          : "ready";
    return (
      <LiveTaskCard
        key={t.id}
        task={t}
        selected={taskId === t.id}
        legacy={!!project && isLegacyScope(t, project)}
        available={!!workspace}
        running={sessions.filter((a) => a.status === "running").length}
        sessions={sessions.length}
        summary={sessionAttentionSummary(
          sessions,
          t,
          receipts,
          board?.events || [],
        )}
        summaryState={summaryState}
        outputSession={pickOutputSession(sessions, t.workspaceId)}
        drag={drag}
        dragging={dragging}
        disabled={pending || !!project?.archivedAt || !!t.archivedAt}
        onOpen={() => setTask(t.id)}
        onActions={() => setActionTask(t)}
      />
    );
  };
  const projectMenuClose = () => setMenu(null);
  const shortcutsOn = Platform.OS === "web" && !compact;
  const withKey = (text: string, key: string) =>
    shortcutsOn ? `${text} (${key})` : text;
  function runIntent(intent: BoardIntent | "escape" | "next" | "previous" | "left" | "right") {
    switch (intent) {
      case "new-task":
        if (!project || project.archivedAt) return false;
        setTaskForm({ status: compact ? mobileStatus : "todo" });
        return true;
      case "filters":
        if (!project) return false;
        setMenu("filters");
        return true;
      case "projects":
      case "attention":
      case "shortcuts":
        setMenu(intent);
        return true;
      case "escape":
        if (!task) return false;
        setEscapeRequest({ taskId: task.id, key: `escape-${Date.now()}` });
        return true;
      default: {
        if (compact) return false;
        const next = navigateGrid(taskGrid(shownStatuses, visible), task?.id || "", intent);
        if (!next) return false;
        if (next !== task?.id) setTask(next);
        return true;
      }
    }
  }
  const onKeyDown = (e: WebKeyEvent) => {
    const action = resolveShortcut(
      { ...e, isComposing: e.nativeEvent?.isComposing },
      shortcutsOn && !shortcutsBlocked(),
    );
    if (action && runIntent(action)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const keyboardProps = shortcutsOn ? { focusable: true, onKeyDown } : {};

  useEffect(() => {
    if (data.isPending) return;
    const parsed = parseBoardIntent(props.params);
    if (!parsed || consumedIntents.has(parsed.key)) return;
    consumedIntents.add(parsed.key);
    runIntent(parsed.intent);
  }, [props.params?.intent, props.params?.at, data.isPending]);
  return (
    <Theme.Provider value={props.theme}>
      <View
        {...(keyboardProps as {})}
        onLayout={(e) => setSurfaceWidth(e.nativeEvent.layout.width)}
        style={{ flex: 1, minHeight: 0, overflow: "hidden", backgroundColor: colors.surface0 }}
      >
        {!(compact && task) && (
          <View
            style={{
              paddingHorizontal: space[3],
              height: touch ? 56 : 48,
              gap: space[2],
              flexDirection: "row",
              alignItems: "center",
              borderBottomWidth: 1,
              borderColor: colors.border,
            }}
          >
            <ProjectSwitcher
              title={project?.title || "Projects"}
              archived={!!project?.archivedAt}
              shortcut={shortcutsOn ? "P" : ""}
              onPress={() => setMenu("projects")}
            />
            {!compact && !!project && (
              <Label muted size={font.sm} selectable={false}>
                {visible.length} {visible.length === 1 ? "task" : "tasks"}
              </Label>
            )}
            <View style={{ flex: 1 }} />
            {shortcutsOn && (
              <IconButton
                icon="Keyboard"
                label={withKey("Keyboard shortcuts", "?")}
                onPress={() => setMenu("shortcuts")}
              />
            )}
            <AttentionButton
              count={attention.length}
              compact={compact}
              shortcut={shortcutsOn ? "A" : ""}
              onPress={() => setMenu("attention")}
            />
            <FilterButton
              count={filterCount}
              compact={compact}
              shortcut={shortcutsOn ? "/" : ""}
              onPress={() => setMenu("filters")}
            />
            {project && (
              <Button
                primary
                icon="Plus"
                label={withKey("New task", "N")}
                disabled={!!project.archivedAt}
                onPress={() =>
                  setTaskForm({ status: compact ? mobileStatus : "todo" })
                }
              >
                {compact ? "" : "New task"}
              </Button>
            )}
          </View>
        )}
        {(data.error || error) && (
          <View style={{ paddingHorizontal: space[3], paddingTop: space[3], gap: space[2] }}>
            <Notice>{error || message(data.error)}</Notice>
            <View style={{ flexDirection: "row" }}>
              <Button
                quiet
                icon="RefreshCw"
                onPress={() => {
                  setError("");
                  refresh();
                }}
              >
                Retry
              </Button>
            </View>
          </View>
        )}
        {!!input.link && resolvedLink.isPending && (
          <View style={{ paddingHorizontal: space[4], paddingTop: space[3] }}>
            <Label muted>Opening linked session…</Label>
          </View>
        )}
        {!!(input.error || resolvedLink.error) && (
          <View style={{ paddingHorizontal: space[3], paddingTop: space[3], gap: space[2] }}>
            <Notice>{input.error || message(resolvedLink.error)}</Notice>
            {!input.error && (
              <View style={{ flexDirection: "row" }}>
                <Button quiet icon="RefreshCw" onPress={() => void resolvedLink.refetch()}>
                  Retry linked session
                </Button>
              </View>
            )}
          </View>
        )}
        {data.isPending ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Label muted>Loading board…</Label>
          </View>
        ) : !project ? (
          <View
            style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: space[6] }}
          >
            <View style={{ maxWidth: 360, gap: space[3], alignItems: "center" }}>
              <Icon name="PanelsTopLeft" size={28} color={colors.foregroundMuted} />
              <Label bold size={font.lg}>
                No projects yet
              </Label>
              <View style={{ paddingBottom: space[2] }}>
                <Label muted size={font.md}>
                  A project maps to one Paseo project root. Add tasks to it and
                  each task gets its own workspace and sessions.
                </Label>
              </View>
              <Button primary icon="Plus" onPress={() => setProjectForm("new")}>
                Create project
              </Button>
            </View>
          </View>
        ) : (
          <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
            {!(compact && task) && (
              <MotionReveal transitionKey={`${project.id}|${compact ? mobileStatus : "columns"}|${compact && !task ? "board" : ""}`} direction={-1} distance={compact ? 0 : 18} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                {compact ? (
                  <>
                    <View style={{ paddingHorizontal: space[2], paddingTop: space[2] }}>
                      <Row
                        title={statusLabels[mobileStatus]}
                        label="Choose task status"
                        leading={<StatusIcon status={mobileStatus} size={16} />}
                        trailing={
                          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                            <Label muted size={font.md} selectable={false}>{list.length}</Label>
                            <Icon name="ChevronsUpDown" size={14} color={colors.foregroundMuted} />
                          </View>
                        }
                        onPress={() => setMenu("status")}
                      />
                    </View>
                    <ScrollView
                      key={mobileStatus}
                      {...verticalScroll}
                      style={{ flex: 1, minHeight: 0 }}
                      nestedScrollEnabled
                      keyboardShouldPersistTaps="handled"
                      contentContainerStyle={{
                        ...verticalContent,
                        padding: space[3],
                        paddingTop: space[1],
                        paddingBottom: space[6] + space[2],
                        gap: space[2],
                      }}
                    >
                      {list.map((t) => renderCard(t))}
                      {!list.length && (
                        <View style={{ paddingVertical: space[6], gap: space[3], alignItems: "center" }}>
                          <Label muted selectable={false}>
                            {filterCount
                              ? "No tasks match these filters."
                              : `No ${statusLabels[mobileStatus].toLowerCase()} tasks.`}
                          </Label>
                          <Button
                            icon="Plus"
                            disabled={!!project.archivedAt}
                            onPress={() =>
                              setTaskForm({ status: mobileStatus })
                            }
                          >
                            Add task
                          </Button>
                        </View>
                      )}
                    </ScrollView>
                  </>
                ) : (
                  <DesktopColumns
                    statuses={shownStatuses}
                    tasks={visible}
                    disabled={pending || !!project.archivedAt}
                    cancelKey={`${project.id}|${search}|${priority}|${archived}|${hideFinished}|${taskId}|${menu}|${actionTask?.id}|${projectForm}|${!!taskForm}`}
                    renderCard={renderCard}
                    onAdd={(status) => setTaskForm({ status })}
                    onDrop={place}
                  />
                )}
              </MotionReveal>
            )}
            {drawer.item && (
              <Animated.View
                testID="task-drawer-motion"
                pointerEvents={drawer.active ? "auto" : "none"}
                accessibilityElementsHidden={!drawer.active}
                importantForAccessibility={drawer.active ? "auto" : "no-hide-descendants"}
                style={{
                  width: compact ? "100%" : width + 8,
                  flex: compact ? 1 : undefined,
                  minHeight: 0,
                  flexShrink: 0,
                  flexDirection: "row",
                  ...(compact && !task ? { position: "absolute", top: 0, bottom: 0, right: 0 } : {}),
                  opacity: drawer.progress,
                  transform: [{ translateX: drawer.progress.interpolate({ inputRange: [0, 1], outputRange: [32, 0] }) }],
                }}
              >
                {!compact && (
                  <ResizeGrip
                    width={width}
                    maxWidth={drawerWidth(720, surfaceWidth || 1000)}
                    onChange={(next) =>
                      setPreferredWidth(drawerWidth(next, surfaceWidth))
                    }
                  />
                )}
                <TaskDrawer
                  key={drawer.item.task.id}
                  active={drawer.active}
                  task={drawer.item.task}
                  project={drawer.item.project}
                  events={drawer.item.events}
                  compact={compact}
                  width={width}
                  navigation={props.navigation}
                  hostId={props.host.id}
                  onClose={() => setTask("")}
                  onEdit={() => task && setTaskForm({ task, status: task.status })}
                  refresh={refresh}
                  sessionDefaults={sessionDefaults}
                  escapeRequest={
                    escapeRequest?.taskId === drawer.item.task.id ? escapeRequest.key : undefined
                  }
                  startRequest={
                    startRequest?.taskId === drawer.item.task.id ? startRequest.key : undefined
                  }
                  sessionEntry={
                    sessionEntry?.taskId === drawer.item.task.id && drawer.active ? sessionEntry : undefined
                  }
                  onSessionEntryConsumed={(requestId) =>
                    setSessionEntry((current) =>
                      current?.requestId === requestId &&
                      current.taskId === drawer.item?.task.id &&
                      current.sessionId === sessionEntry?.sessionId
                        ? null
                        : current,
                    )
                  }
                />
              </Animated.View>
            )}
          </View>
        )}

        <Modal
          open={menu === "projects"}
          title="Projects"
          onOpenChange={(open) => {
            if (!open) projectMenuClose();
          }}
        >
          <Modal.Content contentContainerStyle={{ padding: space[3], gap: space[1] }}>
            <Theme.Provider value={props.theme}>
              {projects.map((p) => (
                <Row
                  key={p.id}
                  title={p.title}
                  detail={p.primaryPath}
                  icon={p.archivedAt ? "Archive" : "Folder"}
                  selected={project?.id === p.id}
                  trailing={p.archivedAt ? <Badge>Archived</Badge> : undefined}
                  onPress={() => {
                    setProject(p.id);
                    setTask("");
                    projectMenuClose();
                  }}
                />
              ))}
              <Divider style={{ marginVertical: space[2] }} />
              {project && (
                <>
                  <Row
                    title={`Edit ${project.title}`}
                    icon="Pencil"
                    onPress={() => {
                      projectMenuClose();
                      setProjectForm("edit");
                    }}
                  />
                  <Row
                    title={project.archivedAt ? `Restore ${project.title}` : `Archive ${project.title}`}
                    icon={project.archivedAt ? "ArchiveRestore" : "Archive"}
                    disabled={pending}
                    onPress={() => {
                      projectMenuClose();
                      void doAction(() =>
                        updateProject({
                          id: project.id,
                          revision: project.revision,
                          archived: !project.archivedAt,
                        }),
                      );
                    }}
                  />
                </>
              )}
              <Row
                title="New project"
                icon="Plus"
                onPress={() => {
                  projectMenuClose();
                  setProjectForm("new");
                }}
              />
            </Theme.Provider>
          </Modal.Content>
        </Modal>
        <Modal
          open={menu === "filters"}
          title="Filters"
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
        >
          <Modal.Content>
            <Theme.Provider value={props.theme}>
              <Field
                title="Search"
                value={search}
                onChange={setSearch}
                placeholder="Title or description"
              />
              <Choices
                title="Priority"
                value={priority}
                options={[
                  { value: "all", label: "All" },
                  ...priorities.map((p) => ({ value: p, label: priorityLabels[p] })),
                ]}
                onChange={setPriority}
              />
              <View style={{ gap: space[1] }}>
                <Toggle
                  title="Show archived"
                  detail="Archived projects and tasks"
                  value={archived}
                  onChange={setArchived}
                />
                <Toggle
                  title="Show finished"
                  detail="Done and Cancelled columns"
                  value={!hideFinished}
                  onChange={(show) => setHideFinished(!show)}
                />
              </View>
              <Actions>
                <Button
                  quiet
                  disabled={!filterCount}
                  onPress={() => {
                    setSearch("");
                    setPriority("all");
                    setArchived(false);
                    setHideFinished(true);
                  }}
                >
                  Reset filters
                </Button>
                <Button icon="RefreshCw" onPress={refresh}>
                  Refresh
                </Button>
                <Button primary onPress={() => setMenu(null)}>
                  Done
                </Button>
              </Actions>
            </Theme.Provider>
          </Modal.Content>
        </Modal>
        <Modal
          open={menu === "attention"}
          title="Needs attention"
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
        >
          <Modal.Content contentContainerStyle={{ padding: space[3], gap: space[1] }}>
            <Theme.Provider value={props.theme}>
              {readUnavailable && (
                <View style={{ paddingBottom: space[2] }}>
                  <Notice tone="warning">
                    Read state is unavailable, so finished-but-unread sessions are not listed. Approvals and errors still are.
                  </Notice>
                </View>
              )}
              {!attention.length ? (
                <View style={{ paddingVertical: space[6], alignItems: "center", gap: space[2] }}>
                  <Icon name="BellOff" size={20} color={colors.foregroundMuted} />
                  <Label muted>Nothing needs your attention.</Label>
                </View>
              ) : (
                attention.map((item) => (
                  <Row
                    key={item.task.id}
                    title={item.task.title}
                    detail={`${item.project.title} · ${statusLabels[item.task.status]} · ${[
                      item.permissions && `${item.permissions} approval`,
                      item.errors && `${item.errors} error`,
                      item.unread && `${item.unread} unread`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}`}
                    label={`Open ${item.task.title}`}
                    leading={
                      <Dot
                        size={8}
                        color={
                          item.permissions
                            ? colors.statusWarning
                            : item.errors
                              ? colors.statusDanger
                              : colors.statusSuccess
                        }
                      />
                    }
                    trailing={
                      <Label muted size={font.xs} selectable={false}>
                        {relativeTime(item.updatedAt)}
                      </Label>
                    }
                    onPress={() => openAttention(item)}
                  />
                ))
              )}
            </Theme.Provider>
          </Modal.Content>
        </Modal>
        <Modal
          open={menu === "shortcuts"}
          title="Keyboard shortcuts"
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
        >
          <Modal.Content contentContainerStyle={{ padding: space[4], gap: space[3] }}>
            <Theme.Provider value={props.theme}>
              <Label muted size={font.md}>
                Board shortcuts work on desktop while focus is inside the board: click an
                empty part of the board or a card first. They pause while typing or while a
                dialog is open. From anywhere in Paseo, open the Command Center and search
                “Ultra Kanban”.
              </Label>
              <View style={{ gap: space[1] }}>
                {shortcutHelp.map((item) => (
                  <View
                    key={item.title}
                    style={{ flexDirection: "row", alignItems: "center", gap: space[3], minHeight: 32 }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Label size={font.base} selectable={false}>{item.title}</Label>
                    </View>
                    <View style={{ flexDirection: "row", gap: space[1] }}>
                      {item.keys.map((key) => (
                        <KeyHint key={key}>{key}</KeyHint>
                      ))}
                    </View>
                  </View>
                ))}
              </View>
            </Theme.Provider>
          </Modal.Content>
        </Modal>
        <Modal
          open={menu === "status"}
          title="Status"
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
        >
          <Modal.Content contentContainerStyle={{ padding: space[3], gap: space[1] }}>
            <Theme.Provider value={props.theme}>
              {shownStatuses.map((s) => (
                <Row
                  key={s}
                  title={statusLabels[s]}
                  leading={<StatusIcon status={s} size={16} />}
                  selected={s === mobileStatus}
                  trailing={
                    <Label muted size={font.md} selectable={false}>
                      {visible.filter((t) => t.status === s).length}
                    </Label>
                  }
                  onPress={() => {
                    setMobileStatus(s);
                    setMenu(null);
                  }}
                />
              ))}
            </Theme.Provider>
          </Modal.Content>
        </Modal>
        <Modal
          open={!!actionTask}
          title={actionTask?.title || "Task actions"}
          onOpenChange={(open) => {
            if (!open) setActionTask(null);
          }}
        >
          <Modal.Content contentContainerStyle={{ padding: space[3], gap: space[1] }}>
            <Theme.Provider value={props.theme}>
              {actionTask && (
                <>
                  <Row
                    title="Open details"
                    icon="PanelRightOpen"
                    onPress={() => {
                      setTask(actionTask.id);
                      setActionTask(null);
                    }}
                  />
                  <Row
                    title="Start session"
                    icon="Play"
                    disabled={!!project?.archivedAt || !!actionTask.archivedAt}
                    onPress={() => {
                      setTask(actionTask.id);
                      setStartRequest({ taskId: actionTask.id, key: `start-${Date.now()}` });
                      setActionTask(null);
                    }}
                  />
                  {(["up", "down"] as const).map((direction) => (
                    <Row
                      key={direction}
                      title={direction === "up" ? "Move up" : "Move down"}
                      icon={direction === "up" ? "ArrowUp" : "ArrowDown"}
                      disabled={
                        pending ||
                        !!project?.archivedAt ||
                        !!actionTask.archivedAt
                      }
                      onPress={() => {
                        const t = actionTask;
                        setActionTask(null);
                        void doAction(() =>
                          reorder({
                            id: t.id,
                            revision: t.revision,
                            direction,
                          }),
                        );
                      }}
                    />
                  ))}
                  <Divider style={{ marginVertical: space[2] }} />
                  <View style={{ paddingHorizontal: space[3], paddingBottom: space[1] }}>
                    <Label medium muted size={font.sm} selectable={false}>
                      Move to
                    </Label>
                  </View>
                  {statuses.map((s) => (
                    <Row
                      key={s}
                      title={statusLabels[s]}
                      label={`Move to: ${statusLabels[s]}`}
                      leading={<StatusIcon status={s} size={16} />}
                      selected={s === actionTask.status}
                      disabled={
                        pending ||
                        !!project?.archivedAt ||
                        !!actionTask.archivedAt
                      }
                      onPress={() => {
                        if (s !== actionTask.status)
                          move({
                            id: actionTask.id,
                            revision: actionTask.revision,
                            status: s,
                          });
                        setActionTask(null);
                      }}
                    />
                  ))}
                </>
              )}
            </Theme.Provider>
          </Modal.Content>
        </Modal>
        {projectForm && (
          <ProjectForm
            key={projectForm}
            project={projectForm === "edit" ? project : undefined}
            onClose={() => setProjectForm(null)}
            onSaved={(id) => {
              setProject(id);
              setProjectForm(null);
              refresh();
            }}
          />
        )}
        {taskForm && project && (
          <TaskForm
            key={taskForm.task?.id || taskForm.status}
            project={project}
            task={taskForm.task}
            defaultStatus={taskForm.status}
            onClose={() => setTaskForm(null)}
            onSaved={(id) => {
              setTask(id);
              setTaskForm(null);
              refresh();
            }}
          />
        )}
      </View>
    </Theme.Provider>
  );
}

function ProjectSwitcher({
  title,
  archived,
  shortcut,
  onPress,
}: {
  title: string;
  archived: boolean;
  shortcut: string;
  onPress(): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Project: ${title}. Choose or manage project${shortcut ? ` (${shortcut})` : ""}`}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered } = state as typeof state & { hovered?: boolean };
        return {
          flexDirection: "row",
          alignItems: "center",
          gap: space[2],
          height: touch ? 44 : 32,
          paddingHorizontal: space[2],
          marginLeft: -space[1],
          borderRadius: radius.md,
          flexShrink: 1,
          minWidth: 0,
          backgroundColor: hovered || pressed ? colors.surface2 : "transparent",
        };
      }}
    >
      <Icon name={archived ? "Archive" : "Folder"} size={15} color={colors.foregroundMuted} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Label bold size={font.base} lines={1} selectable={false}>
          {title}
        </Label>
      </View>
      <Icon name="ChevronsUpDown" size={14} color={colors.foregroundMuted} />
    </Pressable>
  );
}

function AttentionButton({
  count,
  compact,
  shortcut,
  onPress,
}: {
  count: number;
  compact: boolean;
  shortcut: string;
  onPress(): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${count ? `Needs attention, ${count} cards` : "Needs attention"}${shortcut ? ` (${shortcut})` : ""}`}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered } = state as typeof state & { hovered?: boolean };
        return {
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: touch ? 44 : 32,
          minWidth: touch ? 44 : 32,
          justifyContent: "center",
          paddingHorizontal: compact ? 0 : space[2] + 2,
          borderRadius: radius.md,
          backgroundColor: hovered || pressed ? colors.surface2 : "transparent",
        };
      }}
    >
      <Icon name="Bell" size={15} color={count ? colors.foreground : colors.foregroundMuted} />
      {!compact && (
        <Label size={font.md} medium muted={!count} selectable={false}>
          Attention
        </Label>
      )}
      {!!count && <CountPill text={attentionBadgeText(count) || ""} />}
    </Pressable>
  );
}

function FilterButton({
  count,
  compact,
  shortcut,
  onPress,
}: {
  count: number;
  compact: boolean;
  shortcut: string;
  onPress(): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${count ? `Task filters, ${count} active` : "Task filters"}${shortcut ? ` (${shortcut})` : ""}`}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered } = state as typeof state & { hovered?: boolean };
        return {
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: touch ? 44 : 32,
          minWidth: touch ? 44 : 32,
          justifyContent: "center",
          paddingHorizontal: compact ? 0 : space[2] + 2,
          borderRadius: radius.md,
          backgroundColor: hovered || pressed ? colors.surface2 : "transparent",
        };
      }}
    >
      <Icon name="ListFilter" size={15} color={count ? colors.foreground : colors.foregroundMuted} />
      {!compact && (
        <Label size={font.md} medium muted={!count} selectable={false}>
          Filter
        </Label>
      )}
      {!!count && (
        <View
          style={{
            minWidth: 16,
            height: 16,
            paddingHorizontal: 4,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.accent,
          }}
        >
          <Label size={font.xs} bold color={colors.accentForeground} selectable={false}>
            {String(count)}
          </Label>
        </View>
      )}
    </Pressable>
  );
}

function KeyHint({ children }: { children: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        minWidth: 22,
        height: 22,
        paddingHorizontal: space[1.5],
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Label size={font.sm} medium selectable={false}>{children}</Label>
    </View>
  );
}

function Toggle({
  title,
  detail,
  value,
  onChange,
}: {
  title: string;
  detail?: string;
  value: boolean;
  onChange(value: boolean): void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space[3],
        minHeight: touch ? 52 : 44,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size={font.base} selectable={false}>{title}</Label>
        {!!detail && (
          <Label muted size={font.sm} selectable={false}>
            {detail}
          </Label>
        )}
      </View>
      <View
        style={{
          width: 34,
          height: 20,
          borderRadius: 10,
          padding: 2,
          justifyContent: "center",
          alignItems: value ? "flex-end" : "flex-start",
          backgroundColor: value ? colors.accent : colors.surface2,
          borderWidth: value ? 0 : 1,
          borderColor: colors.border,
        }}
      >
        <View
          style={{
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: value ? colors.accentForeground : colors.surface0,
          }}
        />
      </View>
    </Pressable>
  );
}

export function WorkspaceBoard(props: PluginWorkspacePanelProps) {
  return <BoardScreen {...props} workspaceId={props.workspaceId} />;
}
