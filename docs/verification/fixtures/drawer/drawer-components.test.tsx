import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { motionMockState } from "../motion/rn-motion-mock";

const state = vi.hoisted(() => ({
  agents: [] as any[],
  overrides: {} as Record<string, any>,
  paseo: {} as any,
  rpc: {} as Record<string, any>,
  reads: { query: { data: {}, refetch: vi.fn() }, receipts: [] as any[] },
}));

vi.mock("react-native", async () => ({
  ...(await import("../motion/rn-motion-mock")).createReactNativeMotionMock(),
  View: "View", Pressable: "Pressable", Text: "Text", Platform: { OS: "web" },
  PanResponder: { create: (handlers: any) => ({ panHandlers: handlers }) },
}));
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const React = await import("react");
  const motion = await import("../motion/rn-motion-mock");
  const Modal = Object.assign(
    ({ children, open, ...props }: any) => React.createElement("Modal", { ...props, open }, open ? children : null),
    { Content: ({ children }: any) => React.createElement("ModalContent", null, children) },
  );
  return { ...motion.createHostToastMock(), Modal, ScrollView: "ScrollView", Icon: "Icon" };
});
vi.mock("@getpaseo/plugin/client/ui", async () => {
  const React = await import("react");
  return { SettingsSelect: (props: any) => React.createElement("SettingsSelect", props) };
});
vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: () => state.paseo, useRpc: (key: string) => state.rpc[key] }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (options: any) => {
  const key = (options.queryKey as unknown[]).join("|");
  if (state.overrides[key]) return state.overrides[key];
  switch ((options.queryKey as unknown[])[1]) {
    case "workspace": return { data: { name: "Workspace fixture", workspaceDirectory: "/tmp/drawer-fixture", status: "active" }, isPending: false, isError: false, refetch: vi.fn() };
    case "context": return { data: { available: true, directories: [{ repo: "/legacy/repo", directory: "/legacy/worktree" }, { repo: "/legacy/second", directory: "/legacy/second-worktree" }], owner: "native-owner" }, isPending: false, isError: false, refetch: vi.fn() };
    case "sessions": return { data: state.agents, isPending: false, error: null, refetch: vi.fn() };
    default: return { data: undefined, isPending: false, isError: false, refetch: vi.fn() };
  }
} }));
vi.mock("../../../../shared/rpc", () => ({ updateTask: "updateTask", taskContext: "taskContext" }));
vi.mock("../../../../client/resources", () => ({ listAgents: async () => state.agents }));
vi.mock("../../../../client/session-reads", () => ({ useSessionReads: () => state.reads }));
vi.mock("../../../../client/session-card", async () => {
  const React = await import("react");
  return { SessionCard: ({ agent, onPress }: any) => React.createElement("Pressable", { accessibilityLabel: `Preview Session ${agent.id}`, onPress }) };
});
vi.mock("../../../../client/session-preview", async () => {
  const React = await import("react");
  return { SessionPreview: (props: any) => React.createElement("Preview", props, React.createElement("Button", { onPress: props.onBack }, "Back")) };
});
vi.mock("../../../../client/session-create", async () => {
  const React = await import("react");
  return { SessionCreate: (props: any) => React.createElement("Create", { open: props.open, unavailable: props.unavailable }) };
});
vi.mock("../../../../client/ui", async () => {
  const React = await import("react");
  const element = (type: string) => ({ children, ...props }: any) => React.createElement(type, props, children);
  return { Button: element("Button"), Label: element("Label"), Notice: element("Notice"), Field: element("Field"), Choices: element("Choices"), Theme: { Provider: ({ children }: any) => children },
    useTheme: () => ({ colors: { border: "border", surface0: "surface", foregroundMuted: "muted" } }),
    message: (error: any) => String(error?.message ?? error), basename: (path: string) => path.split("/").at(-1) };
});
vi.mock("../../../../client/session-attention", () => ({ sessionAttention: () => false }));

const rendererPath = process.env.DRAWER_TEST_RENDERER;
const renderer = rendererPath ? require(rendererPath) : null;
const { act, create } = renderer || { act: (_fn: () => unknown) => {}, create: () => undefined };
const { MotionProvider, motionDuration } = await import("../../../../client/motion");
const { TaskDrawer } = await import("../../../../client/drawer");
const { Disclosure } = await import("../../../../client/disclosure");
const { ResizeGrip } = await import("../../../../client/resize");

