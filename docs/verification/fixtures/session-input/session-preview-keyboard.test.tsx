import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ actor: undefined as any, platform: "web", send: undefined as any, tail: undefined as any, rpc: undefined as any }));

vi.mock("react-native", async () => {
  const React = await import("react");
  const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return { ActivityIndicator: host("ActivityIndicator"), KeyboardAvoidingView: host("KeyboardAvoidingView"), Pressable: host("Pressable"), View: host("View"), Platform: { get OS() { return state.platform; } } };
});
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const React = await import("react");
  const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return { Icon: host("Icon"), ScrollView: host("ScrollView"), TextInput: host("TextInput") };
});
vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: () => ({ agents: { ref: () => ({ refresh: async () => ({ agent: state.actor }), timeline: { refetch: async () => ({ entries: [] }), subscribe: () => { const done: any = () => {}; done.ready = Promise.resolve(); return done; } } }) } }), useRpc: () => vi.fn(async () => ({ available: true, context: "fixture" })) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: any) => {
  const kind = options.queryKey[1];
  const data = kind === "agent" ? { agent: state.actor } : kind === "timeline" ? { entries: [] } : kind === "tools" ? { ready: true } : kind === "access" ? { methods: [], ready: true } : {};
  return { data, isSuccess: true, isPending: false, isError: false, error: null, refetch: vi.fn(async () => ({ agent: state.actor, entries: [] })) };
} }));
vi.mock("../../../../shared/rpc", () => ({ taskContext: {}, toolsHealth: {}, prepareExisting: {}, accessState: {} }));
vi.mock("../../../../client/session-reads", () => ({ useSessionReads: () => ({ query: { isPending: false, isError: false, error: null }, receipts: [], markRead: vi.fn() }) }));
vi.mock("../../../../client/session", () => ({ sendCardInstruction: (...args: any[]) => state.send(...args), workspaceSession: vi.fn(async () => state.actor) }));
vi.mock("../../../../client/session-state", () => ({ openNativeSession: vi.fn(), recentSessionOutput: () => [], sessionState: () => ({ icon: "", active: true, label: "Running" }) }));
vi.mock("../../../../client/session-content", () => ({ SessionMarkdown: ({ text }: any) => text }));
vi.mock("../../../../client/session-follow", () => ({ coalescedRefresh: () => ({ trigger: vi.fn(), dispose: vi.fn() }), useSessionFollowTail: () => state.tail }));
vi.mock("../../../../client/ui", async () => {
  const React = await import("react");
  const Button = ({ children, ...props }: any) => React.createElement("Button", props, children);
  const Label = ({ children, ...props }: any) => React.createElement("Label", props, children);
  const Notice = ({ children }: any) => React.createElement("Notice", null, children);
  const Choices = ({ title, value, options, onChange }: any) => React.createElement("Choices", { title, value, options, onChange });
  return { Button, Label, Notice, Choices, useTheme: () => ({ colors: { accent: "accent", accentForeground: "on-accent", border: "border", surface0: "surface", surface1: "surface1", foregroundMuted: "muted", foreground: "fg" } }), message: (e: any) => String(e?.message ?? e) };
});
vi.mock("../../../../client/motion", () => ({ MotionReveal: ({ children }: any) => children }));

const rendererPath = process.env.SESSION_INPUT_RENDERER;
const renderer = rendererPath ? require(rendererPath) : null;
const { act, create } = renderer || { act: (fn: () => unknown) => fn(), create: () => undefined };
const { SessionPreview } = await import("../../../../client/session-preview");
const task: any = { id: "task-fixture", workspaceId: "workspace-fixture", title: "Fixture task", revision: 1 };
const actor = (overrides: any = {}) => ({ id: "agent-fixture", workspaceId: task.workspaceId, title: "Fixture agent", provider: "codex", model: "gpt-6-luna", status: "running", archivedAt: null, providerUnavailable: false, pendingPermissions: [], ...overrides });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
const asText = (node: any): string => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(asText).join(" ") : node?.props?.children ? asText(node.props.children) : node?.children ? asText(node.children) : "";
const button = (tree: any, label: string) => tree.root.findAllByType("Button").find((item: any) => asText(item).includes(label));
const compactAction = (tree: any, label: string) => tree.root.findAllByType("Pressable").find((item: any) => item.props.accessibilityLabel === label);
const setup = (overrides: any = {}) => {
  const props: any = { task, sessionId: "agent-fixture", hostId: "host-fixture", events: [], unavailable: false, navigation: undefined, draft: "draft", pending: false,
    beginOperation: vi.fn(() => true), endOperation: vi.fn(), onDraftChange: vi.fn(), onBack: vi.fn(), refresh: vi.fn(), ...overrides };
  return props;
};

