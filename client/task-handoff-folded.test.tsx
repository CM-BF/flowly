import { beforeEach, expect, test, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { HandoffContextView } from "../shared/handoff-api";
import { setLocale } from "../shared/i18n";
import { defaultSectionOpen } from "../shared/drawer-sections";

// The Handoff section is folded by default at every width, so its summary (and the card face, through the index the
// read refreshes) must learn of a lost record without the person unfolding it: a folded section asks once for the record's
// status, never the record itself (SESSION-HANDOFF-SPEC §12, §21.16). Same hook harness as client/task-handoff.test.tsx,
// with one query result and one set of options per query key.
const host = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0, effects: [] as (() => void)[], data: {} as Record<string, HandoffContextView | undefined>,
  options: {} as Record<string, Record<string, unknown>>, read: vi.fn(), note: vi.fn(), mark: vi.fn(), resume: vi.fn(),
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
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => host.cache, useQuery: (options: Record<string, unknown>) => {
  const key = (options.queryKey as string[])[1]; host.options[key] = options;
  const data = options.enabled ? host.data[key] : undefined; return { data, isPending: !data };
} }));
vi.mock("./ui", () => ({ Label: "Label", Badge: "Badge", Button: "Button", Notice: "Notice", TextBox: "TextBox", font: {}, space: {}, radius: {}, useTheme: () => ({ colors: {} }), relativeTime: () => "recently", message: String }));
vi.mock("./disclosure", () => ({ Section: "Section", Disclosure: "Disclosure" }));
vi.mock("./queries", () => ({ boardKey: ["flowly", "board"], createChangedReader: () => async (_cache: unknown, _key: unknown, fetch: (etag?: string) => Promise<{ value: unknown }>) => (await fetch()).value }));
vi.mock("./sent-images", () => ({ newMessageId: () => `operation-${++host.id}` }));
vi.mock("./shortcuts", () => ({ useShortcutBlock: () => {} }));
import { TaskHandoff } from "./task-handoff";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const e = node as Element;
  if (typeof e.type === "function" && !["Group", "FullHandoff"].includes(e.type.name)) return [e, ...elements((e.type as (props: unknown) => ReactNode)(e.props))];
  return [e, ...elements(e.props.children as ReactNode)];
}
const summary = (tree: Element[]) => tree.find(e => e.type as unknown === "Section")!.props.summary as string;
const lost: HandoffContextView = { revision: 0, fresh: false, due: ["The durable handoff is unavailable; do not guess missing requirements."], unavailable: "The known handoff file is missing; recover it before continuing." };
const calm = { taskId: "a", fresh: true, open: 0, sessions: 3 };
function render(props: Partial<Parameters<typeof TaskHandoff>[0]> = {}) {
  host.cursor = 0;
  const tree = elements(TaskHandoff({ taskId: "a", active: true, disabled: false, section: { open: defaultSectionOpen.handoff, onToggle: vi.fn() }, index: calm, pending: false, onStartSession: vi.fn(), onOpenSession: vi.fn(), ...props }));
  for (const fn of host.effects.splice(0)) fn();
  return tree;
}
beforeEach(() => { host.states = []; host.cursor = 0; host.effects = []; host.data = {}; host.options = {}; host.read.mockReset(); setLocale("en"); });

test("folded by default, the section asks once for the record's status and warns when the record is lost", async () => {
  expect(defaultSectionOpen.handoff).toBe(false);
  host.data["handoff-status"] = lost;
  for (const index of [calm, { ...calm, fresh: false, staleSince: "2026-10-24T00:00:00Z", behind: "activity" as const }]) {
    host.states = [];
    const tree = render({ index });
    // The record itself is not fetched while folded; its status is, once (no interval).
    expect(host.options.handoff).toMatchObject({ enabled: false, refetchInterval: false });
    expect(host.options["handoff-status"]).toMatchObject({ queryKey: ["flowly", "handoff-status", "a"], enabled: true, refetchInterval: false });
    expect(summary(tree)).toMatch(/^Handoff needs checking · 0 unresolved items · 3 sessions$/);
  }
  host.read.mockResolvedValue({ etag: "e", value: lost });
  await (host.options["handoff-status"].queryFn as () => Promise<unknown>)();
  expect(host.read).toHaveBeenCalledWith({ taskId: "a", status: true });
});

test("the status read is not made when the card has no handoff, the drawer is inactive or the section is open", () => {
  host.data["handoff-status"] = { revision: 1, fresh: true, due: [] };
  render(); expect(host.options["handoff-status"]).toMatchObject({ enabled: true });
  expect(summary(render())).toMatch(/^Handoff recorded · /);
  render({ index: undefined }); expect(host.options["handoff-status"]).toMatchObject({ enabled: false });
  render({ active: false }); expect(host.options["handoff-status"]).toMatchObject({ enabled: false });
  render({ section: { open: true, onToggle: vi.fn() } }); expect(host.options["handoff-status"]).toMatchObject({ enabled: false }); expect(host.options.handoff).toMatchObject({ enabled: true });
});