const task: any = { id: "drawer-task", projectId: "drawer-project", workspaceId: "drawer-workspace", sourcePath: "/root/source", repoPaths: ["/legacy/repo"], title: "Drawer fixture", description: "Description fixture", status: "todo", priority: "high", position: 0, revision: 7, operationId: "op", createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", archivedAt: null };
const project: any = { id: task.projectId, title: "Project fixture", primaryPath: "/root/project", repoPaths: ["/legacy/repo"], revision: 4 };
const events: any[] = [];
const agent = { id: "drawer-session", title: "Session fixture", workspaceId: task.workspaceId, status: "idle", createdAt: "2026-10-14", updatedAt: "2026-10-14", pendingPermissions: [] };
let tree: any;
const updateTask = vi.fn(async () => undefined);
const refresh = vi.fn();
const toastShow = vi.fn();
const element = (props: any = {}) => <MotionProvider><TaskDrawer task={task} project={project} events={events} compact={false} hostId="fixture-host" navigation={{} as any} onClose={vi.fn()} onEdit={vi.fn()} refresh={refresh} {...props} /></MotionProvider>;
const mount = (props: any = {}) => create(element(props));
const findText = (text: string) => tree.root.findAll((node: any) => node.children?.some((child: any) => child === text));
const byLabel = (label: string) => tree.root.findAllByProps({ accessibilityLabel: label })[0];
const details = () => byLabel("Details & workspace");

beforeEach(() => {
  tree = undefined;
  state.agents = [agent]; state.overrides = {};
  state.paseo = { workspaces: { ref: () => ({ refresh: async () => ({ name: "Workspace fixture", workspaceDirectory: "/tmp/drawer-fixture", status: "active" }) }) } };
  state.rpc = { updateTask, taskContext: vi.fn(async () => ({ available: true, directories: [{ repo: "/legacy/repo", directory: "/legacy/worktree" }, { repo: "/legacy/second", directory: "/legacy/second-worktree" }], owner: "native-owner" })) };
  state.reads = { query: { data: {}, refetch: vi.fn() }, receipts: [] };
  updateTask.mockReset().mockImplementation(async () => undefined); refresh.mockReset(); toastShow.mockReset();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  motionMockState.reset(); motionMockState.toastShow = toastShow;
});
afterEach(() => { tree?.unmount(); tree = undefined; });

describe.skipIf(!rendererPath)("task drawer redesign", () => {
  test("header selector is grouped, same-value is a no-op, changed status writes one captured CAS and success toast", async () => {
    await act(async () => { tree = mount(); });
    const actions = tree.root.findByProps({ testID: "task-actions" });
    const selector = actions.findByType("SettingsSelect");
    expect(selector.props.label).toBe("Status");
    expect(selector.props.options).toHaveLength(7);
    expect(actions.findAllByType("Button").map((x: any) => x.children.join(""))).toContain("Edit");
    expect(actions.findAllByType("Button").map((x: any) => x.children.join(""))).toContain("Archive");
    expect(tree.root.findAllByType("Choices")).toHaveLength(0);
    expect(tree.root.findAll((n: any) => n.type === "Button" && /workspace/i.test(n.children.join("")))).toHaveLength(0);
    await act(async () => { selector.props.onValueChange("todo"); });
    expect(updateTask).not.toHaveBeenCalled();
    await act(async () => { selector.props.onValueChange("development"); await Promise.resolve(); });
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith({ id: task.id, revision: task.revision, status: "development" });
    expect(toastShow).toHaveBeenCalledWith("Moved to In progress", { variant: "success" });
  });

  test("compact status action shows the full label and opens a guarded seven-choice host sheet", async () => {
    const inProgress = { ...task, status: "development" };
    await act(async () => { tree = mount({ task: inProgress, compact: true }); });
    const actions = tree.root.findByProps({ testID: "task-actions" });
    expect(actions.findAllByType("SettingsSelect")).toHaveLength(0);
    const selected = actions.findAllByType("Button").find((item: any) => item.props.label === "Status: In progress");
    expect(selected).toBeTruthy();
    expect(selected.children.join("")).toBe("In progress");
    expect(selected.props.disabled).toBe(false);
    await act(async () => { selected.props.onPress(); });
    const modal = tree.root.findByType("Modal");
    expect(modal.props.open).toBe(true);
    const options = modal.findAllByType("Button");
    expect(options.map((item: any) => item.children.join(""))).toEqual([
      "Backlog", "Todo", "In progress", "In review", "Blocked", "Done", "Cancelled",
    ]);
    await act(async () => { options.find((item: any) => item.children.join("") === "In progress").props.onPress(); });
    expect(updateTask).not.toHaveBeenCalled();
    expect(tree.root.findByType("Modal").props.open).toBe(false);
    await act(async () => { selected.props.onPress(); });
    const blocked = tree.root.findByType("Modal").findAllByType("Button").find((item: any) => item.children.join("") === "Blocked");
    await act(async () => { blocked.props.onPress(); await Promise.resolve(); });
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith({ id: task.id, revision: task.revision, status: "blocked" });
    expect(toastShow).toHaveBeenCalledWith("Moved to Blocked", { variant: "success" });
    tree.unmount(); tree = undefined;
    await act(async () => { tree = mount({ task: { ...task, archivedAt: "2026-10-14" }, compact: true }); });
    expect(tree.root.findByProps({ testID: "task-actions" }).findAllByType("Button").find((item: any) => item.props.label === "Status: Todo").props.disabled).toBe(true);
  });

  test("pending, archived and inactive selector callbacks cannot write; failed mutation stays inline without toast", async () => {
    updateTask.mockImplementation(() => new Promise(() => {}));
    await act(async () => { tree = mount(); });
    let selector = tree.root.findByType("SettingsSelect");
    await act(async () => { selector.props.onValueChange("done"); });
    expect(tree.root.findByProps({ testID: "task-actions" }).findByType("SettingsSelect").props.disabled).toBe(true);
    await act(async () => { selector.props.onValueChange("development"); });
    expect(updateTask).toHaveBeenCalledTimes(1);
    tree.unmount(); tree = undefined;

    await act(async () => { tree = mount({ task: { ...task, archivedAt: "2026-10-14" } }); });
    selector = tree.root.findByType("SettingsSelect");
    expect(selector.props.disabled).toBe(true);
    await act(async () => { selector.props.onValueChange("done"); });
    expect(updateTask).toHaveBeenCalledTimes(1);
    tree.unmount(); tree = undefined;

    await act(async () => { tree = mount({ project: { ...project, archivedAt: "2026-10-14" } }); });
    selector = tree.root.findByType("SettingsSelect");
    expect(selector.props.disabled).toBe(true);
    await act(async () => { selector.props.onValueChange("done"); });
    expect(updateTask).toHaveBeenCalledTimes(1);
    tree.unmount(); tree = undefined;

    await act(async () => { tree = mount({ active: false }); });
    selector = tree.root.findByType("SettingsSelect");
    expect(selector.props.disabled).toBe(true);
    expect(tree.root.findByType("Create").props).toMatchObject({ open: false, unavailable: true });
    await act(async () => { selector.props.onValueChange("done"); });
    expect(updateTask).toHaveBeenCalledTimes(1);
  });

  test("old selector callback is guarded once session preview makes details inactive; failed status reports inline", async () => {
    await act(async () => { tree = mount(); });
    const oldSelector = tree.root.findByType("SettingsSelect");
    const staleSelection = oldSelector.props.onValueChange;
    await act(async () => { byLabel("Preview Session drawer-session").props.onPress(); });
    await act(async () => { staleSelection("done"); });
    expect(updateTask).not.toHaveBeenCalled();
    await act(async () => { tree.root.findByType("Preview").props.onBack(); });
    updateTask.mockRejectedValueOnce(new Error("write rejected"));
    const current = tree.root.findByType("SettingsSelect");
    await act(async () => { current.props.onValueChange("done"); await Promise.resolve(); });
    expect(findText("write rejected").length).toBeGreaterThan(0);
    expect(toastShow).not.toHaveBeenCalled();
  });

  test("details disclosure is collapsed, measured JS height, accessible, reduced-motion capable, reversible and inert on exit", async () => {
    await act(async () => { tree = mount(); });
    const header = details();
    expect(header.props.accessibilityState.expanded).toBe(false);
    expect(header.props.style({ pressed: false }).minHeight).toBe(44);
    expect(tree.root.findAllByProps({ testID: "disclosure-body" })).toHaveLength(0);
    await act(async () => { details().props.onPress(); });
    const body = tree.root.findByProps({ testID: "disclosure-body" });
    expect(body.props.pointerEvents).toBe("auto");
    const content = body.findAllByType("View").find((n: any) => n.props.onLayout);
    await act(async () => { content.props.onLayout({ nativeEvent: { layout: { height: 360 } } }); });
    const motion = motionMockState;
    const openAnimation = motion.animations.at(-1);
    if (!openAnimation) throw new Error("disclosure opening animation was not created");
    expect(openAnimation.config.useNativeDriver).toBe(false);
    expect(body.props.style.height.config.outputRange).toEqual([0, 360]);
    expect(openAnimation.config.toValue).toBe(1);
    await act(async () => { header.props.onPress(); });
    const cancelledExit = motion.animations.at(-1);
    if (!cancelledExit) throw new Error("disclosure exit animation was not created");
    const exitBody = tree.root.findByProps({ testID: "disclosure-body" });
    expect(exitBody.props.pointerEvents).toBe("none");
    expect(exitBody.props.accessibilityElementsHidden).toBe(true);
    await act(async () => { details().props.onPress(); });
    expect(motion.animations.some((a: any) => a.stopped)).toBe(true);
    await act(async () => { cancelledExit.completion?.({ finished: true }); });
    expect(tree.root.findByProps({ testID: "disclosure-body" }).props.pointerEvents).toBe("auto");
    expect(details().props.accessibilityState.expanded).toBe(true);
    await act(async () => { details().props.onPress(); });
    const finalExit = motion.animations.at(-1);
    if (!finalExit) throw new Error("final disclosure exit animation was not created");
    await act(async () => { finalExit.completion?.({ finished: true }); });
    expect(tree.root.findAllByProps({ testID: "disclosure-body" })).toHaveLength(0);
    expect(motionDuration.forward).toBeGreaterThan(0);
  });

  test("metadata and disclosure state survive preview/back and polling updates; card remount resets collapsed", async () => {
    const legacyTask = { ...task, repoPaths: ["/legacy/repo", "/legacy/second"] };
    const legacyProject = { ...project, repoPaths: ["/other/root"] };
    await act(async () => { tree = mount({ task: legacyTask, project: legacyProject }); });
    await act(async () => { details().props.onPress(); });
    const body = tree.root.findByProps({ testID: "disclosure-body" });
    const content = body.findAllByType("View").find((n: any) => n.props.onLayout);
    await act(async () => { content.props.onLayout({ nativeEvent: { layout: { height: 420 } } }); });
    for (const text of ["high", "/root/project", "Workspace fixture", "drawer-workspace", "/tmp/drawer-fixture", "native-owner", "Legacy card scope is preserved. Its saved directories and workspace stay linked.", "/legacy/second-worktree"]) expect(findText(text).length, `missing metadata text: ${text}`).toBeGreaterThan(0);
    await act(async () => { byLabel("Preview Session drawer-session").props.onPress(); });
    await act(async () => { tree.root.findByType("Preview").props.onBack(); });
    expect(details().props.accessibilityState.expanded).toBe(true);
    await act(async () => { tree.update(element({ task: legacyTask, project: legacyProject })); });
    expect(details().props.accessibilityState.expanded).toBe(true);
    tree.unmount(); tree = undefined;
    await act(async () => { tree = mount({ task: { ...task, id: "new-card" }, project }); });
    expect(details().props.accessibilityState.expanded).toBe(false);
  });

  test("availability error remains outside collapsed metadata and Refresh details refetches only resource state", async () => {
    const workspaceRefetch = vi.fn(); const scopeRefetch = vi.fn();
    state.overrides["ultra|workspace|drawer-workspace"] = { data: undefined, error: new Error("workspace offline"), isPending: false, isError: true, refetch: workspaceRefetch };
    state.overrides["ultra|context|drawer-task|7|4"] = { data: undefined, isPending: false, isError: false, refetch: scopeRefetch };
    await act(async () => { tree = mount(); });
    expect(findText("workspace offline").length).toBeGreaterThan(0);
    expect(details().props.accessibilityState.expanded).toBe(false);
    const refreshButton = tree.root.findAllByType("Button").find((node: any) => node.children.join("") === "Refresh details");
    await act(async () => { refreshButton.props.onPress(); });
    expect(workspaceRefetch).toHaveBeenCalledTimes(1); expect(scopeRefetch).toHaveBeenCalledTimes(1);
    expect(updateTask).not.toHaveBeenCalled();
  });

  test("resize grip remains adjustable and bounded by effective width", async () => {
    const onChange = vi.fn();
    await act(async () => { tree = create(<ResizeGrip width={440} maxWidth={660} onChange={onChange} />); });
    const grip = tree.root.findByProps({ accessibilityRole: "adjustable" });
    expect(grip.props.accessibilityValue).toEqual({ min: 340, max: 660, now: 440 });
    await act(async () => { grip.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } }); });
    expect(onChange).toHaveBeenCalledWith(500);
  });
});

describe.skipIf(!rendererPath)("Disclosure motion contracts", () => {
  test("reduce motion immediately settles open and close without starting timing", async () => {
    process.env.MOTION_TEST_REDUCED = "true";
    const onChange = vi.fn();
    await act(async () => { tree = create(<MotionProvider><Disclosure title="Reduced details" open={false} onChange={onChange}>Body</Disclosure></MotionProvider>); });
    await act(async () => { tree.root.findByProps({ accessibilityLabel: "Reduced details" }).props.onPress(); });
    expect(motionMockState.animations).toHaveLength(0);
    tree.unmount(); tree = undefined; delete process.env.MOTION_TEST_REDUCED;
  });
});
