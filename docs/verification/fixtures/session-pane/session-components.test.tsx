import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  agents: [] as any[],
  actors: {} as Record<string, any>,
  queryOverrides: {} as Record<string, any>,
  queryOptions: [] as any[],
  subscriptions: [] as Array<{ unsubscribe: ReturnType<typeof vi.fn> }>,
  paseo: undefined as any,
  rpc: {} as Record<string, any>,
  createPrepared: undefined as any,
  sendInstruction: undefined as any,
  workspaceSession: undefined as any,
}));

vi.mock("react-native", async () => ({
  ...(await import("../motion/rn-motion-mock")).createReactNativeMotionMock(),
  View: "View", Pressable: "Pressable", Text: "Text",
  KeyboardAvoidingView: "KeyboardAvoidingView", ActivityIndicator: "ActivityIndicator",
  Platform: { OS: "web" }, Linking: { openURL: vi.fn(async () => undefined) },
}));
vi.mock("@getpaseo/plugin/client/react-native", async () => {
  const React = await import("react");
  const motion = await import("../motion/rn-motion-mock");
  const Modal: any = ({ children, ...props }: any) =>
    React.createElement("Modal", props, children);
  Modal.Content = ({ children, ...props }: any) =>
    React.createElement("ModalContent", props, children);
  return { ...motion.createHostToastMock(), Icon: "Icon", ScrollView: "ScrollView", TextInput: "TextInput", Modal };
});
vi.mock("@getpaseo/plugin/client/ui", async () => {
  const React = await import("react");
  return { SettingsSelect: (props: any) => React.createElement("SettingsSelect", props) };
});
vi.mock("@getpaseo/plugin/client", () => ({
  usePaseo: () => state.paseo,
  useRpc: (key: string) => state.rpc[key],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => {
    state.queryOptions.push(options);
    const key = options.queryKey as unknown[];
    const override = state.queryOverrides[key.join("|")];
    if (override) return override;
    switch (key[1]) {
      case "workspace":
        return { data: { name: "Fixture workspace", workspaceDirectory: "/fixture", status: "active" }, isSuccess: true, isPending: false, isError: false, refetch: vi.fn() };
      case "context":
        return { data: { available: true, context: "fixture context", directories: [], workspaceRepoPaths: ["/fixture"], owner: "fixture" }, isSuccess: true, isPending: false, isError: false, refetch: vi.fn() };
      case "sessions":
        return { data: state.agents, isSuccess: true, isPending: false, isError: false, refetch: vi.fn() };
      case "agent":
        return { data: { agent: state.actors[String(key[2])] ?? null }, isSuccess: true, isPending: false, isError: false, refetch: vi.fn() };
      case "timeline":
        return { data: { entries: [] }, isSuccess: true, isPending: false, isError: false, refetch: vi.fn() };
      case "providers":
        return { data: { providers: [{ provider: "codex", available: true }] }, isSuccess: true, isPending: false, isError: false };
      case "models":
        return { data: { models: [{ id: "gpt-6-luna", label: "GPT-6 Luna", isDefault: true, isSelectable: true }] }, isSuccess: true, isPending: false, isError: false };
      case "modes":
        return { data: { modes: [] }, isSuccess: true, isPending: false, isError: false };
      case "tools":
        return { data: { ready: true }, isSuccess: true, isPending: false, isError: false };
      case "access":
        return { data: { methods: [], ready: true }, isSuccess: true, isPending: false, isError: false, refetch: vi.fn() };
      default:
        return { data: undefined, isSuccess: true, isPending: false, isError: false, refetch: vi.fn() };
    }
  },
}));
vi.mock("../../../../shared/rpc", () => ({
  taskContext: "taskContext",
  prepareSession: "prepareSession",
  toolsHealth: "toolsHealth",
  prepareExisting: "prepareExisting",
  accessState: "accessState",
  updateTask: "updateTask",
  readSessionReceipts: "readSessionReceipts",
  markSessionRead: "markSessionRead",
}));
vi.mock("../../../../client/session", () => ({
  createPreparedSession: (...args: any[]) => state.createPrepared(...args),
  sendCardInstruction: (...args: any[]) => state.sendInstruction(...args),
  workspaceSession: (...args: any[]) => state.workspaceSession(...args),
}));
vi.mock("../../../../client/ui", async () => {
  const React = await import("react");
  const passthrough = (type: string) => ({ children, ...props }: any) =>
    React.createElement(type, props, children);
  return {
    Button: passthrough("Button"),
    Field: passthrough("Field"),
    Choices: passthrough("Choices"),
    Label: passthrough("Label"),
    Notice: passthrough("Notice"),
    Theme: { Provider: ({ children }: any) => children },
    useTheme: () => ({ colors: { accent: "accent", border: "border", surface0: "surface", surface1: "surface1", foregroundMuted: "muted", foreground: "fg" } }),
    message: (error: any) => String(error?.message ?? error),
    basename: (path: string) => path.split("/").at(-1),
  };
});

