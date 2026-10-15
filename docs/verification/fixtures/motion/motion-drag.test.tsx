import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { motionMockState } from "./rn-motion-mock";

vi.mock("react-native", async () => {
  const React = await import("react");
  const motion = await import("./rn-motion-mock");
  const native: any = motion.createReactNativeMotionMock();
  native.View = React.forwardRef<any, any>((props, ref) => {
    React.useImperativeHandle(ref, () => ({ measureInWindow: (callback: Function) => callback(100, 100, 600, 500) }));
    return React.createElement("View", { ...props, ref }, props.children);
  });
  return { ...native, Pressable: "Pressable", Text: "Text", PanResponder: { create: (handlers: any) => ({ panHandlers: handlers }) } };
});
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const React = await import("react");
  const host = ({ children, ...props }: any) => React.createElement("ScrollView", props, children);
  return { ScrollView: host, Icon: "Icon" };
});
vi.mock("../../../../client/ui", async () => {
  const React = await import("react");
  const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return { Button: host("Button"), Label: host("Label"), useTheme: () => ({ colors: { accent: "accent", border: "border", surface0: "surface0", surface1: "surface1", foreground: "fg", foregroundMuted: "muted" } }) };
});
const rendererPath = process.env.MOTION_TEST_RENDERER;
const renderer = rendererPath ? require(rendererPath) : null;
const { act, create } = renderer || { act: (fn: () => unknown) => fn(), create: () => undefined };
const { DesktopColumns } = await import("../../../../client/columns");
const { TaskCard } = await import("../../../../client/card");
const task: any = { id: "drag-task", projectId: "p", workspaceId: "w", sourcePath: "/fixture", repoPaths: ["/fixture"], title: "Drag target", description: "", status: "todo", priority: "normal", position: 0, revision: 8, operationId: "op", createdAt: "2026-10-14", updatedAt: "2026-10-14", archivedAt: null };

beforeEach(() => { motionMockState.reset(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => vi.clearAllMocks());

describe.skipIf(!rendererPath)("drag motion and lane selection (synthetic renderer)", () => {
  test("lane labels are unselectable and ghost follows exact pointer coordinates without easing", () => {
    const drop = vi.fn();
    let drag: any;
    let tree: any;
    act(() => { tree = create(<DesktopColumns statuses={["todo", "development"]} tasks={[task]} disabled={false} cancelKey="fixture" onAdd={() => {}} onDrop={drop} renderCard={(item, callbacks) => { drag = callbacks; return <TaskCard task={item} selected={false} legacy={false} available sessions={0} running={0} drag={callbacks} onOpen={() => {}} onActions={() => {}} />; }} />); });
    const laneLabels = tree.root.findAllByType("Label").filter((label: any) => String(label.props.children).includes("To do") || String(label.props.children).includes("In progress"));
    expect(laneLabels.length).toBeGreaterThan(0);
    expect(laneLabels.every((label: any) => label.props.selectable === false)).toBe(true);

    act(() => tree.root.findAllByType("View")[0].props.onLayout());
    act(() => drag.start(task, { x: 120, y: 120 }));
    act(() => drag.move({ x: 450, y: 180 }));
    const ghost = tree.root.findByProps({ testID: "card-drag-motion" });
    expect(ghost.props.pointerEvents).toBe("none");
    expect(ghost.props.style.left).toBe(362);
    expect(ghost.props.style.top).toBe(92);
    expect(motionMockState.animations.some((animation) => animation.config.duration === 120)).toBe(false);

    act(() => drag.cancel());
    expect(drop).not.toHaveBeenCalled();
    tree.unmount();
  });
});
