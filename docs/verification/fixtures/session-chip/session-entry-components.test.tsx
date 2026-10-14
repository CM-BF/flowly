import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  agents: [] as any[],
  paseo: {} as any,
  rpc: {} as Record<string, any>,
  reads: { query: { data: {}, refetch: vi.fn() }, receipts: [] as any[] },
}));

vi.mock("react-native", async () => ({ ...(await import("../motion/rn-motion-mock")).createReactNativeMotionMock(), View: "View", Pressable: "Pressable", Text: "Text", Platform: { OS: "web" } }));
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const React = await import("react");
  const motion = await import("../motion/rn-motion-mock");
  const ScrollView = ({ children, ...props }: any) => React.createElement("ScrollView", props, children);
  const Modal = Object.assign(
    ({ children, open, ...props }: any) => React.createElement("Modal", { ...props, open }, open ? children : null),
    { Content: ({ children }: any) => React.createElement("ModalContent", null, children) },
  );
  return { ...motion.createHostToastMock(), Modal, ScrollView, Icon: "Icon" };
});
vi.mock("@getpaseo/plugin/client/ui", async () => {
  const React = await import("react");
  return { SettingsSelect: (props: any) => React.createElement("SettingsSelect", props) };
});
vi.mock("@getpaseo/plugin/client", () => ({
  usePaseo: () => fixture.paseo,
  useRpc: (key: string) => fixture.rpc[key],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => {
    const key = options.queryKey as unknown[];
    if (key[1] === "workspace") return { data: { name: "Workspace", workspaceDirectory: "/fixture", status: "active" }, refetch: vi.fn() };
    if (key[1] === "context") return { data: { available: true, context: "synthetic", directories: [], workspaceRepoPaths: ["/fixture"], owner: "fixture" }, refetch: vi.fn() };
    if (key[1] === "sessions") return { data: fixture.agents, refetch: vi.fn(), error: null };
    return { data: undefined, refetch: vi.fn() };
  },
}));
vi.mock("../../../../shared/rpc", () => ({ updateTask: "updateTask", taskContext: "taskContext" }));
vi.mock("../../../../client/resources", () => ({ listAgents: async () => fixture.agents }));
vi.mock("../../../../client/session-reads", () => ({ useSessionReads: () => fixture.reads }));
vi.mock("../../../../client/session-card", async () => {
  const React = await import("react");
  return { SessionCard: ({ agent, onPress }: any) => React.createElement("Pressable", { accessibilityLabel: `Preview Session ${agent.id}`, onPress }) };
});
vi.mock("../../../../client/session-preview", async () => {
  const React = await import("react");
  return { SessionPreview: (props: any) => React.createElement("Preview", props) };
});
vi.mock("../../../../client/session-create", () => ({ SessionCreate: () => null }));
vi.mock("../../../../client/ui", async () => {
  const React = await import("react");
  const primitive = (type: string) => ({ children, ...props }: any) => React.createElement(type, props, children);
  return {
    Button: primitive("Button"), Label: primitive("Label"), Choices: primitive("Choices"),
    Notice: primitive("Notice"), Theme: { Provider: ({ children }: any) => children }, useTheme: () => ({ colors: { border: "border", surface0: "surface0" } }),
    message: (error: any) => String(error?.message ?? error), basename: (path: string) => path.split("/").at(-1),
  };
});

const rendererPath = process.env.SESSION_CHIP_RENDERER;
const renderer = rendererPath ? require(rendererPath) : null;
const { act, create } = renderer || { act: (_fn: () => unknown) => {}, create: () => undefined };
const { TaskDrawer } = await import("../../../../client/drawer");

const task: any = { id: "task-x", projectId: "project-x", workspaceId: "workspace-x", sourcePath: "/fixture", repoPaths: ["/fixture"], title: "Synthetic task", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "op", createdAt: "2026-10-14", updatedAt: "2026-10-14", archivedAt: null };
const project: any = { id: task.projectId, title: "Project", primaryPath: "/fixture", revision: 1 };
const agent = (id: string) => ({ id, title: id, workspaceId: task.workspaceId, status: "idle", createdAt: "2026-10-14", updatedAt: "2026-10-14", pendingPermissions: [] });
const entry = (sessionId: string, requestId: string) => ({ sessionId, requestId });
const events: any[] = [];
const navigation: any = {};

beforeEach(() => {
  fixture.agents = [agent("session-a"), agent("session-b")];
  fixture.paseo = { workspaces: { ref: () => ({ refresh: async () => ({ name: "Workspace", workspaceDirectory: "/fixture", status: "active" }) }) } };
  fixture.rpc = { updateTask: vi.fn(async () => undefined), taskContext: vi.fn(async () => ({ available: true, context: "synthetic", directories: [], workspaceRepoPaths: ["/fixture"], owner: "fixture" })) };
  fixture.reads = { query: { data: {}, refetch: vi.fn() }, receipts: [] };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => vi.clearAllMocks());

describe.skipIf(!rendererPath)("TaskDrawer session entry identity", () => {
  test("same requestId with a different session consumes and previews the new exact session", async () => {
    const consumed = vi.fn();
    const callbacks = { onClose: vi.fn(), onEdit: vi.fn(), refresh: vi.fn() };
    let tree: any;
    await act(async () => {
      tree = create(<TaskDrawer task={task} project={project} events={events} compact={false} hostId="synthetic-host" navigation={navigation} {...callbacks} sessionEntry={entry("session-a", "same-nonce")} onSessionEntryConsumed={consumed} />);
    });
    expect(tree.root.findByType("Preview").props.sessionId).toBe("session-a");
    expect(consumed).toHaveBeenCalledWith("same-nonce");

    await act(async () => {
      tree.update(<TaskDrawer task={task} project={project} events={events} compact={false} hostId="synthetic-host" navigation={navigation} {...callbacks} sessionEntry={entry("session-b", "same-nonce")} onSessionEntryConsumed={consumed} />);
    });
    expect(tree.root.findByType("Preview").props.sessionId).toBe("session-b");
    expect(consumed.mock.calls).toEqual([["same-nonce"], ["same-nonce"]]);

    await act(async () => { tree.root.findByType("Preview").props.onBack(); });
    expect(tree.root.findAllByType("Preview")).toHaveLength(0);
    expect(tree.root.findAllByType("Pressable").some((node: any) => node.props.accessibilityLabel === "Preview Session session-a")).toBe(true);
    await act(async () => {
      tree.update(<TaskDrawer task={task} project={project} events={events} compact={false} hostId="synthetic-host" navigation={navigation} {...callbacks} onSessionEntryConsumed={consumed} />);
    });
    expect(tree.root.findAllByType("Preview")).toHaveLength(0);
    expect(callbacks.onClose).not.toHaveBeenCalled();
    tree.unmount();
  });
});
