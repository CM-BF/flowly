import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registerSessionChips } from "./session-link";

const project = { id: "p" };
const task = (title: string) => ({ id: "t1", projectId: "p", workspaceId: "w1", title });
const agent = (id: string, archivedAt: string | null = null) => ({ id, workspaceId: "w1", archivedAt, title: id, labels: {} });

/** A fake plugin client: the board changes only when `boardEtag` does. */
function fakeClient() {
  const state = { boardEtag: "e1", title: "Card", live: [agent("a1")], all: [agent("a1"), agent("old", "2026-10-01T00:00:00.000Z")] };
  const calls = { board: [] as unknown[], archivedScans: 0, updates: 0, pills: 0 };
  const client = {
    rpc: vi.fn(async (_def: unknown, input: { etag?: string }) => {
      calls.board.push(input);
      if (input.etag === state.boardEtag) return { etag: state.boardEtag };
      return { etag: state.boardEtag, value: { projects: [project], tasks: [task(state.title)] } };
    }),
    paseo: {
      agents: {
        list: vi.fn(async ({ filter }: { filter: { includeArchived: boolean } }) => {
          if (filter.includeArchived) calls.archivedScans++;
          const list = filter.includeArchived ? state.all : state.live;
          return { entries: list.map((a) => ({ agent: a })), pageInfo: { nextCursor: null } };
        }),
      },
    },
    addComposerPill: vi.fn(() => {
      calls.pills++;
      return { update: () => void calls.updates++, remove: () => undefined };
    }),
    openScreen: vi.fn(),
  };
  return { client, state, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("an unchanged board is not re-downloaded, chips are not re-pushed, archived is not rescanned", async () => {
  const { client, state, calls } = fakeClient();
  const stop = registerSessionChips(client as never, 1000, 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.pills).toBe(2); // live a1 and archived "old" share the card
  expect(calls.archivedScans).toBe(1);
  await vi.advanceTimersByTimeAsync(3000);
  // Later rounds send the etag; nothing changed, so no pill update and no host-wide scan.
  expect(calls.board.slice(1).every((input) => (input as { etag?: string }).etag === "e1")).toBe(true);
  expect(calls.updates).toBe(0);
  expect(calls.archivedScans).toBe(1);
  // A renamed card: the board changes, the pills update once.
  state.boardEtag = "e2";
  state.title = "Renamed";
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls.updates).toBe(2);
  expect(calls.archivedScans).toBe(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(calls.updates).toBe(2);
  stop();
});

test("archived sessions are rescanned at most once a minute without board changes", async () => {
  const { client, calls } = fakeClient();
  const stop = registerSessionChips(client as never, 5000, 0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(55_000);
  expect(calls.archivedScans).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls.archivedScans).toBe(2);
  stop();
});

test("a board change that arrives as a patch updates the chips (the daemon answers a known etag with a patch)", async () => {
  const { client, state, calls } = fakeClient();
  const full = (title: string) => ({ revision: 1, events: [], plans: [], projects: [project], tasks: [task(title)], ideas: [], links: [], artifacts: [], workpads: [], attentionDismissals: [] });
  client.rpc.mockImplementation(async (_def: unknown, input: { etag?: string }) => {
    calls.board.push(input);
    if (input.etag === state.boardEtag) return { etag: state.boardEtag };
    // A caller that holds the previous etag gets only the changed task.
    if (input.etag) return { etag: state.boardEtag, patch: { revision: 2, events: [], tasks: { set: [task(state.title)], remove: [] } } };
    return { etag: state.boardEtag, value: full(state.title) };
  });
  const stop = registerSessionChips(client as never, 1000, 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.pills).toBe(2);
  state.boardEtag = "e2";
  state.title = "Renamed";
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls.updates).toBe(2);
  stop();
});

test("the first chip round waits for the start delay, so it stays off the plugin's first paint", async () => {
  const { client, calls } = fakeClient();
  const stop = registerSessionChips(client as never, 1000, 2500);
  await vi.advanceTimersByTimeAsync(2499);
  expect(calls.board).toHaveLength(0);
  expect(client.paseo.agents.list).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(calls.board).toHaveLength(1);
  expect(calls.pills).toBe(2);
  stop();
  // Stopped before the first round: nothing is ever read.
  const idle = fakeClient();
  registerSessionChips(idle.client as never, 1000, 2500)();
  await vi.advanceTimersByTimeAsync(5000);
  expect(idle.calls.board).toHaveLength(0);
});