const rendererPath = process.env.UIUX_TEST_RENDERER;
const renderer = rendererPath ? require(rendererPath) : null;
const { act, create } = renderer || { act: (_fn: () => unknown) => {}, create: () => undefined };
const { TaskDrawer } = await import("../../../../client/drawer");
const { SessionCreate } = await import("../../../../client/session-create");
const { SessionPreview } = await import("../../../../client/session-preview");
const { SessionCard } = await import("../../../../client/session-card");

const task: any = {
  id: "task-1", projectId: "project-1", workspaceId: "workspace-1", sourcePath: "/fixture", repoPaths: ["/fixture"],
  title: "Fixture task", description: "", status: "todo", priority: "normal", position: 0, revision: 1,
  operationId: "fixture-op", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", archivedAt: null,
};
const project: any = { id: "project-1", nativeProjectId: "native-project", title: "Fixture", primaryPath: "/fixture", revision: 1 };
const actor = (id: string, createdAt: string, extra: any = {}) => ({
  id, title: `Session ${id}`, workspaceId: task.workspaceId, createdAt, updatedAt: createdAt,
  status: "idle", provider: "codex", model: "gpt-6-luna", pendingPermissions: [], lastUserMessageAt: null,
  archivedAt: null, ...extra,
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };
function strings(node: any): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(strings);
  if (!node) return [];
  return strings(node.children ?? node.props?.children);
}
function button(tree: any, label: string) {
  return tree.root.findAllByType("Button").find((item: any) => strings(item).join(" ").includes(label));
}
function field(tree: any, title: string) {
  const legacy = tree.root.findAllByType("Field").find((item: any) => item.props.title === title);
  if (legacy) return legacy;
  const input = tree.root.findAllByType("TextInput").find((item: any) => item.props.accessibilityLabel === title);
  return input ? { props: { ...input.props, onChange: input.props.onChangeText } } : undefined;
}
const emptyEvents: any[] = [];
const navigation = { openAgent: vi.fn(), openWorkspace: vi.fn() };

