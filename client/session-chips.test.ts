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
  const stop = registerSessionChips(client as never, 1000);
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
  const stop = registerSessionChips(client as never, 5000);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(55_000);
  expect(calls.archivedScans).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls.archivedScans).toBe(2);
  stop();
});
