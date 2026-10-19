import { expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { PaseoAgent, PaseoAgentUpdate } from "@getpaseo/client";
import { applyAgentUpdates, createChangedReader } from "./queries";
import { SUMMARIZER_LABELS } from "../shared/summary";

vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: () => null, useRpc: () => null }));

const key = ["flowly", "fixture"] as const;
/** Runs one fetch the way react-query does: the result becomes the key's next data update. */
async function poll<T>(client: QueryClient, read: ReturnType<typeof createChangedReader>, fetch: (etag?: string) => Promise<{ etag: string; value?: T }>) {
  const value = await read(client, key, fetch);
  client.setQueryData(key, value);
  return value;
}

test("an unchanged read keeps the cached object and sends the etag", async () => {
  const client = new QueryClient();
  const read = createChangedReader();
  const board = { tasks: [1, 2] };
  const fetch = vi.fn(async (etag?: string) => (etag === "e1" ? { etag: "e1" } : { etag: "e1", value: board }));
  expect(await poll(client, read, fetch)).toBe(board);
  expect(fetch).toHaveBeenLastCalledWith(undefined);
  expect(await poll(client, read, fetch)).toBe(board);
  expect(fetch).toHaveBeenLastCalledWith("e1");
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("a foreign write to the key forces a full read", async () => {
  const client = new QueryClient();
  const read = createChangedReader();
  const fetch = vi.fn(async (etag?: string) => (etag === "e1" ? { etag: "e1" } : { etag: "e1", value: { v: "server" } }));
  await poll(client, read, fetch);
  // e.g. an optimistic update that the server never accepted
  client.setQueryData(key, { v: "optimistic" });
  expect(await poll(client, read, fetch)).toEqual({ v: "server" });
  expect(fetch).toHaveBeenLastCalledWith(undefined);
});

test("a write while an etag read is in flight is not kept", async () => {
  const client = new QueryClient();
  const read = createChangedReader();
  let calls = 0;
  const fetch = vi.fn(async (etag?: string) => {
    calls++;
    if (etag) {
      client.setQueryData(key, { v: "optimistic" });
      return { etag: "e1" };
    }
    return { etag: "e1", value: { v: `server-${calls}` } };
  });
  await poll(client, read, fetch);
  expect(await poll(client, read, fetch)).toEqual({ v: "server-3" });
});

const agent = (id: string, updatedAt: string, extra: Partial<PaseoAgent> = {}) =>
  ({ id, updatedAt, workspaceId: "w", labels: {}, ...extra }) as unknown as PaseoAgent;
const upsert = (a: PaseoAgent) => ({ kind: "upsert", agent: a }) as unknown as PaseoAgentUpdate;

test("live agent updates replace, insert and drop agents", () => {
  const list = [agent("a", "2026-10-15T10:00:00Z"), agent("b", "2026-10-15T10:00:00Z")];
  const next = applyAgentUpdates(list, [
    upsert(agent("a", "2026-10-15T10:00:05Z", { status: "running" } as Partial<PaseoAgent>)),
    upsert(agent("c", "2026-10-15T10:00:01Z")),
    upsert(agent("b", "2026-10-15T10:00:02Z", { archivedAt: "2026-10-15T10:00:02Z" })),
  ]);
  expect(next.map((a) => [a.id, a.updatedAt])).toEqual([
    ["a", "2026-10-15T10:00:05Z"],
    ["c", "2026-10-15T10:00:01Z"],
  ]);
  expect(list).toHaveLength(2); // the cached list is never mutated
  expect(applyAgentUpdates(next, [{ kind: "remove", agentId: "c" } as unknown as PaseoAgentUpdate]).map((a) => a.id)).toEqual(["a"]);
});

test("live agent updates never go back in time and skip summarizers", () => {
  const list = [agent("a", "2026-10-15T10:00:05Z")];
  expect(applyAgentUpdates(list, [upsert(agent("a", "2026-10-15T10:00:01Z"))])[0].updatedAt).toBe("2026-10-15T10:00:05Z");
  const summarizer = agent("s", "2026-10-15T10:00:06Z", { labels: { ...SUMMARIZER_LABELS } } as Partial<PaseoAgent>);
  expect(applyAgentUpdates([], [upsert(summarizer)])).toEqual([]);
  expect(applyAgentUpdates(list, [])).toBe(list);
});
