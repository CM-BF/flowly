import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  actor: undefined as any,
  reads: undefined as any,
  markRead: undefined as any,
  paseo: undefined as any,
  operations: [] as string[],
  panResponder: undefined as any,
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const motion = await import("../motion/rn-motion-mock");
  const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return {
    ...motion.createReactNativeMotionMock(),
    ActivityIndicator: host("ActivityIndicator"), KeyboardAvoidingView: host("KeyboardAvoidingView"),
    View: host("View"), Pressable: host("Pressable"), PanResponder: { create: (handlers: any) => { state.panResponder = handlers; return { panHandlers: handlers }; } },
    Platform: { OS: "web" },
  };
});
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const React = await import("react");
  const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return { Icon: host("Icon"), ScrollView: host("ScrollView"), TextInput: host("TextInput") };
});
vi.mock("@getpaseo/plugin/client", () => ({
  usePaseo: () => state.paseo,
  useRpc: () => vi.fn(async () => ({ available: true, context: "fixture" })),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => {
    const key = options.queryKey as unknown[];
    let data: any = {};
    if (key[1] === "agent") data = { agent: state.actor };
    if (key[1] === "timeline") data = { entries: [] };
    if (key[1] === "tools") data = { ready: true };
    if (key[1] === "access") data = { methods: [], ready: true };
    return { data, isSuccess: true, isPending: false, isError: false, error: null, refetch: vi.fn(async () => ({ agent: state.actor, entries: [] })) };
  },
}));
vi.mock("../../../../shared/rpc", () => ({ taskContext: {}, toolsHealth: {}, prepareExisting: {}, accessState: {} }));
vi.mock("../../../../client/session-reads", () => ({ useSessionReads: () => state.reads }));
vi.mock("../../../../client/session", () => ({
  sendCardInstruction: vi.fn(async () => undefined),
  workspaceSession: vi.fn(async () => state.actor),
}));
vi.mock("../../../../client/session-content", () => ({ SessionMarkdown: ({ text }: any) => text }));
vi.mock("../../../../client/session-follow", () => ({
  coalescedRefresh: () => ({ trigger: vi.fn(), dispose: vi.fn() }),
  useSessionFollowTail: () => ({ following: true, scrollRef: { current: null }, scrollToTail: vi.fn(), onScroll: vi.fn(), onScrollBeginDrag: vi.fn(), onScrollEndDrag: vi.fn(), jumpToLatest: vi.fn() }),
}));
vi.mock("../../../../client/ui", async () => {
  const React = await import("react");
  const Button = ({ children, ...props }: any) => React.createElement("Button", props, children);
  const Label = ({ children, ...props }: any) => React.createElement("Label", props, children);
  const Notice = ({ children }: any) => React.createElement("Notice", null, children);
  const passthrough = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return {
    Button, Label, Notice, Choices: passthrough("Choices"),
    useTheme: () => ({ colors: { accent: "accent", border: "border", surface0: "surface", surface1: "surface1", foregroundMuted: "muted", foreground: "fg" } }),
    message: (error: any) => String(error?.message ?? error),
  };
});

