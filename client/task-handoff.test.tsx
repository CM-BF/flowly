import { beforeEach, expect, test, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { emptyHandoff, type CardHandoff } from "../shared/handoff";
import type { HandoffContextView } from "../shared/handoff-api";
import { setLocale } from "../shared/i18n";

// Run the exported controls with persistent hooks and their real callbacks. This verifies state and RPC
// lifecycles, not host rendering/painting; real compact/desktop checks remain a live acceptance gate.
const host = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0, effects: [] as (() => void)[], query: undefined as HandoffContextView | undefined,
  options: undefined as Record<string, unknown> | undefined, read: vi.fn(), note: vi.fn(), mark: vi.fn(), resume: vi.fn(),
  cache: { invalidateQueries: vi.fn(async () => {}), getQueryData: vi.fn(), getQueryState: vi.fn() }, id: 0,
}));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = host.cursor++; if (!(i in host.states)) host.states[i] = typeof initial === "function" ? initial() : initial; return [host.states[i], (next: unknown) => { host.states[i] = typeof next === "function" ? next(host.states[i]) : next; }]; },
  useRef: (initial: unknown) => { const i = host.cursor++; if (!(i in host.states)) host.states[i] = { current: initial }; return host.states[i]; },
  useMemo: (fn: () => unknown, deps: unknown[]) => { const i = host.cursor++, old = host.states[i] as { deps: unknown[]; value: unknown } | undefined; if (!old || !deps.every((v, k) => Object.is(v, old.deps[k]))) host.states[i] = { deps, value: fn() }; return (host.states[i] as { value: unknown }).value; },
  useEffect: (fn: () => void | (() => void), deps: unknown[]) => { const i = host.cursor++, old = host.states[i] as { deps: unknown[]; cleanup?: () => void } | undefined; if (!old || !deps.every((v, k) => Object.is(v, old.deps[k]))) { const value = { deps, cleanup: undefined as void | (() => void) }; host.states[i] = value; host.effects.push(() => { old?.cleanup?.(); value.cleanup = fn(); }); } },
}));
vi.mock("react-native", () => ({ View: "View" }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: (rpc: { name: string }) => ({ "handoffs.read": host.read, "handoffs.note": host.note, "handoffs.input": host.mark, "handoffs.continue": host.resume })[rpc.name] }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => host.cache, useQuery: (options: Record<string, unknown>) => { host.options = options; return { data: host.query, isPending: !host.query }; } }));
vi.mock("./ui", () => ({ Label: "Label", Badge: "Badge", Button: "Button", Notice: "Notice", TextBox: "TextBox", font: {}, space: {}, radius: {}, useTheme: () => ({ colors: {} }), relativeTime: () => "recently", message: String }));
vi.mock("./disclosure", () => ({ Section: "Section", Disclosure: "Disclosure" }));
vi.mock("./queries", () => ({ boardKey: ["flowly", "board"], createChangedReader: () => async (_cache: unknown, _key: unknown, fetch: (etag?: string) => Promise<{ value: unknown }>) => (await fetch()).value }));
vi.mock("./sent-images", () => ({ newMessageId: () => `operation-${++host.id}` }));
vi.mock("./shortcuts", () => ({ useShortcutBlock: () => {} }));
import { TaskHandoff, FullHandoff } from "./task-handoff";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const e = node as Element;
  if (typeof e.type === "function" && !["Group", "FullHandoff"].includes(e.type.name)) return [e, ...elements((e.type as (props: unknown) => ReactNode)(e.props))];
  return [e, ...elements(e.props.children as ReactNode)];
}
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : typeof node === "string" || typeof node === "number" ? String(node) : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
const button = (tree: Element[], name: string) => tree.find(e => e.type as unknown === "Button" && (e.props.label === name || text(e.props.children as ReactNode) === name))!;
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const press = async (node: Element) => { await (node.props.onPress as () => Promise<void> | void)(); await tick(); };
const flushEffects = () => { for (const fn of host.effects.splice(0)) fn(); };
const at = "2026-10-24T00:00:00Z";
function record() { const r = emptyHandoff("a", "p"); r.revision = 1; r.updatedAt = at; r.inputs.push({ id: "original-1", rev: 1, at, by: { kind: "human" }, text: "Keep the exact original requirement", characters: 35, status: "open", atSource: "typed", via: "session" }); return r; }
function context(r = record()): HandoffContextView { return { revision: r.revision, fresh: false, due: [], currentAgentId: "current-agent", view: { revision: r.revision, record: r, complete: false, omitted: 2, truncatedIds: [], openIds: ["original-1"], openIdsTotal: 1, fullRead: "follow every page" } }; }
function renderCard(extra: Partial<Parameters<typeof TaskHandoff>[0]> = {}) {
  const onStartSession = vi.fn(), onOpenSession = vi.fn();
  const props = { taskId: "a", active: true, disabled: false, section: { open: true, onToggle: vi.fn() }, onStartSession, onOpenSession, ...extra };
  const render = () => { host.cursor = 0; const tree = elements(TaskHandoff(props)); flushEffects(); return tree; };
  return { props, render, onStartSession, onOpenSession };
}
beforeEach(() => { host.states = []; host.cursor = 0; host.effects = []; host.query = context(); host.id = 0; host.read.mockReset(); host.note.mockReset(); host.mark.mockReset(); host.resume.mockReset(); host.cache.invalidateQueries.mockClear(); setLocale("en"); });

