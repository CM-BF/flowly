import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Animated, Platform, Pressable, View, type GestureResponderEvent } from "react-native";
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
  priorities,
  type Status,
  type Task,
  projectOrder,
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
  Toggle,
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
  verticalContent, noFocusRing } from "./ui";
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
import { cardQuestions } from "../shared/progress";
import { statusChanges } from "./changes";
import { ContextMenuProvider, eventPoint, menuHandlers, suppressNativeMenu, useMenuOpener, type MenuEntry } from "./context-menu";
import { DesktopColumns, type Placement } from "./columns";
import { ResizeGrip } from "./resize";
import { drawerWidth, isCompactLayout } from "./geometry";
import { useSessionReads } from "./session-reads";
import { sessionAttentionSummary } from "../shared/session-attention";
import { MotionProvider, MotionReveal, useMotionPresence } from "./motion";
import { SortableList } from "./sortable-list";
import { useBoardView } from "./board-view";
import { OverviewBar } from "./overview-bar";
import { boardOverview } from "./overview";
import { enabledStatuses, laneName } from "../shared/lanes";
import { boardSortText, boardSorts, sortTasks, type BoardSort } from "../shared/sort";
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
  adjacentStatus,
  type ShortcutAction,
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
  return (
    <MotionProvider>
      <Theme.Provider value={props.theme}>
        <ContextMenuProvider compact={props.layout.compact || props.layout.platform !== "web"}>
          <BoardContent {...props} />
        </ContextMenuProvider>
      </Theme.Provider>
    </MotionProvider>
  );
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
  const view = useBoardView();
  const [projectId, setProject] = useState(""),
    [taskId, setTask] = useState(""),
    [search, setSearchState] = useState(""),
    [priority, setPriorityState] = useState("all"),
    [archived, setArchivedState] = useState(false),
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
  // Filters are remembered (board-view settings): restored once, then written through.
  const filtersRestored = useRef(false);
  useEffect(() => {
    if (filtersRestored.current || !view.values) return;
    filtersRestored.current = true;
    setSearchState(view.values.filterSearch);
    setPriorityState(view.values.filterPriority);
    setArchivedState(view.values.showArchived);
  }, [!!view.values]);
  const searchSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (searchSave.current) clearTimeout(searchSave.current);
  }, []);
  const setSearch = (next: string) => {
    setSearchState(next);
    if (searchSave.current) clearTimeout(searchSave.current);
    searchSave.current = setTimeout(() => void view.update({ filterSearch: next.slice(0, 200) }), 500);
  };
  const setPriority = (next: string) => {
    setPriorityState(next);
    void view.update({ filterPriority: next as "all" });
  };
  const setArchived = (next: boolean | ((current: boolean) => boolean)) => {
    setArchivedState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      if (value !== current) void view.update({ showArchived: value });
      return value;
    });
  };
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
  // A dropped project shows in place until the refreshed board agrees.
  const [projectOrderOverride, setProjectOrderOverride] = useState<string[] | null>(null);
  const serverProjects = (board?.projects || [])
    .filter((p) => archived || !p.archivedAt)
    .sort(projectOrder);
  const serverProjectIds = serverProjects.map((p) => p.id).join(",");
  useEffect(() => {
    if (!projectOrderOverride) return;
    if (projectOrderOverride.join(",") === serverProjectIds) return setProjectOrderOverride(null);
    const timer = setTimeout(() => setProjectOrderOverride(null), 5000);
    return () => clearTimeout(timer);
  }, [projectOrderOverride, serverProjectIds]);
  const projects = projectOrderOverride
    ? serverProjects.slice().sort((a, b) => projectOrderOverride.indexOf(a.id) - projectOrderOverride.indexOf(b.id))
    : serverProjects;
  const remembered = view.values?.lastProjectId || "";
  const boardSort: BoardSort = view.values?.boardSort || "manual";
  const collapsedColumns = view.values?.collapsedColumns || [];
  const toggleCollapse = (status: Status) => {
    if (!view.values) return;
    const next = collapsedColumns.includes(status)
      ? collapsedColumns.filter((s) => s !== status)
      : [...collapsedColumns, status];
    void view.update({ collapsedColumns: next });
  };
  const chooseSort = (next: BoardSort) => {
    if (!view.values || next === boardSort) return;
    void view.update({ boardSort: next });
  };
  const project =
    projects.find((p) => p.id === projectId) ||
    projects.find((p) => p.id === remembered) ||
    projects[0];
  // Remember an explicit project choice for the next time the board opens.
  const chooseProject = (id: string) => {
    setProject(id);
    if (view.values && view.values.lastProjectId !== id) void view.update({ lastProjectId: id });
  };
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
  // The project's lanes are its workflow: enabled lanes in their configured order.
  const shownStatuses = enabledStatuses(project);
  const nameOf = (status: Status) => laneName(project, status);
  // Compact: open each project on its first lane that has cards (once per
  // project; a linked card or the user's own tab choice wins afterwards).
  const autoLane = useRef("");
  useEffect(() => {
    if (!board || !project || autoLane.current === project.id) return;
    autoLane.current = project.id;
    if (taskId) return;
    const first = shownStatuses.find((s) => visible.some((t) => t.status === s));
    if (first) setMobileStatus(first);
  }, [board, project?.id]);
  useEffect(() => {
    if (!shownStatuses.includes(mobileStatus)) setMobileStatus(shownStatuses.includes("todo") ? "todo" : shownStatuses[0]);
  }, [shownStatuses.join(","), mobileStatus]);
  // Latest session activity per task (its workspace's newest session update).
  const taskActivity = useMemo(() => {
    const byWorkspace = new Map<string, string>();
    for (const a of agents.data || [])
      if (a.workspaceId && a.updatedAt && (byWorkspace.get(a.workspaceId) || "") < a.updatedAt)
        byWorkspace.set(a.workspaceId, a.updatedAt);
    return new Map((board?.tasks || []).flatMap((t) => (byWorkspace.has(t.workspaceId) ? [[t.id, byWorkspace.get(t.workspaceId)!]] : [])));
  }, [agents.data, board?.tasks]);
  const sortColumn = (column: Task[]) => sortTasks(column, boardSort, taskActivity);
  const list = sortColumn(visible.filter((t) => t.status === mobileStatus));
  // Status-change flash: remember the last snapshot, emphasize cards that moved.
  const statusMemory = useRef<Map<string, string> | null>(null);
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  const flashTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    if (!board) return;
    const { next, changed } = statusChanges(statusMemory.current, board.tasks);
    statusMemory.current = next;
    if (!changed.length) return;
    setFlashing((current) => new Set([...current, ...changed]));
    // Each flash owns its timer; a quick refetch must not cancel an earlier one.
    const timer = setTimeout(() => {
      flashTimers.current.delete(timer);
      setFlashing((current) => new Set([...current].filter((id) => !changed.includes(id))));
    }, 1600);
    flashTimers.current.add(timer);
  }, [board]);
  useEffect(
    () => () => {
      flashTimers.current.forEach(clearTimeout);
      flashTimers.current.clear();
    },
    [],
  );
  const managedRead = useRpc(rpc.managedSessions);
  const managed = useQuery({
    queryKey: ["ultra", "managed"],
    queryFn: () => managedRead({}),
    refetchInterval: 10000,
  });
  const managedIds = useMemo(
    () => new Set((managed.data || []).map((m) => m.agentId)),
    [managed.data],
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
    Number(archived);
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
      `Moved to ${nameOf(input.status)}`,
    );
  };
  const place = (input: Placement) => {
    const from = data.data?.tasks.find((t) => t.id === input.id)?.status;
    void doAction(
      () => placeTask(input),
      from === input.status ? "" : `Moved to ${nameOf(input.status)}`,
    );
  };
  const openMenu = useMenuOpener();
  const cardMenu = (t: Task): MenuEntry[] => {
    const locked = pending || !!project?.archivedAt || !!t.archivedAt;
    return [
      { id: "open", label: "Open details", icon: "PanelRightOpen", onPress: () => setTask(t.id) },
      {
        id: "start",
        label: "Start session",
        icon: "Play",
        disabled: locked,
        onPress: () => {
          setTask(t.id);
          setStartRequest({ taskId: t.id, key: `start-${Date.now()}` });
        },
      },
      { kind: "separator", id: "s1" },
      { kind: "label", id: "move", label: "Move to" },
      ...shownStatuses.map((status) => ({
        id: `status-${status}`,
        label: nameOf(status),
        checked: status === t.status,
        disabled: locked,
        onPress: () => {
          if (status !== t.status) move({ id: t.id, revision: t.revision, status });
        },
      })),
      { kind: "separator", id: "s2" },
      {
        id: "up",
        label: "Move up",
        icon: "ArrowUp",
        disabled: locked,
        onPress: () => void doAction(() => reorder({ id: t.id, revision: t.revision, direction: "up" })),
      },
      {
        id: "down",
        label: "Move down",
        icon: "ArrowDown",
        disabled: locked,
        onPress: () => void doAction(() => reorder({ id: t.id, revision: t.revision, direction: "down" })),
      },
      { kind: "separator", id: "s3" },
      {
        id: "archive",
        label: t.archivedAt ? "Restore card" : "Archive card",
        icon: t.archivedAt ? "ArchiveRestore" : "Archive",
        danger: !t.archivedAt,
        disabled: pending || !!project?.archivedAt,
        onPress: () =>
          void doAction(
            () => updateTask({ id: t.id, revision: t.revision, archived: !t.archivedAt }),
            t.archivedAt ? "Card restored" : "Card archived",
          ),
      },
    ];
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
        outputSession={pickOutputSession(sessions, t.workspaceId, managedIds)}
        questions={board ? cardQuestions(t, board.events).length : 0}
        flash={flashing.has(t.id)}
        drag={drag}
        dragging={dragging}
        disabled={pending || !!project?.archivedAt || !!t.archivedAt}
        onOpen={() => setTask(t.id)}
        onActions={() => setActionTask(t)}
        menu={menuHandlers(openMenu, t.title, () => cardMenu(t))}
      />
    );
  };
  const projectMenuClose = () => setMenu(null);
  const moveProjectRpc = useRpc(rpc.moveProject);
  const reorderProject = (id: string, move: { direction: "up" | "down" | "top" } | { to: number }) =>
    void doAction(async () => {
      try {
        await moveProjectRpc({ id, ...move });
      } catch (e) {
        setProjectOrderOverride(null);
        throw e;
      }
    });
  const shortcutsOn = Platform.OS === "web" && !compact;
  const withKey = (text: string, key: string) =>
    shortcutsOn ? `${text} (${key})` : text;
  function runIntent(intent: BoardIntent | Exclude<ShortcutAction, BoardIntent>) {
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
      case "edit":
        if (!task || task.archivedAt || project?.archivedAt) return false;
        setTaskForm({ task, status: task.status });
        return true;
      case "move-left":
      case "move-right": {
        if (!task || task.archivedAt || project?.archivedAt || pending) return false;
        const target = adjacentStatus(shownStatuses, task.status, intent);
        if (!target) return false;
        move({ id: task.id, revision: task.revision, status: target });
        return true;
      }
      default: {
        if (compact) return false;
        const expanded = shownStatuses.filter((s) => !collapsedColumns.includes(s));
        const next = navigateGrid(taskGrid(expanded, visible, sortColumn), task?.id || "", intent);
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
        {...({ onContextMenu: suppressNativeMenu } as object)}
        onLayout={(e) => setSurfaceWidth(e.nativeEvent.layout.width)}
        // The root only takes focus to receive shortcuts; it must not draw a focus ring.
        style={{ flex: 1, minHeight: 0, overflow: "hidden", backgroundColor: colors.surface0, outlineStyle: "none" } as never}
      >
        {!(compact && task) && (
          <View
            style={{
              paddingHorizontal: space[3],
              height: touch ? 56 : 48,
              gap: space[2],
              flexDirection: "row",
              alignItems: "center",
              borderBottomWidth: project ? 0 : 1,
              borderColor: colors.border,
            }}
          >
            <ProjectSwitcher
              title={project?.title || "Projects"}
              archived={!!project?.archivedAt}
              shortcut={shortcutsOn ? "P" : ""}
              onPress={() => setMenu("projects")}
            />
            {!compact && !!project && filterCount > 0 && (
              // The overview counts the whole project; with filters on, say how many are shown.
              <Label muted size={font.sm} selectable={false}>
                {visible.length} shown
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
            <SortButton
              mode={boardSort}
              compact={compact}
              onPress={(event) =>
                openMenu?.(eventPoint(event), "Sort cards", [
                  { kind: "label", id: "label", label: "Sort cards in each column" },
                  ...boardSorts.map((mode) => ({
                    id: mode,
                    label: boardSortText[mode].label,
                    icon: sortIcons[mode],
                    checked: mode === boardSort,
                    onPress: () => chooseSort(mode),
                  })),
                ])
              }
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
        {!(compact && task) && project && board && (
          <OverviewBar
            overview={boardOverview(project, board.tasks, agents.data || [], attention)}
            nameOf={nameOf}
            onAttention={() => setMenu("attention")}
            onLane={(status) => {
              if (compact) setMobileStatus(status);
              else if (collapsedColumns.includes(status)) toggleCollapse(status);
            }}
          />
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
                        title={nameOf(mobileStatus)}
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
                              : `No ${nameOf(mobileStatus).toLowerCase()} tasks.`}
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
                    cancelKey={`${project.id}|${search}|${priority}|${archived}|${shownStatuses.join(",")}|${taskId}|${menu}|${actionTask?.id}|${projectForm}|${!!taskForm}`}
                    sortColumn={sortColumn}
                    manualOrder={boardSort === "manual"}
                    collapsed={collapsedColumns}
                    nameOf={nameOf}
                    onToggleCollapse={toggleCollapse}
                    onReorderBlocked={() =>
                      toast.show(`Sorted by ${boardSortText[boardSort].label.toLowerCase()}. Switch to Manual to reorder within a column.`, { variant: "info" })
                    }
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
              <SortableList
                items={projects}
                gap={space[1]}
                disabled={pending || touch}
                onMove={(id, to) => {
                  const ids = projects.map((q) => q.id);
                  // `to` is an index in the visible list; the server orders all projects.
                  const all = (board?.projects || []).slice().sort(projectOrder).map((q) => q.id);
                  const next = ids.filter((q) => q !== id);
                  next.splice(to, 0, id);
                  setProjectOrderOverride(next);
                  reorderProject(id, { to: all.indexOf(ids[to]) });
                }}
                renderItem={(p, index, pressable) => (
                  <Row
                    title={p.title}
                    detail={p.primaryPath}
                    icon={p.archivedAt ? "Archive" : "Folder"}
                    selected={project?.id === p.id}
                    leading={
                      !touch && projects.length > 1 ? (
                        // Grip on the left, tucked against the folder icon.
                        <View
                          accessibilityLabel="Drag to reorder"
                          style={{ width: 14, marginLeft: -space[1.5], marginRight: -space[1.5], alignItems: "center", ...({ cursor: "grab" } as object) }}
                        >
                          <Icon name="GripVertical" size={14} color={colors.foregroundMuted} />
                        </View>
                      ) : undefined
                    }
                    trailing={
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                        {p.archivedAt && <Badge>Archived</Badge>}
                        {touch && projects.length > 1 && (
                          <>
                            <IconButton icon="ChevronUp" size={36} label={`Move ${p.title} up`} disabled={index === 0 || pending} onPress={() => reorderProject(p.id, { direction: "up" })} />
                            <IconButton icon="ChevronDown" size={36} label={`Move ${p.title} down`} disabled={index === projects.length - 1 || pending} onPress={() => reorderProject(p.id, { direction: "down" })} />
                          </>
                        )}
                      </View>
                    }
                    onPress={() => {
                      if (!pressable()) return;
                      chooseProject(p.id);
                      setTask("");
                      projectMenuClose();
                    }}
                  />
                )}
              />
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
              </View>
              <Actions>
                <Button
                  quiet
                  disabled={!filterCount}
                  onPress={() => {
                    setSearch("");
                    setPriority("all");
                    setArchived(false);
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
                    detail={`${item.project.title} · ${laneName(item.project, item.task.status)} · ${[
                      item.questions && `${item.questions} question${item.questions === 1 ? "" : "s"}`,
                      item.permissions && `${item.permissions} approval`,
                      item.errors && `${item.errors} error`,
                      item.unread &&
                        `${item.unread} unread${item.silent ? ` (${item.silent === item.unread ? "" : `${item.silent} `}no report)` : ""}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}`}
                    label={`Open ${item.task.title}`}
                    leading={
                      <Dot
                        size={8}
                        color={
                          item.permissions || item.questions
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
                  title={nameOf(s)}
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
                  {shownStatuses.map((s) => (
                    <Row
                      key={s}
                      title={nameOf(s)}
                      label={`Move to: ${nameOf(s)}`}
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
            laneCounts={Object.fromEntries(
              shownStatuses.map((s) => [s, tasks.filter((t) => t.status === s && !t.archivedAt).length]),
            )}
            onClose={() => setProjectForm(null)}
            onSaved={(id) => {
              chooseProject(id);
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
            agentDefaults={sessionDefaults}
            onSaved={(id, launch) => {
              setTask(id);
              setTaskForm(null);
              if (launch?.sessionId) toast.show("Task created and its agent started", { variant: "success" });
              else if (launch?.error) toast.error(`Task created, but the agent did not start: ${launch.error}. Start it from the task.`);
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
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover || focused;
        return {
          ...noFocusRing,
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
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover || focused;
        return {
          ...noFocusRing,
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

const sortIcons: Record<BoardSort, string> = {
  manual: "GripVertical",
  activity: "Activity",
  priority: "SignalHigh",
  created: "CalendarPlus",
  title: "ArrowDownAZ",
};

function SortButton({ mode, compact, onPress }: { mode: BoardSort; compact: boolean; onPress(event: GestureResponderEvent): void }) {
  const { colors } = useTheme();
  const custom = mode !== "manual";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Sort cards: ${boardSortText[mode].label}`}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        return {
          ...noFocusRing,
          flexDirection: "row",
          alignItems: "center",
          gap: space[1.5],
          height: touch ? 44 : 32,
          minWidth: touch ? 44 : 32,
          justifyContent: "center",
          paddingHorizontal: compact ? 0 : space[2] + 2,
          borderRadius: radius.md,
          backgroundColor: hover || focused || pressed ? colors.surface2 : "transparent",
        };
      }}
    >
      <Icon name="ArrowUpDown" size={15} color={custom ? colors.foreground : colors.foregroundMuted} />
      {!compact && (
        <Label size={font.md} medium muted={!custom} selectable={false}>
          {custom ? boardSortText[mode].label : "Sort"}
        </Label>
      )}
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
        const { pressed, hovered: hover, focused } = state as typeof state & { hovered?: boolean; focused?: boolean };
        const hovered = hover || focused;
        return {
          ...noFocusRing,
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


export function WorkspaceBoard(props: PluginWorkspacePanelProps) {
  return <BoardScreen {...props} workspaceId={props.workspaceId} />;
}
