import { beforeEach, expect, test, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { emptyBoard, type Task } from "../shared/model";
import { classificationHash } from "../shared/review-levels";
import { setLocale } from "../shared/i18n";

// Execute the actual exported form and its callbacks with persistent hook state. Host controls are opaque elements:
// this exercises a board-query rerender without a daemon or a native renderer, not host layout or painting.
const host = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, board: undefined as unknown, update: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const slot = host.cursor++;
    if (!(slot in host.states)) host.states[slot] = typeof initial === "function" ? initial() : initial;
    return [host.states[slot], (value: unknown) => { host.states[slot] = typeof value === "function" ? value(host.states[slot]) : value; }];
  },
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const slot = host.cursor++, previous = host.states[slot] as { deps: unknown[]; value: unknown } | undefined;
    if (!previous || !deps.every((value, i) => Object.is(value, previous.deps[i]))) host.states[slot] = { deps, value: fn() };
    return (host.states[slot] as { value: unknown }).value;
  },
  useRef: (initial: unknown) => {
    const slot = host.cursor++;
    if (!(slot in host.states)) host.states[slot] = { current: initial };
    return host.states[slot];
  }, useEffect: () => {},
}));
vi.mock("react-native", () => ({ View: "View" }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({}) }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => host.update, usePaseo: () => ({}), useSettings: () => ({}) }));
vi.mock("./queries", () => ({ useBoardQuery: () => ({ data: host.board }), useResourcesQuery: () => ({ data: { workspaces: [] } }) }));
vi.mock("./ui", () => ({ useTheme: () => ({ colors: {} }), Theme: { Provider: "Theme" }, Field: "Field", Choices: "Choices", Label: "Label", View: "View", Button: "Button", IconButton: "IconButton", Notice: "Notice", Row: "Row", Actions: "Actions", Toggle: "Toggle", font: {}, radius: {}, space: {}, relativeTime: () => "", basename: () => "", message: String }));
vi.mock("./modal", () => ({ Modal: Object.assign("Modal", { Content: "ModalContent", Footer: "ModalFooter" }) }));
vi.mock("./lane-editor", () => ({ LaneEditor: "LaneEditor" }));
vi.mock("./disclosure", () => ({ Disclosure: "Disclosure" }));
vi.mock("./agent-choice", () => ({ AgentPicker: "AgentPicker", useAgentChoice: () => ({ ready: true }) }));
vi.mock("./model-default", () => ({ ModelDefaultGroup: "ModelDefaultGroup" }));
vi.mock("./task-automation", () => ({ AutomationSettingsGroup: "AutomationSettingsGroup" }));
vi.mock("./session", () => ({ launchKanbanSession: vi.fn() }));
vi.mock("./image-attach", () => ({ ImageAttachments: "ImageAttachments", useImageAttachments: () => ({ attachments: [] }) }));
vi.mock("./sent-images", () => ({ newMessageId: () => "id", rememberSentImages: vi.fn() }));
vi.mock("./directory-picker", () => ({ DirectoryChooser: "DirectoryChooser" }));
vi.mock("./tag-input", () => ({ TagEditor: "TagEditor" }));
vi.mock("./stable", () => ({ useStableCallback: (fn: unknown) => fn }));
vi.mock("./connectors", () => ({ ExternalChip: "ExternalChip", ExternalPicker: "ExternalPicker", useConnections: () => ({}), connectionsByFamily: () => new Map(), familyNames: {}, pickKey: () => "" }));
vi.mock("./brand-icons", () => ({ BrandIcon: "BrandIcon" }));
import { TaskForm } from "./forms";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
const at = "2026-10-24T00:00:00Z";
function setup(status: "pending" | "ready" | "failed" | "none") {
  const board = emptyBoard();
  const task: Task = { id: "a", projectId: "p", workspaceId: "w", title: "UI card", description: "A form", status: "development", priority: "normal", tags: [], sourcePath: "/p", repoPaths: [], position: 0, revision: 1, operationId: "a", createdAt: at, updatedAt: at, archivedAt: null };
  board.tasks.push(task);
  board.projects.push({ id: "p", title: "P", primaryPath: "/p", repos: ["/p"], description: "", paseoProjectId: "native", revision: 1, createdAt: at, updatedAt: at, archivedAt: null });
  if (status !== "none") task.reviewClassification = { inputHash: classificationHash(board, task), status, at, fallback: { level: "standard", reason: { kind: "default" } }, ...(status === "ready" ? { verdict: { level: "light", reason: "The card changes a local label.", model: "cheap/model" } } : {}) };
  host.board = board;
  const render = () => { host.cursor = 0; return elements(TaskForm({ project: board.projects[0], task, onClose: () => {}, onSaved: () => {} })); };
  const control = (tree: Element[], type: string, title?: string) => tree.find((e) => e.type as unknown === type && (!title || e.props.title === title))!;
  const texts = (tree: Element[]) => tree.filter((e) => e.type as unknown === "Label").map((e) => e.props.children).filter((value) => typeof value === "string");
  return { board, task, render, control, texts };
}
beforeEach(() => { host.states = []; host.cursor = 0; host.update.mockReset(); setLocale("en"); });

test("an already-open task editor reads the latest classification after a background board update", () => {
  const x = setup("pending");
  expect(x.texts(x.render())).toContain("Classifying…");
  const fresh: Task = { ...x.task, reviewClassification: { ...x.task.reviewClassification!, status: "ready", verdict: { level: "light", reason: "The card changes a local label.", model: "cheap/model" } } };
  host.board = { ...x.board, tasks: [fresh] };
  expect(x.texts(x.render())).toContain("Auto: Light — The card changes a local label. (cheap/model)");
});

for (const state of ["none", "pending", "ready", "failed"] as const) {
  test(`${state} classification refresh preserves dirty title, description and tags and identifies unsaved input`, () => {
    const x = setup(state); let tree = x.render();
    (x.control(tree, "Field", "Title").props.onChange as (value: string) => void)("My draft title");
    (x.control(tree, "Field", "Description").props.onChange as (value: string) => void)("My draft description");
    (x.control(tree, "TagEditor").props.onAdd as (value: string[]) => void)(["draft-tag"]);
    const fresh: Task = { ...x.task, title: "Someone else changed the saved title", description: "New saved description", tags: [{ tag: "remote-tag", by: "human", at }] };
    if (state !== "none") fresh.reviewClassification = { ...x.task.reviewClassification!, inputHash: classificationHash({ ...x.board, tasks: [fresh] }, fresh) };
    host.board = { ...x.board, tasks: [fresh] };
    tree = x.render();
    expect(x.control(tree, "Field", "Title").props.value).toBe("My draft title");
    expect(x.control(tree, "Field", "Description").props.value).toBe("My draft description");
    expect(x.control(tree, "TagEditor").props.tags).toEqual(["draft-tag"]);
    expect(x.texts(tree)).toContain("Save changes to classify this card.");
  });
  test(`${state} classification with clean local input shows its current state`, () => {
    const x = setup(state), text = x.texts(x.render());
    expect(text).toContain(state === "pending" ? "Classifying…" : state === "ready" ? "Auto: Light — The card changes a local label. (cheap/model)" : "Auto: Standard (keyword fallback), because nothing calls for a deeper or lighter review.");
  });
}
