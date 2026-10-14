import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { motionMockState } from "../motion/rn-motion-mock";

vi.mock("react-native", async () => {
  const React = await import("react");
  const motion = await import("../motion/rn-motion-mock");
  const native: any = motion.createReactNativeMotionMock();
  native.View = React.forwardRef<any, any>((props, ref) => {
    React.useImperativeHandle(ref, () => ({ measureInWindow: (callback: Function) => callback(0, 0, 1000, 600) }));
    return React.createElement("View", props, props.children);
  });
  return { ...native, Pressable: "Pressable", Text: "Text", PanResponder: { create: (h: any) => ({ panHandlers: h }) } };
});
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const React = await import("react");
  const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return { ScrollView: React.forwardRef<any, any>(({ children, ...props }, _ref) => React.createElement("ScrollView", props, children)), Icon: host("Icon"), TextInput: host("TextInput") };
});
const rendererPath = process.env.DRAG_REORDER_RENDERER;
const renderer = rendererPath ? require(rendererPath) : null;
const { act, create } = renderer || { act: (fn: () => unknown) => fn(), create: () => undefined };
const { DesktopColumns } = await import("../../../../client/columns");
const { Theme } = await import("../../../../client/ui");

const colors = new Proxy({}, { get: () => "#808080" });
const task = (id: string, status: string, position: number): any => ({
  id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/f", repoPaths: [], title: `Task ${id}`, description: "",
  status, priority: "normal", position, revision: 5, operationId: id, createdAt: "2026-10-15", updatedAt: "2026-10-15", archivedAt: null,
});
const tasks = [task("a", "todo", 0), task("b", "todo", 1), task("c", "todo", 2), task("x", "done", 0)];

function mount(onDrop = vi.fn()) {
  let drag: any;
  let tree: any;
  act(() => {
    tree = create(
      <Theme.Provider value={{ colors } as any}>
        <DesktopColumns statuses={["todo", "done"]} tasks={tasks} disabled={false} cancelKey="k" onAdd={() => {}} onDrop={onDrop}
          renderCard={(t, callbacks) => { drag = callbacks; return React.createElement("Card", { id: t.id }); }} />
      </Theme.Provider>,
    );
  });
  const views = tree.root.findAll((n: any) => n.type === "View" && typeof n.props.onLayout === "function");
  act(() => views[0].props.onLayout({ nativeEvent: { layout: {} } }));
  tree.root.findAll((n: any) => n.type === "View" && n.props.style?.width === 280).forEach((column: any, i: number) =>
    act(() => column.props.onLayout({ nativeEvent: { layout: { x: 12 + i * 292, width: 280 } } })));
  for (const card of tree.root.findAllByType("Card")) {
    const index = ["a", "b", "c", "x"].indexOf(card.props.id) % 3;
    act(() => card.parent.props.onLayout({ nativeEvent: { layout: { y: index * 68, height: 60 } } }));
  }
  const line = (status: number) => tree.root.findAllByProps({ testID: "card-insert-line" }).filter((n: any) => n.type === "View")[status];
  const ghost = () => tree.root.findAllByType("Text").map((n: any) => [n.props.children].flat().join(""));
  return { tree, onDrop, line, ghost, drag: () => drag, find: (id: string) => tasks.find((t) => t.id === id) };
}

beforeEach(() => { motionMockState.reset(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => vi.clearAllMocks());

describe.skipIf(!rendererPath)("desktop drag reorder (synthetic renderer)", () => {
  test("same-column drop above the first midline shows the line and writes one anchored placement", () => {
    const m = mount();
    act(() => m.drag().start(m.find("c"), { x: 50, y: 170 }));
    act(() => m.drag().move({ x: 50, y: 10 }));
    expect(m.line(0).props.style.top).toBe(0);
    expect(m.line(0).props.style.opacity.current).toBe(1);
    expect(m.line(1).props.style.opacity.current).toBe(0);
    expect(m.ghost()).toContain("Reorder in Todo");
    act(() => m.drag().end({ x: 50, y: 10 }));
    expect(m.onDrop).toHaveBeenCalledTimes(1);
    expect(m.onDrop).toHaveBeenCalledWith({ id: "c", revision: 5, status: "todo", beforeId: "a", afterId: null });
    m.tree.unmount();
  });
  test("releasing in the current slot, outside the board or after cancel does not write", () => {
    const m = mount();
    act(() => m.drag().start(m.find("c"), { x: 50, y: 170 }));
    act(() => m.drag().move({ x: 50, y: 200 }));
    expect(m.ghost()).toContain("Drag to reorder or move");
    expect(m.line(0).props.style.opacity.current).toBe(0);
    act(() => m.drag().end({ x: 50, y: 200 }));
    act(() => m.drag().start(m.find("a"), { x: 50, y: 10 }));
    act(() => m.drag().end({ x: 50, y: 900 }));
    act(() => m.drag().start(m.find("a"), { x: 50, y: 10 }));
    act(() => m.drag().move({ x: 50, y: 200 }));
    act(() => m.drag().cancel());
    act(() => m.drag().end({ x: 50, y: 200 }));
    expect(m.onDrop).not.toHaveBeenCalled();
    m.tree.unmount();
  });
  test("cross-column drop targets the slot in the destination column", () => {
    const m = mount();
    act(() => m.drag().start(m.find("a"), { x: 50, y: 10 }));
    act(() => m.drag().move({ x: 400, y: 50 }));
    expect(m.ghost()).toContain("Move to Done");
    act(() => m.drag().end({ x: 400, y: 50 }));
    expect(m.onDrop).toHaveBeenCalledWith({ id: "a", revision: 5, status: "done", beforeId: null, afterId: "x" });
    m.tree.unmount();
  });
  test("column vertical scroll participates in slot hit testing", () => {
    const m = mount();
    const lists = m.tree.root.findAll((n: any) => n.type === "ScrollView" && n.props.nestedScrollEnabled);
    act(() => m.drag().start(m.find("a"), { x: 50, y: 10 }));
    act(() => lists[0].props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } }));
    act(() => m.drag().end({ x: 50, y: 60 }));
    expect(m.onDrop).toHaveBeenCalledWith({ id: "a", revision: 5, status: "todo", beforeId: null, afterId: "c" });
    m.tree.unmount();
  });
});