beforeEach(() => {
  state.actor = actor(); state.platform = "web"; state.send = vi.fn(async () => undefined);
  state.tail = { following: true, scrollRef: { current: null }, scrollToTail: vi.fn(), onScroll: vi.fn(), onScrollBeginDrag: vi.fn(), onScrollEndDrag: vi.fn(), jumpToLatest: vi.fn() };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

describe.skipIf(!rendererPath)("SessionPreview keyboard submission", () => {
  test("uses web Enter/Shift/IME/modifier/repeat semantics and keeps native callback ignored on web", async () => {
    let tree: any; const p = setup();
    await act(async () => { tree = create(<SessionPreview {...p} />); await flush(); });
    const input = tree.root.findByType("TextInput"), preventDefault = vi.fn();
    expect(input.props.value).toBe("draft");
    expect(input.props.onKeyPress({ nativeEvent: { key: "Enter" }, preventDefault })).toBeUndefined();
    await act(async () => { await flush(); });
    expect(preventDefault).toHaveBeenCalledTimes(1); expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0][4]).toBe("draft");
    expect(input.props.onSubmitEditing({ nativeEvent: {} })).toBeUndefined();
    expect(state.send).toHaveBeenCalledTimes(1);
    const untouched = [ { key: "Enter", shiftKey: true }, { key: "Enter", ctrlKey: true }, { key: "Enter", metaKey: true }, { key: "Enter", altKey: true }, { key: "Enter", isComposing: true }, { key: "Enter", keyCode: 229 }, { key: "a" } ];
    for (const nativeEvent of untouched) input.props.onKeyPress({ nativeEvent, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    input.props.onKeyPress({ nativeEvent: { key: "Enter", repeat: true }, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2); expect(state.send).toHaveBeenCalledTimes(1);
    expect(input.props.multiline).toBe(true); expect(input.props.blurOnSubmit).toBe(false); expect(input.props.submitBehavior).toBe("newline");
    tree.unmount();
  });

  test("captures onChangeText synchronously before rerender and preserves newer draft while a send is pending", async () => {
    let release!: () => void; state.send = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const p = setup({ draft: "old" }); let tree: any;
    await act(async () => { tree = create(<SessionPreview {...p} />); await flush(); });
    const input = tree.root.findByType("TextInput");
    act(() => { input.props.onChangeText("submitted latest"); input.props.onKeyPress({ nativeEvent: { key: "Enter" }, preventDefault: vi.fn() }); });
    expect(state.send).toHaveBeenCalledTimes(1); expect(state.send.mock.calls[0][4]).toBe("submitted latest");
    act(() => { input.props.onChangeText("newer while pending"); });
    await act(async () => { release(); await flush(); });
    expect(p.onDraftChange).toHaveBeenCalledWith("agent-fixture", "", "submitted latest");
    expect(input.props.value).toBe("old"); // the parent has not acknowledged either edit
    await act(async () => { tree.update(<SessionPreview {...p} draft="newer while pending" />); });
    expect(tree.root.findByType("TextInput").props.value).toBe("newer while pending");
    expect(state.tail.jumpToLatest).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  test("synchronous lock deduplicates keyboard/button; failure retains draft and permits retry", async () => {
    let release!: (e?: Error) => void; state.send = vi.fn(() => new Promise<void>((_resolve, reject) => { release = (e) => e ? reject(e) : undefined; }));
    const p = setup(); let tree: any;
    await act(async () => { tree = create(<SessionPreview {...p} />); await flush(); });
    const input = tree.root.findByType("TextInput"), send = button(tree, "Send instruction");
    act(() => { input.props.onKeyPress({ nativeEvent: { key: "Enter" }, preventDefault: vi.fn() }); send.props.onPress(); });
    expect(state.send).toHaveBeenCalledTimes(1); expect(p.beginOperation).toHaveBeenCalledTimes(1);
    await act(async () => { release(new Error("send failed")); await flush(); });
    expect(tree.root.findByType("TextInput").props.value).toBe("draft");
    expect(asText(tree.root)).toContain("send failed"); expect(state.tail.jumpToLatest).not.toHaveBeenCalled();
    state.send.mockImplementation(async () => undefined);
    expect(button(tree, "Send instruction").props.disabled).toBe(false);
    await act(async () => { button(tree, "Send instruction").props.onPress(); await flush(); });
    expect(state.send).toHaveBeenCalledTimes(2); expect(p.endOperation).toHaveBeenCalledTimes(2);
    tree.unmount();
  });

  test("stale key callbacks recheck pending, availability, membership and visibility; Back/unmount fences callbacks", async () => {
    const p = setup(); let tree: any;
    await act(async () => { tree = create(<SessionPreview {...p} />); await flush(); });
    const oldKey = tree.root.findByType("TextInput").props.onKeyPress;
    await act(async () => { tree.update(<SessionPreview {...p} pending />); }); oldKey({ nativeEvent: { key: "Enter" }, preventDefault: vi.fn() });
    await act(async () => { tree.update(<SessionPreview {...p} unavailable />); }); oldKey({ nativeEvent: { key: "Enter" }, preventDefault: vi.fn() });
    state.actor = actor({ workspaceId: "moved-workspace" });
    await act(async () => { tree.update(<SessionPreview {...p} unavailable={false} />); });
    oldKey({ nativeEvent: { key: "Enter" }, preventDefault: vi.fn() });
    await act(async () => { tree.update(<SessionPreview {...p} visible={false} />); }); oldKey({ nativeEvent: { key: "Enter" }, preventDefault: vi.fn() });
    expect(state.send).not.toHaveBeenCalled();
    await act(async () => { tree.unmount(); }); oldKey({ nativeEvent: { key: "Enter" }, preventDefault: vi.fn() });
    expect(state.send).not.toHaveBeenCalled();
  });

  test("native keyboard Send is configured and routes IME-aware submit once; mode and tools purpose stay correct", async () => {
    state.platform = "ios"; const p = setup(); let tree: any;
    await act(async () => { tree = create(<SessionPreview {...p} />); await flush(); });
    const input = tree.root.findByType("TextInput");
    expect(input.props.submitBehavior).toBe("submit"); expect(input.props.returnKeyType).toBe("send"); expect(input.props.blurOnSubmit).toBe(false);
    act(() => { input.props.onSubmitEditing({ nativeEvent: { isComposing: true } });
      input.props.onSubmitEditing({ nativeEvent: { keyCode: 229 } }); });
    expect(state.send).not.toHaveBeenCalled();
    await act(async () => { input.props.onSubmitEditing({ nativeEvent: {} }); await flush(); });
    expect(state.send).toHaveBeenCalledTimes(1); expect(state.send.mock.calls[0][5]).toBe("steer");
    const choices = tree.root.findByType("Choices");
    await act(async () => { choices.props.onChange("interrupt"); tree.update(<SessionPreview {...p} draft="second" />); await flush(); });
    await act(async () => { tree.root.findByType("TextInput").props.onSubmitEditing({ nativeEvent: {} }); await flush(); });
    expect(state.send.mock.calls[1][5]).toBe("interrupt");
    await act(async () => { button(tree, "Kanban tools").props.onPress(); });
    expect(asText(tree.root)).toContain("Lets this Agent read its task");
    expect(asText(tree.root)).toContain("Blocked"); expect(asText(tree.root)).toContain("Done");
    tree.unmount();
  });

  test("empty and moved/archived/provider unavailable actors cannot send", async () => {
    const p = setup({ draft: "  " }); let tree: any;
    await act(async () => { tree = create(<SessionPreview {...p} />); await flush(); });
    const key = tree.root.findByType("TextInput").props.onSubmitEditing;
    key({ nativeEvent: {} }); expect(state.send).not.toHaveBeenCalled(); tree.unmount();
    for (const unavailableActor of [actor({ workspaceId: "other" }), actor({ archivedAt: "now" }), actor({ providerUnavailable: true })]) {
      state.actor = unavailableActor;
      await act(async () => { tree = create(<SessionPreview {...setup()} />); await flush(); });
      if (unavailableActor.workspaceId !== task.workspaceId) {
        expect(tree.root.findAllByType("TextInput")).toHaveLength(0);
      } else {
        tree.root.findByType("TextInput").props.onKeyPress({ nativeEvent: { key: "Enter" }, preventDefault: vi.fn() });
      }
      expect(state.send).not.toHaveBeenCalled(); tree.unmount();
    }
  });

  test("compact Android composer uses one input/send row, bounded growth and a single mode row", async () => {
    state.platform = "android"; const p = setup({ compact: true }); let tree: any;
    await act(async () => { tree = create(<SessionPreview {...p} />); await flush(); });
    let input = tree.root.findByType("TextInput");
    expect(input.props.style.height).toBe(48);
    expect(input.props.style.maxHeight).toBe(96);
    expect(input.props.accessibilityLabel).toBe("Follow-up instruction");
    expect(input.props.returnKeyType).toBe("send");
    expect(tree.root.findAllByType("Choices")).toHaveLength(0);
    const send = compactAction(tree, "Send instruction");
    expect(send.props.style.width).toBe(48);
    expect(send.props.style.height).toBe(48);
    expect(compactAction(tree, "Steer running session").props.accessibilityState.selected).toBe(true);
    expect(compactAction(tree, "Interrupt running session").props.style.minHeight).toBe(48);
    await act(async () => { input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 150 } } }); });
    input = tree.root.findByType("TextInput");
    expect(input.props.style.height).toBe(96);
    await act(async () => { compactAction(tree, "Interrupt running session").props.onPress(); });
    await act(async () => { compactAction(tree, "Send instruction").props.onPress(); await flush(); });
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0][5]).toBe("interrupt");
    state.tail.following = false;
    await act(async () => { tree.update(<SessionPreview {...p} />); });
    expect(compactAction(tree, "Jump to latest").props.style.height).toBe(48);
    act(() => { compactAction(tree, "Jump to latest").props.onPress(); });
    expect(state.tail.jumpToLatest).toHaveBeenCalled();
    state.actor = actor({ status: "idle" });
    await act(async () => { tree.update(<SessionPreview {...p} />); });
    expect(compactAction(tree, "Steer running session")).toBeUndefined();
    await act(async () => { tree.update(<SessionPreview {...p} unavailable />); });
    expect(compactAction(tree, "Send instruction").props.disabled).toBe(true);
    tree.unmount();
  });
});