function resetState() {
  state.agents = [actor("agent-old", "2026-10-13T00:00:00Z"), actor("agent-new", "2026-10-14T00:00:00Z")];
  state.actors = Object.fromEntries(state.agents.map((item) => [item.id, item]));
  state.queryOverrides = {};
  state.queryOptions = [];
  state.subscriptions = [];
  const refresh = (id: string) => vi.fn(async () => ({ agent: state.actors[id] ?? null }));
  state.paseo = {
    providers: {
      listAvailable: vi.fn(async () => ({ providers: [{ provider: "codex", available: true }] })),
      listModels: vi.fn(async () => ({ models: [{ id: "gpt-6-luna", label: "GPT-6 Luna", isDefault: true }] })),
      listModes: vi.fn(async () => ({ modes: [] })),
    },
    agents: {
      ref: (id: string) => ({
        refresh: refresh(id),
        send: vi.fn(async () => undefined),
        timeline: {
          refetch: vi.fn(async () => ({ entries: [] })),
          subscribe: vi.fn(() => {
            const unsubscribe = vi.fn();
            const stop: any = () => unsubscribe();
            stop.ready = Promise.resolve();
            state.subscriptions.push({ unsubscribe });
            return stop;
          }),
        },
      }),
    },
    workspaces: { ref: () => ({ refresh: vi.fn(async () => ({ name: "Fixture workspace", workspaceDirectory: "/fixture", status: "active" })), agents: { create: vi.fn(async () => ({ id: "created-agent" })) } }) },
  };
  state.rpc = {
    taskContext: vi.fn(async () => ({ available: true, context: "fixture task context", reason: "" })),
    prepareSession: vi.fn(async () => ({ agentId: "prepared-agent", instructions: "prepared", mcp: {}, contextFile: "/ctx", cliPath: "/cli", skillPath: "/skill" })),
    toolsHealth: vi.fn(async () => ({ ready: true })),
    prepareExisting: vi.fn(async () => ({ instructions: "instructions" })),
    accessState: vi.fn(async () => ({ methods: [], ready: true })),
    updateTask: vi.fn(async () => ({})),
  };
  state.createPrepared = vi.fn(async () => ({ id: "prepared-agent", recovered: false }));
  state.sendInstruction = vi.fn(async () => undefined);
  state.workspaceSession = vi.fn(async (_paseo: any, id: string) => state.actors[id]);
}