test("folded and inactive handoff details do not poll, while expanded details use the shared key", () => {
  const x = renderCard({ section: { open: false, onToggle: vi.fn() } }); x.render();
  expect(host.options).toMatchObject({ queryKey: ["flowly", "handoff", "a"], enabled: false, refetchInterval: false });
  x.props.section.open = true; x.render(); expect(host.options).toMatchObject({ enabled: true, refetchInterval: 5000 });
  x.props.active = false; x.render(); expect(host.options).toMatchObject({ enabled: false, refetchInterval: false });
});

test("background handoff refresh updates visible state without overwriting an unsent human note", () => {
  const x = renderCard(); let tree = x.render();
  (tree.find(e => e.type as unknown === "TextBox")!.props.onChangeText as (value: string) => void)("My unsent constraint");
  const r = record(); r.state = { id: "state", rev: 2, at, by: { kind: "agent" }, text: "Newly captured current state" }; r.revision = 2; host.query = context(r);
  tree = x.render();
  expect(tree.find(e => e.type as unknown === "TextBox")!.props.value).toBe("My unsent constraint");
  expect(text(tree as unknown as ReactNode)).toContain("Newly captured current state");
});

test("double save while pending submits once; a lost response retries the same note operation and preserves the draft", async () => {
  const x = renderCard(); let tree = x.render();
  (tree.find(e => e.type as unknown === "TextBox")!.props.onChangeText as (value: string) => void)("User constraint"); tree = x.render();
  let reject!: (e: Error) => void; host.note.mockImplementationOnce(() => new Promise((_r, no) => { reject = no; }));
  const action = button(tree, "Save handoff note"); const first = press(action); await press(action);
  expect(host.note).toHaveBeenCalledTimes(1);
  const sent = host.note.mock.calls[0][0]; reject(new Error("lost response")); await first; await tick();
  tree = x.render(); expect(tree.find(e => e.type as unknown === "TextBox")!.props.value).toBe("User constraint");
  host.note.mockResolvedValueOnce({ ok: true }); await press(button(tree, "Save handoff note"));
  expect(host.note.mock.calls[1][0]).toEqual(sent);
  expect(x.render().find(e => e.type as unknown === "TextBox")!.props.value).toBe("");
});

test("input status and standing actions retain the original text and serialize exact selections", async () => {
  const x = renderCard(); host.mark.mockResolvedValue({ ok: true });
  await press(button(x.render(), "Mark superseded"));
  expect(host.mark).toHaveBeenLastCalledWith(expect.objectContaining({ id: "original-1", handoffRevision: 1, status: "superseded" }));
  await press(button(x.render(), "Keep as standing instruction"));
  expect(host.mark).toHaveBeenLastCalledWith(expect.objectContaining({ id: "original-1", standing: true }));
  expect(text(x.render() as unknown as ReactNode)).toContain("Keep the exact original requirement");
});

test("fresh automation continuation never opens a second manual form; manual continuation opens only the requested form", async () => {
  const x = renderCard(); host.resume.mockResolvedValueOnce({ ok: true, automation: true });
  await press(button(x.render(), "Continue in a fresh session")); expect(x.onStartSession).not.toHaveBeenCalled();
  host.resume.mockResolvedValueOnce({ ok: true, automation: false });
  await press(button(x.render(), "Continue in a fresh session")); expect(x.onStartSession).toHaveBeenCalledOnce();
  expect(host.resume.mock.calls.map(c => c[0])).toEqual([{ taskId: "a", fresh: true }, { taskId: "a", fresh: true }]);
});