const rendererPath = process.env.SESSION_ATTENTION_RENDERER;
const renderer = rendererPath ? require(rendererPath) : null;
const { act, create } = renderer || { act: (fn: () => unknown) => fn(), create: () => undefined };
const { SessionPreview } = await import("../../../../client/session-preview");
const { TaskCard } = await import("../../../../client/card");
const task: any = { id: "task-x", projectId: "project-x", workspaceId: "workspace-x", title: "Task", revision: 1 };
const actor = (timestamp = "2026-10-14T01:00:00.000Z") => ({
  id: "agent-selected", workspaceId: task.workspaceId, title: "Selected session", provider: "codex", model: "gpt-6-luna",
  status: "idle", archivedAt: null, pendingPermissions: [], lastUserMessageAt: null, requiresAttention: true,
  attentionReason: "finished", attentionTimestamp: timestamp, updatedAt: timestamp,
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };
const text = (node: any): string => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join(" ") : node?.props?.children ? text(node.props.children) : node?.children ? text(node.children) : "";
const button = (tree: any, label: string) => tree.root.findAllByType("Button").find((item: any) => text(item).includes(label));
const props = () => ({
  task, sessionId: "agent-selected", hostId: "host-fixture", events: [], unavailable: false,
  navigation: undefined, draft: "keep this draft", pending: false,
  beginOperation: (id: string) => { state.operations.push(`begin:${id}`); return true; },
  endOperation: (id: string) => state.operations.push(`end:${id}`),
  onDraftChange: vi.fn(), onBack: vi.fn(), refresh: vi.fn(),
});

beforeEach(() => {
  state.actor = actor();
  state.operations = [];
  state.markRead = vi.fn(async () => ({ taskId: task.id, workspaceId: task.workspaceId, agentId: state.actor.id, token: JSON.stringify([state.actor.id, state.actor.attentionReason, state.actor.attentionTimestamp]), readAt: "2026-10-14T02:00:00Z" }));
  state.reads = { query: { data: { version: 1, receipts: [] }, isPending: false, isError: false, error: null }, receipts: [], markRead: (...args: any[]) => state.markRead(...args) };
  const agentRef = () => ({
    refresh: vi.fn(async () => ({ agent: state.actor })), send: vi.fn(),
    timeline: { refetch: vi.fn(async () => ({ entries: [] })), subscribe: vi.fn(() => { const stop: any = () => {}; stop.ready = Promise.resolve(); return stop; }) },
  });
  state.paseo = { agents: { ref: agentRef } };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => vi.clearAllMocks());

describe.skipIf(!rendererPath)("session attention preview callback fixture", () => {
  test("does not mark on selection/render and acknowledges only the selected session generation", async () => {
    let tree: any;
    await act(async () => { tree = create(<SessionPreview {...props()} />); await flush(); });
    expect(state.markRead).not.toHaveBeenCalled();
    expect(text(tree.root)).toContain("Unread");
    expect(tree.root.findByProps({ testID: "session-composer" })).toBeTruthy();
    expect(tree.root.findAllByType("TextInput")[0].props.value).toBe("keep this draft");
    const mark = button(tree, "Mark as read");
    await act(async () => { mark.props.onPress(); await flush(); });
    expect(state.markRead).toHaveBeenCalledTimes(1);
    expect(state.markRead).toHaveBeenCalledWith({ taskId: "task-x", agentId: "agent-selected", token: JSON.stringify(["agent-selected", "finished", "2026-10-14T01:00:00.000Z"]) });
    expect(tree.root.findAllByType("TextInput")[0].props.value).toBe("keep this draft");
    tree.unmount();
  });

  test("locks double-click, preserves unread state on RPC failure, and cannot acknowledge a newer generation", async () => {
    let rejectMark!: (error: Error) => void;
    state.markRead = vi.fn(() => new Promise((_resolve, reject) => { rejectMark = reject; }));
    let tree: any;
    await act(async () => { tree = create(<SessionPreview {...props()} />); await flush(); });
    const mark = button(tree, "Mark as read");
    act(() => { mark.props.onPress(); mark.props.onPress(); });
    expect(state.markRead).toHaveBeenCalledTimes(1);
    expect(state.markRead.mock.calls[0][0].token).toContain("01:00:00");
    state.actor = actor("2026-10-14T03:00:00.000Z");
    await act(async () => { tree.update(<SessionPreview {...props()} />); await flush(); });
    await act(async () => { rejectMark(new Error("Session attention changed. Refresh before marking it as read.")); await flush(); });
    expect(text(tree.root)).toContain("Unread");
    expect(text(tree.root)).toContain("Session attention changed");
    expect(state.markRead).toHaveBeenCalledTimes(1);
    expect(button(tree, "Mark as read")).toBeTruthy();
    tree.unmount();
  });

  test("read-state query failure renders unavailable and disables acknowledgement", async () => {
    state.reads.query = { data: undefined, isPending: false, isError: true, error: new Error("read RPC unavailable") };
    let tree: any;
    await act(async () => { tree = create(<SessionPreview {...props()} />); await flush(); });
    expect(text(tree.root)).toContain("Read state unavailable");
    expect(text(tree.root)).toContain("read RPC unavailable");
    expect(button(tree, "Mark as read").props.disabled).toBe(true);
    expect(state.markRead).not.toHaveBeenCalled();
    tree.unmount();
  });

  test("TaskCard retains unread badge, whole-card mouse drag callbacks and non-selectable text", async () => {
    const drag = { start: vi.fn(), move: vi.fn(), end: vi.fn(), cancel: vi.fn() };
    const summary = { total: 2, running: 1, starting: 0, finished: 0, unread: 1, attention: 1, permissions: 0, errors: 0, unknownRead: 0 } as any;
    let tree: any;
    await act(async () => {
      tree = create(<TaskCard task={{ ...task, priority: "normal", archivedAt: null }} selected={false} legacy={false} available running={1} sessions={2} summary={summary} drag={drag} onOpen={vi.fn()} onActions={vi.fn()} />);
    });
    expect(text(tree.root)).toMatch(/1\s+unread.*1\s+need attention/);
    expect(tree.root.findAllByType("Label").every((label: any) => label.props.selectable === false)).toBe(true);
    const card = tree.root.findAllByType("View")[0];
    act(() => card.props.onPointerDown({ nativeEvent: { pointerType: "mouse", button: 0 } }));
    expect(card.props.onMoveShouldSetPanResponderCapture({}, { dx: 9, dy: 0 })).toBe(true);
    act(() => card.props.onPanResponderGrant({ nativeEvent: { pageX: 10, pageY: 20 } }));
    act(() => card.props.onPanResponderMove({}, { moveX: 25, moveY: 30 }));
    act(() => card.props.onPanResponderRelease({ nativeEvent: { pageX: 25, pageY: 30 } }));
    expect(drag.start).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), { x: 10, y: 20 });
    expect(drag.move).toHaveBeenCalledWith({ x: 25, y: 30 });
    expect(drag.end).toHaveBeenCalledWith({ x: 25, y: 30 });
    tree.unmount();
  });
});