beforeEach(() => {
  resetState();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  navigation.openAgent.mockClear();
  navigation.openWorkspace.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe.skipIf(!rendererPath)("session pane components (temporary React renderer)", () => {
  test("SessionCard selects its actor and TaskDrawer sorts newest first, opens native exact actor/host, and Back restores overview", async () => {
    const selected = vi.fn();
    let cardTree: any;
    await act(async () => { cardTree = create(<SessionCard agent={actor("card-actor", "2026-10-14T00:00:00Z", { providerUnavailable: true })} events={emptyEvents} onPress={selected} />); });
    expect(strings(cardTree.root.findAllByType("Label")).join(" ")).toContain("Provider unavailable");
    const pressable = cardTree.root.findByType("Pressable");
    act(() => pressable.props.onPress());
    expect(selected).toHaveBeenCalledTimes(1);
    cardTree.unmount();

    let tree: any;
    await act(async () => { tree = create(<TaskDrawer task={task} project={project} events={emptyEvents} compact={false} hostId="host-exact" navigation={navigation} onClose={() => {}} onEdit={() => {}} refresh={() => {}} />); await flush(); });
    let cards = tree.root.findAllByType("Pressable").filter((item: any) => String(item.props.accessibilityLabel || "").startsWith("Preview "));
    expect(cards.map((item: any) => item.props.accessibilityLabel)).toEqual(["Preview Session agent-new: Ready", "Preview Session agent-old: Ready"]);
    await act(async () => { cards[0].props.onPress(); await flush(); });
    expect(tree.root.findAllByType("SessionCard")).toHaveLength(0);
    await act(async () => { button(tree, "Open in Paseo").props.onPress(); await flush(); });
    expect(navigation.openAgent).toHaveBeenCalledWith({ agentId: "agent-new", serverId: "host-exact" });
    await act(async () => { button(tree, "Back to task").props.onPress(); await flush(); });
    expect(tree.root.findAllByType("Pressable").filter((item: any) => String(item.props.accessibilityLabel || "").startsWith("Preview "))).toHaveLength(2);
    tree.unmount();
  });

  test("Creation modal starts with settings collapsed, surfaces payload errors/empty states, and hides unselectable models", async () => {
    const props = { task, open: true, workspaceDirectory: "/fixture", unavailable: false, onClose: vi.fn(), onCreated: vi.fn(), refresh: vi.fn() };
    let tree: any;
    await act(async () => { tree = create(<SessionCreate {...props} />); });
    expect(tree.root.findByType("Modal").props.open).toBe(true);
    expect(button(tree, "Session settings")).toBeTruthy();
    expect(tree.root.findAllByType("Choices")).toHaveLength(0);
    await act(async () => { button(tree, "Session settings").props.onPress(); });
    expect(tree.root.findAllByType("Choices").map((item: any) => item.props.title)).toEqual(["Provider", "Model", "Permission mode"]);
    tree.unmount();

    state.queryOverrides["ultra|providers"] = { data: { providers: [] }, isSuccess: true, isPending: false, isError: false };
    state.queryOverrides["ultra|models|codex|/fixture"] = { data: { models: [] }, isSuccess: true, isPending: false, isError: false };
    await act(async () => { tree = create(<SessionCreate {...props} />); });
    expect(strings(tree.root.findAllByType("Notice")).join(" ")).toContain("No providers are available");
    expect(button(tree, "Create session").props.disabled).toBe(true);
    tree.unmount();

    state.queryOverrides["ultra|providers"] = undefined;
    state.queryOverrides["ultra|models|codex|/fixture"] = { data: { models: [] }, isSuccess: true, isPending: false, isError: false };
    await act(async () => { tree = create(<SessionCreate {...props} />); });
    expect(strings(tree.root.findAllByType("Notice")).join(" ")).toContain("No selectable models are available");
    expect(button(tree, "Create session").props.disabled).toBe(true);
    tree.unmount();

    state.queryOverrides["ultra|models|codex|/fixture"] = { data: { models: [{ id: "hidden", label: "Hidden", isSelectable: false }] }, isSuccess: true, isPending: false, isError: false };
    await act(async () => { tree = create(<SessionCreate {...props} />); });
    expect(strings(tree.root.findAllByType("Notice")).join(" ")).toContain("No selectable models are available");
    expect(button(tree, "Create session").props.disabled).toBe(true);
    const modelQuery = state.queryOptions.find((q: any) => q.queryKey[1] === "models");
    state.paseo.providers.listModels.mockResolvedValueOnce({ models: [], error: "provider models payload failed" });
    await expect(modelQuery.queryFn()).rejects.toThrow("provider models payload failed");
    state.paseo.providers.listModes.mockResolvedValueOnce({ modes: [], error: "provider modes payload failed" });
    const modeQuery = state.queryOptions.find((q: any) => q.queryKey[1] === "modes");
    await expect(modeQuery.queryFn()).rejects.toThrow("provider modes payload failed");
    tree.unmount();

    state.queryOverrides["ultra|models|codex|/fixture"] = { error: new Error("provider models payload failed"), isSuccess: false, isPending: false, isError: true };
    await act(async () => { tree = create(<SessionCreate {...props} />); });
    expect(strings(tree.root.findAllByType("Notice")).join(" ")).toContain("provider models payload failed");
    expect(button(tree, "Create session").props.disabled).toBe(true);
    tree.unmount();
  });

  test("Creation submission has a synchronous lock and retry recovers prepared actor without losing the draft or replaying create", async () => {
    const pendingContext: { resolve?: (value: any) => void } = {};
    let contextCalls = 0;
    state.rpc.taskContext = vi.fn(() => contextCalls++ === 0
      ? new Promise((resolve) => { pendingContext.resolve = resolve; })
      : Promise.resolve({ available: true, context: "fixture", reason: "" }));
    state.createPrepared.mockRejectedValueOnce(new Error("transport response lost"));
    const props = { task, open: true, workspaceDirectory: "/fixture", unavailable: false, onClose: vi.fn(), onCreated: vi.fn(), refresh: vi.fn() };
    let tree: any;
    await act(async () => { tree = create(<SessionCreate {...props} />); });
    act(() => { field(tree, "Session title (optional)").props.onChange("Keep title"); field(tree, "Initial instruction (optional)").props.onChange("Keep first prompt"); });
    await act(async () => { button(tree, "Create session").props.onPress(); button(tree, "Create session").props.onPress(); await flush(); });
    expect(state.rpc.taskContext).toHaveBeenCalledTimes(1);
    await act(async () => { pendingContext.resolve?.({ available: true, context: "fixture", reason: "" }); await flush(); });
    expect(state.rpc.prepareSession).toHaveBeenCalledTimes(1);
    expect(state.createPrepared).toHaveBeenCalledTimes(1);
    expect(field(tree, "Session title (optional)").props.value).toBe("Keep title");
    expect(field(tree, "Initial instruction (optional)").props.value).toBe("Keep first prompt");
    expect(strings(tree.root.findAllByType("Notice")).join(" ")).toContain("transport response lost");
    state.rpc.taskContext = vi.fn(async () => ({ available: true, context: "fixture", reason: "" }));
    state.actors["prepared-agent"] = actor("prepared-agent", "2026-10-14T00:00:00Z");
    await act(async () => { button(tree, "Create session").props.onPress(); await flush(); });
    expect(state.createPrepared).toHaveBeenCalledTimes(1);
    expect(props.onCreated).toHaveBeenCalledWith("prepared-agent", expect.stringContaining("initial instruction was not sent again"));
    tree.unmount();
  });

  test("Moved actor disables timeline and access queries, has no subscription, and cannot send; each preview gets cold membership query", async () => {
    const moved = actor("moved-agent", "2026-10-14T00:00:00Z", { workspaceId: "other-workspace" });
    state.actors[moved.id] = moved;
    const props: any = { task, sessionId: moved.id, hostId: "host", events: emptyEvents, unavailable: false, navigation, draft: "do not send", pending: false, beginOperation: vi.fn(() => true), endOperation: vi.fn(), onDraftChange: vi.fn(), onBack: vi.fn(), refresh: vi.fn() };
    let tree: any;
    await act(async () => { tree = create(<SessionPreview {...props} />); await flush(); });
    const actorQuery = state.queryOptions.find((q: any) => q.queryKey.slice(0, 3).join("|") === `ultra|agent|${moved.id}`);
    expect(actorQuery.queryKey.slice(3, 5)).toEqual(["preview", expect.any(String)]);
    expect(actorQuery.gcTime).toBe(0);
    const timelineQuery = state.queryOptions.find((q: any) => q.queryKey[1] === "timeline");
    const accessQuery = state.queryOptions.find((q: any) => q.queryKey[1] === "access");
    expect(timelineQuery.enabled).toBe(false);
    expect(accessQuery.enabled).toBe(false);
    expect(state.subscriptions.every((subscription: any) => subscription.unsubscribe.mock.calls.length > 0)).toBe(true);
    expect(button(tree, "Send instruction")).toBeUndefined();
    expect(strings(tree.root.findAllByType("Notice")).join(" ")).toContain("different workspace");
    expect(state.sendInstruction).not.toHaveBeenCalled();
    tree.unmount();

    await act(async () => { tree = create(<SessionPreview {...props} />); await flush(); });
    const actorQueries = state.queryOptions.filter((q: any) => q.queryKey.slice(0, 3).join("|") === `ultra|agent|${moved.id}`);
    expect(actorQueries).toHaveLength(2);
    expect(actorQueries[0].queryKey[4]).not.toBe(actorQueries[1].queryKey[4]);
    tree.unmount();

    const unavailable = actor("provider-off", "2026-10-14T00:00:00Z", { providerUnavailable: true });
    state.actors[unavailable.id] = unavailable;
    const unavailableProps = { ...props, sessionId: unavailable.id, unavailable: true, unavailableReason: "Workspace is archived for this task." };
    await act(async () => { tree = create(<SessionPreview {...unavailableProps} />); await flush(); });
    const notices = strings(tree.root.findAllByType("Notice")).join(" ");
    expect(notices).toContain("provider is unavailable");
    expect(notices).toContain("Workspace is archived for this task.");
    expect(button(tree, "Send instruction").props.disabled).toBe(true);
    expect(button(tree, "Open in Paseo").props.disabled).toBe(false);
    await act(async () => { button(tree, "Open in Paseo").props.onPress(); await flush(); });
    expect(navigation.openAgent).toHaveBeenCalledWith({ agentId: "provider-off", serverId: "host" });
    expect(state.sendInstruction).not.toHaveBeenCalled();
    const actualSession = await vi.importActual<typeof import("../../../../client/session")>("../../../../client/session");
    const realSend = vi.fn();
    const providerUnavailablePaseo: any = { agents: { ref: () => ({ refresh: async () => ({ agent: unavailable }), send: realSend }) } };
    await expect(actualSession.workspaceSession(providerUnavailablePaseo, "provider-off", task.workspaceId, true)).rejects.toThrow("provider is unavailable");
    await expect(actualSession.sendCardInstruction(providerUnavailablePaseo, task, "provider-off", async () => ({ available: true, reason: "", context: "ctx" }), "do not send", "steer")).rejects.toThrow("provider is unavailable");
    expect(realSend).not.toHaveBeenCalled();
    tree.unmount();
  });

  test("Native navigation does not fire when Back unmounts preview during fresh membership check", async () => {
    let resolveMembership: ((value: any) => void) | undefined;
    state.workspaceSession = vi.fn(() => new Promise((resolve) => { resolveMembership = resolve; }));
    let tree: any;
    await act(async () => { tree = create(<TaskDrawer task={task} project={project} events={emptyEvents} compact={false} hostId="host" navigation={navigation} onClose={() => {}} onEdit={() => {}} refresh={() => {}} />); await flush(); });
    const card = tree.root.findAllByType("Pressable").find((item: any) => item.props.accessibilityLabel === "Preview Session agent-new: Ready");
    await act(async () => { card.props.onPress(); await flush(); });
    await act(async () => { button(tree, "Open in Paseo").props.onPress(); await flush(); });
    expect(state.workspaceSession).toHaveBeenCalledWith(state.paseo, "agent-new", task.workspaceId);
    await act(async () => { button(tree, "Back to task").props.onPress(); await flush(); });
    await act(async () => { resolveMembership?.(state.actors["agent-new"]); await flush(); });
    expect(navigation.openAgent).not.toHaveBeenCalled();
    tree.unmount();
  });

  test("NativeOpen remains enabled after StrictMode effect setup-cleanup-setup replay", async () => {
    const effectSequence: string[] = [];
    function StrictEffectProbe() {
      React.useEffect(() => {
        effectSequence.push("setup");
        return () => { effectSequence.push("cleanup"); };
      }, []);
      return null;
    }
    const props: any = { task, sessionId: "agent-new", hostId: "host-strict", events: emptyEvents, unavailable: false, navigation, draft: "", pending: false, beginOperation: vi.fn(() => true), endOperation: vi.fn(), onDraftChange: vi.fn(), onBack: vi.fn(), refresh: vi.fn() };
    let tree: any;
    await act(async () => {
      tree = create(<React.StrictMode><StrictEffectProbe /><SessionPreview {...props} /></React.StrictMode>, { unstable_strictMode: true, unstable_isConcurrent: true });
      await flush();
    });
    expect(effectSequence).toEqual(["setup", "cleanup", "setup"]);
    await act(async () => { button(tree, "Open in Paseo").props.onPress(); await flush(); });
    expect(navigation.openAgent).toHaveBeenCalledWith({ agentId: "agent-new", serverId: "host-strict" });
    tree.unmount();
  });

  test("TaskDrawer keeps per-actor drafts and parent send lock across Back/reopen; Back releases preview subscription", async () => {
    let releaseSend: (() => void) | undefined;
    state.sendInstruction = vi.fn(() => new Promise<void>((resolve) => { releaseSend = resolve; }));
    let tree: any;
    await act(async () => { tree = create(<TaskDrawer task={task} project={project} events={emptyEvents} compact={false} hostId="host" navigation={navigation} onClose={() => {}} onEdit={() => {}} refresh={() => {}} />); await flush(); });
    const select = async (id: string) => {
      const card = tree.root.findAllByType("Pressable").find((item: any) => item.props.accessibilityLabel === `Preview Session ${id}: Ready`);
      await act(async () => { card.props.onPress(); await flush(); });
    };
    await select("agent-new");
    expect(state.subscriptions.length).toBeGreaterThan(0);
    act(() => { field(tree, "Follow-up instruction").props.onChange("Draft A"); });
    await act(async () => { button(tree, "Back to task").props.onPress(); await flush(); });
    expect(state.subscriptions.at(-1)?.unsubscribe).toHaveBeenCalledTimes(1);
    await select("agent-old");
    act(() => { field(tree, "Follow-up instruction").props.onChange("Draft B"); });
    await act(async () => { button(tree, "Back to task").props.onPress(); await flush(); });
    await select("agent-new");
    expect(field(tree, "Follow-up instruction").props.value).toBe("Draft A");
    await act(async () => { button(tree, "Send instruction").props.onPress(); await flush(); });
    expect(state.sendInstruction).toHaveBeenCalledTimes(1);
    await act(async () => { button(tree, "Back to task").props.onPress(); await flush(); });
    await select("agent-new");
    expect(button(tree, "Working…").props.disabled).toBe(true);
    await act(async () => { button(tree, "Back to task").props.onPress(); await flush(); });
    await select("agent-old");
    expect(field(tree, "Follow-up instruction").props.value).toBe("Draft B");
    expect(button(tree, "Send instruction").props.disabled).toBe(false);
    await act(async () => { button(tree, "Back to task").props.onPress(); await flush(); });
    await select("agent-new");
    expect(button(tree, "Working…").props.disabled).toBe(true);
    expect(state.sendInstruction).toHaveBeenCalledTimes(1);
    await act(async () => { releaseSend?.(); await flush(); });
    expect(field(tree, "Follow-up instruction").props.value).toBe("");
    await act(async () => { button(tree, "Back to task").props.onPress(); await flush(); });
    await select("agent-old");
    expect(field(tree, "Follow-up instruction").props.value).toBe("Draft B");
    tree.unmount();
  });

  test("inactive preview disables every query and subscription and fences deferred native open", async () => {
    let releaseMembership!: (value: any) => void;
    state.workspaceSession = vi.fn(() => new Promise((resolve) => { releaseMembership = resolve; }));
    const props: any = {
      task, sessionId: "agent-new", hostId: "host-exact", events: [], unavailable: false,
      navigation, draft: "draft remains", pending: false, beginOperation: vi.fn(() => true), endOperation: vi.fn(),
      onDraftChange: vi.fn(), onBack: vi.fn(), refresh: vi.fn(), visible: true,
    };
    let tree: any;
    await act(async () => { tree = create(<SessionPreview {...props} />); await flush(); });
    const open = button(tree, "Open in Paseo");
    act(() => { open.props.onPress(); });
    expect(state.workspaceSession).toHaveBeenCalledTimes(1);

    await act(async () => { tree.update(<SessionPreview {...props} visible={false} />); });
    const disabledQueries = state.queryOptions.filter((q: any) => ["agent", "timeline", "tools", "access"].includes(q.queryKey[1]));
    expect(disabledQueries.length).toBeGreaterThanOrEqual(8);
    expect(disabledQueries.slice(-4).every((q: any) => q.enabled === false)).toBe(true);
    expect(state.subscriptions.every((subscription: any) => subscription.unsubscribe.mock.calls.length > 0)).toBe(true);
    await act(async () => { releaseMembership(state.actors["agent-new"]); await flush(); });
    expect(navigation.openAgent).not.toHaveBeenCalled();
    expect(tree.root.findAllByType("TextInput")[0].props.value).toBe("draft remains");
    tree.unmount();
  });
});