test("continuing a selected previous session uses that exact identity, with no fallback on rejection", async () => {
  const r = record(); r.ledger.push({ id: "session-entry", agentId: "previous-identity", n: 1, role: "implementer", provider: "codex", startedAt: at, endedAt: at, reason: "launch", finalized: true, at, rev: 1, by: { kind: "flowly" }, turns: [], background: [], live: [] });
  host.query = context(r); const x = renderCard(); host.resume.mockRejectedValueOnce(new Error("session busy"));
  await press(button(x.render(), "Continue in this session"));
  expect(host.resume).toHaveBeenCalledWith({ taskId: "a", fresh: false, agentId: "previous-identity" });
  expect(x.onOpenSession).not.toHaveBeenCalled(); expect(x.onStartSession).not.toHaveBeenCalled();
  host.resume.mockResolvedValueOnce({ ok: true, automation: false }); await press(button(x.render(), "Continue in this session"));
  expect(x.onOpenSession).toHaveBeenCalledWith("previous-identity");
});

test("a delayed continuation cannot open a new session form after the drawer was closed", async () => {
  const x = renderCard(); let resolve!: (value: unknown) => void;
  host.resume.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
  const pending = press(button(x.render(), "Continue in a fresh session"));
  x.props.active = false; x.render(); resolve({ ok: true, automation: false }); await pending;
  expect(x.onStartSession).not.toHaveBeenCalled();
});

function renderFull(r: CardHandoff) { const props = { taskId: "a", active: true, preview: r }; return { props, render: () => { host.cursor = 0; const tree = elements(FullHandoff(props)); flushEffects(); return tree; } }; }
const page = (r: CardHandoff, items: NonNullable<HandoffContextView["page"]>["items"], nextCursor?: string) => ({ etag: "e", value: { ...context(r), page: { taskId: "a", revision: r.revision, items, openIds: [], openIdsTotal: 0, total: 2, omitted: nextCursor ? 1 : 0, complete: !nextCursor, ...(nextCursor ? { nextCursor } : {}) } } });

test("full reading fetches one user-requested page, follows its cursor, joins original chunks and labels incompleteness", async () => {
  const r = record(), x = renderFull(r);
  host.read.mockResolvedValueOnce(page(r, [{ section: "inputs", id: "long", field: "text", text: "original first part", offset: 0, origin: "archive", complete: false }], "next-1"));
  x.render(); await tick(); let tree = x.render();
  expect(host.read).toHaveBeenCalledTimes(1); expect(text(tree as unknown as ReactNode)).toContain("More pages remain: 1 entries not yet read.");
  expect(text(tree as unknown as ReactNode)).not.toContain("End of the full record");
  host.read.mockResolvedValueOnce(page(r, [{ section: "inputs", id: "long", field: "text", text: " + original final part", offset: 19, origin: "archive", complete: true }]));
  await press(button(tree, "Read next page")); tree = x.render();
  expect(host.read).toHaveBeenLastCalledWith({ taskId: "a", full: true, cursor: "next-1" });
  expect(text(tree as unknown as ReactNode)).toContain("original first part + original final part");
  expect(text(tree as unknown as ReactNode)).toContain("End of the full record");
});

test("a changed revision is never silently combined with previous full pages", async () => {
  const r = record(), x = renderFull(r);
  host.read.mockResolvedValueOnce(page(r, [{ section: "notes", id: "old", value: { text: "old revision entry" }, origin: "current", complete: true }], "next"));
  x.render(); await tick(); let tree = x.render();
  const newer = { ...r, revision: 2 }; host.read.mockResolvedValueOnce(page(newer, [{ section: "notes", id: "new", value: { text: "new revision entry" }, origin: "current", complete: true }]));
  await press(button(tree, "Read next page")); tree = x.render();
  expect(text(tree as unknown as ReactNode)).toContain("The handoff changed while reading");
  expect(text(tree as unknown as ReactNode)).not.toContain("new revision entry");
});

test("malformed complete JSON is a visible information gap, never an apparently empty successful entry", async () => {
  const r = record(), x = renderFull(r);
  host.read.mockResolvedValueOnce(page(r, [{ section: "reviews", id: "bad", field: "json", text: "{bad json", offset: 0, origin: "archive", complete: true }]));
  x.render(); await tick(); expect(text(x.render() as unknown as ReactNode)).toContain("This entry could not be decoded; its contents are not verified.");
});
