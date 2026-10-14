import React from "react";
import { describe, expect, test, vi } from "vitest";
import type { Task } from "../../../../shared/model";

vi.mock("react-native", async () => ({
  ...(await import("../motion/rn-motion-mock")).createReactNativeMotionMock(),
  PanResponder: { create: (config: any) => ({ panHandlers: config }) },
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon" }));
vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: () => null }));
vi.mock("../../../../client/ui", () => ({
  Badge: "Badge",
  Dot: "Dot",
  IconButton: "IconButton",
  Label: ({ children, ...props }: any) => React.createElement("Label", props, children),
  font: { sm: 12, base: 14, md: 13 },
  radius: { lg: 10 },
  space: [0, 4, 8, 12, 16, 20, 24],
  tint: (c: string) => c,
  touch: false,
  relativeTime: (iso: string) => (iso ? "5m ago" : ""),
  useTheme: () => ({ colors: new Proxy({}, { get: (_t, k) => String(k) }) }),
}));
const hook = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../../../../client/card-output", () => ({
  useCardOutput: (session: unknown) => {
    hook.calls.push(session);
    return session ? { text: "Fixed the card layout", at: "2026-10-14T10:00:00Z" } : null;
  },
}));

const rendererPath = process.env.CARD_OUTPUT_RENDERER;
const renderer = rendererPath ? require(rendererPath) : null;
const { act, create } = renderer || { act: () => {}, create: () => undefined };
const { LiveTaskCard, TaskCard } = await import("../../../../client/card");
const task: Task = {
  id: "t1", projectId: "p1", workspaceId: "w1", sourcePath: "/fixture", repoPaths: ["/fixture"],
  title: "Card", description: "", status: "todo", priority: "normal", position: 0, revision: 1,
  operationId: "op", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", archivedAt: null,
};
const base = { task, selected: false, legacy: false, available: true, running: 0, sessions: 1, onOpen: vi.fn(), onActions: vi.fn() };
const labels = (tree: any) => tree.root.findAllByType("Label").map((l: any) => l.props);
const text = (props: any) => [props.children].flat().join("");

describe.skipIf(!rendererPath)("card latest output (synthetic renderer)", () => {
  test("shows one non-selectable truncated line, time and accessible summary", () => {
    let tree: any;
    act(() => { tree = create(<TaskCard {...base} output={{ text: "Fixed the card layout", at: "2026-10-14T10:00:00Z" }} />); });
    const line = labels(tree).find((p: any) => text(p) === "Fixed the card layout");
    expect(line).toMatchObject({ lines: 1, selectable: false, muted: true });
    expect(labels(tree).find((p: any) => text(p) === "5m ago")).toMatchObject({ selectable: false });
    expect(labels(tree).every((p: any) => p.selectable === false)).toBe(true);
    const button = tree.root.findByType("Pressable");
    expect(button.props.accessibilityLabel).toBe("Open task Card. Normal priority. Latest agent output 5m ago: Fixed the card layout.");
  });

  test("renders nothing extra without output and keeps press/drag handlers", () => {
    const drag = { start: vi.fn(), move: vi.fn(), end: vi.fn(), cancel: vi.fn() };
    let tree: any;
    act(() => { tree = create(<TaskCard {...base} output={null} drag={drag} />); });
    expect(labels(tree).map(text)).toEqual(["Card", "1"]);
    expect(tree.root.findByType("Pressable").props.accessibilityLabel).toBe("Open task Card. Normal priority.");
    const root = tree.root.findAllByType("View")[0];
    expect(root.props.onMoveShouldSetPanResponderCapture).toBeTypeOf("function");
    act(() => tree.root.findByType("Pressable").props.onPress());
    expect(base.onOpen).toHaveBeenCalledTimes(1);
  });

  test("live card fetches only for an available workspace", () => {
    hook.calls.length = 0;
    const session = { id: "a1", updatedAt: "2026-10-14T10:00:00Z" };
    act(() => { create(<LiveTaskCard {...base} outputSession={session} />); });
    act(() => { create(<LiveTaskCard {...base} available={false} outputSession={session} />); });
    expect(hook.calls).toEqual([session, null]);
  });
});
