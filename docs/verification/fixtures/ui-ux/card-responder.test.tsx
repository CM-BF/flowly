import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Task } from "../../../../shared/model";

vi.mock("react-native", async () => ({
  ...(await import("../motion/rn-motion-mock")).createReactNativeMotionMock(),
  PanResponder: {
    create: (config: Record<string, (...args: any[]) => any>) => {
      (globalThis as any).__uiuxPanConfigs.push(config);
      return { panHandlers: config };
    },
  },
  Pressable: "Pressable",
  Text: "Text",
  View: React.forwardRef((props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({ measureInWindow: (cb: (x: number, y: number, width: number, height: number) => void) => cb(100, 100, 600, 500) }));
    return React.createElement("View", props);
  }),
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon", ScrollView: "ScrollView" }));
vi.mock("../../../../client/ui", () => ({
  Button: ({ children, onPress }: any) => React.createElement("Button", { onPress }, children),
  Label: ({ children, selectable, ...props }: any) => React.createElement("Label", { selectable, ...props }, children),
  useTheme: () => ({ colors: { accent: "a", border: "b", surface0: "s", foregroundMuted: "m", foreground: "f" } }),
  Badge: "Badge",
  Dot: "Dot",
  IconButton: ({ onPress, label }: any) => React.createElement("Button", { onPress, label }),
  verticalScroll: {},
  verticalContent: {},
  font: { sm: 12, base: 14, md: 13 },
  radius: { lg: 10 },
  space: [0, 4, 8, 12, 16, 20, 24],
  tint: (c: string) => c,
  touch: false,
  relativeTime: (iso: string) => (iso ? "now" : ""),
}));

const rendererPath = process.env.UIUX_TEST_RENDERER;
const renderer = rendererPath ? require(rendererPath) : null;
const { act, create } = renderer || { act: () => {}, create: () => undefined };
const { TaskCard } = await import("../../../../client/card");
const { DesktopColumns } = await import("../../../../client/columns");
const { ResizeGrip } = await import("../../../../client/resize");
const cardTask = (id: string, title: string): Task => ({
  id, projectId: "p1", workspaceId: "w1", sourcePath: "/fixture", repoPaths: ["/fixture"],
  title, description: "", status: "todo", priority: "normal", position: 0, revision: 1,
  operationId: `op-${id}`, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", archivedAt: null,
});
const dragCallbacks = () => ({ start: vi.fn(), move: vi.fn(), end: vi.fn(), cancel: vi.fn() });

describe.skipIf(!rendererPath)("TaskCard whole-card pointer responder (synthetic renderer)", () => {
  afterEach(() => {
    (globalThis as any).__uiuxPanConfigs = [];
    vi.useRealTimers();
  });

  test("root arms only primary mouse; touch, pen, right button, and Actions cannot capture", () => {
    (globalThis as any).__uiuxPanConfigs = [];
    const drag = dragCallbacks();
    let tree: any;
    act(() => { tree = create(<TaskCard task={cardTask("t1", "Task")} selected={false} legacy={false} available sessions={0} running={0} drag={drag} onOpen={() => {}} onActions={() => {}} />); });
    const root = tree.root.findAllByType("View")[0];
    expect(root.props.onStartShouldSetPanResponderCapture).toBeUndefined();
    expect(root.props.onPointerDown).toBeTypeOf("function");
    const capture = root.props.onMoveShouldSetPanResponderCapture;
    const event = (pointerType: string, button = 0) => ({ nativeEvent: { pointerType, button } });
    for (const pointer of [event("touch"), event("pen"), event("mouse", 2)]) {
      act(() => root.props.onPointerDown(pointer));
      expect(capture({}, { dx: 9, dy: 0 })).toBe(false);
    }
    act(() => root.props.onPointerDown(event("mouse", 0)));
    expect(capture({}, { dx: 7.99, dy: 0 })).toBe(false);
    expect(capture({}, { dx: 8, dy: 0 })).toBe(true);

    const actionWrapper = tree.root.findAllByType("View").find((node: any) => node !== root && node.props.onPointerDown && node.findAllByType("Button").length > 0);
    const stopPropagation = vi.fn();
    act(() => actionWrapper.props.onPointerDown({ nativeEvent: { pointerType: "mouse", button: 0 }, stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(capture({}, { dx: 9, dy: 0 })).toBe(false);
    tree.unmount();
  });

  test("body click opens, a drag suppresses its click, and release ends once", () => {
    (globalThis as any).__uiuxPanConfigs = [];
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const drag = dragCallbacks();
    const onOpen = vi.fn();
    let tree: any;
    act(() => { tree = create(<TaskCard task={cardTask("t2", "Task")} selected={false} legacy={false} available sessions={0} running={0} drag={drag} onOpen={onOpen} onActions={() => {}} />); });
    const root = tree.root.findAllByType("View")[0];
    const body = tree.root.findByType("Pressable");
    act(() => body.props.onPress());
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => root.props.onPointerDown({ nativeEvent: { pointerType: "mouse", button: 0 } }));
    expect(root.props.onMoveShouldSetPanResponderCapture({}, { dx: 8, dy: 0 })).toBe(true);
    act(() => root.props.onPanResponderGrant({ nativeEvent: { pageX: 100, pageY: 80 } }));
    act(() => root.props.onPanResponderMove({}, { moveX: 140, moveY: 90 }));
    act(() => root.props.onPanResponderRelease({ nativeEvent: { pageX: 140, pageY: 90 } }));
    act(() => body.props.onPress());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(drag.start).toHaveBeenCalledTimes(1);
    expect(drag.move).toHaveBeenCalledTimes(1);
    expect(drag.end).toHaveBeenCalledTimes(1);
    expect(drag.cancel).not.toHaveBeenCalled();
    tree.unmount();
  });

  test("pointer cancel and responder termination cancel at most once; disabled card cannot capture", () => {
    (globalThis as any).__uiuxPanConfigs = [];
    const drag = dragCallbacks();
    let tree: any;
    act(() => { tree = create(<TaskCard task={cardTask("t3", "Task")} selected={false} legacy={false} available sessions={0} running={0} drag={drag} onOpen={() => {}} onActions={() => {}} />); });
    let root = tree.root.findAllByType("View")[0];
    act(() => root.props.onPointerDown({ nativeEvent: { pointerType: "mouse", button: 0 } }));
    act(() => root.props.onPanResponderGrant({ nativeEvent: { pageX: 100, pageY: 80 } }));
    act(() => root.props.onPointerCancel());
    act(() => root.props.onPanResponderTerminate());
    expect(drag.cancel).toHaveBeenCalledTimes(1);
    tree.unmount();

    const disabledDrag = dragCallbacks();
    act(() => { tree = create(<TaskCard task={cardTask("t4", "Disabled")} selected={false} legacy={false} available sessions={0} running={0} drag={disabledDrag} disabled onOpen={() => {}} onActions={() => {}} />); });
    root = tree.root.findAllByType("View")[0];
    expect(root.props.onMoveShouldSetPanResponderCapture).toBeUndefined();
    expect(root.props.onPointerDown).toBeTypeOf("function");
    act(() => root.props.onPointerDown({ nativeEvent: { pointerType: "mouse", button: 0 } }));
    expect(root.props.onMoveShouldSetPanResponderCapture).toBeUndefined();
    expect(disabledDrag.start).not.toHaveBeenCalled();
    tree.unmount();

    (globalThis as any).__uiuxPanConfigs = [];
    act(() => { tree = create(<TaskCard task={cardTask("t5", "Terminate")} selected={false} legacy={false} available sessions={0} running={0} drag={drag} onOpen={() => {}} onActions={() => {}} />); });
    root = tree.root.findAllByType("View")[0];
    act(() => root.props.onPointerDown({ nativeEvent: { pointerType: "mouse", button: 0 } }));
    act(() => root.props.onPanResponderGrant({ nativeEvent: { pageX: 100, pageY: 80 } }));
    act(() => root.props.onPanResponderTerminate());
    expect(drag.cancel).toHaveBeenCalledTimes(2);
    tree.unmount();
  });

  test("all card Labels opt out of selection", () => {
    (globalThis as any).__uiuxPanConfigs = [];
    let tree: any;
    act(() => { tree = create(<TaskCard task={cardTask("t6", "Text")} selected={false} legacy={false} available sessions={1} running={0} output={{ text: "Latest output", at: "2026-10-14T00:00:00Z" }} drag={dragCallbacks()} onOpen={() => {}} onActions={() => {}} />); });
    const labels = tree.root.findAllByType("Label");
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(labels.every((label: any) => label.props.selectable === false)).toBe(true);
    tree.unmount();
  });

  test("actual Label forwards selectable=false and sets userSelect:none", async () => {
    const actualUI = await vi.importActual<typeof import("../../../../client/ui")>("../../../../client/ui");
    const { Theme } = actualUI;
    let tree: any;
    act(() => { tree = create(React.createElement(Theme.Provider, { value: { colors: { foreground: "f", foregroundMuted: "m" } } as any }, React.createElement(actualUI.Label, { selectable: false, children: "No selection" }))); });
    const text = tree.root.findByType("Text");
    expect(text.props.selectable).toBe(false);
    expect(text.props.style.userSelect).toBe("none");
    tree.unmount();
  });

  test("a valid cross-column end writes once with captured revision; pending disables drag", () => {
    const task = { ...cardTask("t7", "Move me"), revision: 9 };
    const onDrop = vi.fn();
    const render = (disabled: boolean) => <DesktopColumns statuses={["todo", "in_progress"]} tasks={[task]} disabled={disabled} cancelKey="project|filter" onAdd={() => {}} onDrop={onDrop} renderCard={(t, drag) => <TaskCard task={t} selected={false} legacy={false} available sessions={0} running={0} drag={drag} disabled={disabled} onOpen={() => {}} onActions={() => {}} />} />;
    let tree: any;
    act(() => { tree = create(render(false)); });
    const views = tree.root.findAllByType("View");
    act(() => views[0].props.onLayout?.());
    const columns = tree.root.findAll((node: any) => node.type === "View" && node.props.style?.width === 280);
    expect(columns).toHaveLength(2);
    act(() => columns[0].props.onLayout({ nativeEvent: { layout: { x: 12, width: 280 } } }));
    act(() => columns[1].props.onLayout({ nativeEvent: { layout: { x: 304, width: 280 } } }));
    const root = tree.root.findAllByType("View").find((node: any) => node.props.onPointerDown);
    act(() => root.props.onPointerDown({ nativeEvent: { pointerType: "mouse", button: 0 } }));
    act(() => root.props.onPanResponderGrant({ nativeEvent: { pageX: 120, pageY: 120 } }));
    act(() => root.props.onPanResponderRelease({ nativeEvent: { pageX: 420, pageY: 120 } }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith({ id: "t7", revision: 9, status: "in_progress", beforeId: null, afterId: null });
    tree.unmount();

    onDrop.mockClear();
    act(() => { tree = create(render(true)); });
    const pendingRoot = tree.root.findAllByType("View").find((node: any) => node.props.accessibilityLabel === undefined && node.props.onPointerDown);
    expect(pendingRoot.props.onMoveShouldSetPanResponderCapture).toBeUndefined();
    expect(onDrop).not.toHaveBeenCalled();
    tree.unmount();
  });

  test("resize grip responds from its captured starting width", () => {
    (globalThis as any).__uiuxPanConfigs = [];
    const onChange = vi.fn();
    let tree: any;
    act(() => { tree = create(<ResizeGrip width={440} onChange={onChange} />); });
    const grip = tree.root.findAllByType("View")[0];
    expect(grip.props.onStartShouldSetPanResponder()).toBe(true);
    act(() => grip.props.onPanResponderGrant());
    act(() => grip.props.onPanResponderMove({}, { dx: 60 }));
    act(() => grip.props.onPanResponderMove({}, { dx: -60 }));
    expect(onChange.mock.calls).toEqual([[380], [500]]);
    tree.unmount();
  });
});

describe("card text selection source contract", () => {
  test("the host Label maps selectable=false to Text selectable and userSelect none", () => {
    const source = readFileSync(resolve(process.cwd(), "client/ui.tsx"), "utf8");
    expect(source).toMatch(/selectable=\{selectable\}/);
    expect(source).toMatch(/userSelect:\s*selectable\s*===\s*false\s*\?\s*"none"/);
  });
});
