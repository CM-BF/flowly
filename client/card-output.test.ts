import { expect, test, vi } from "vitest";

vi.mock("@getpaseo/plugin/client", () => ({ usePaseo: () => null }));

const { createLimiter, latestAgentOutput, pickOutputSession, plainOutputText } =
  await import("./card-output");

test("session choice is the workspace's most recently updated non-archived session", () => {
  const agents = [
    { id: "old", workspaceId: "w", updatedAt: "2026-10-14T10:00:00Z" },
    { id: "other", workspaceId: "x", updatedAt: "2026-10-14T12:00:00Z" },
    { id: "archived", workspaceId: "w", updatedAt: "2026-10-14T13:00:00Z", archivedAt: "2026-10-14T13:00:00Z" },
    { id: "new", workspaceId: "w", updatedAt: "2026-10-14T11:00:00Z" },
    { id: "invalid", workspaceId: "w", updatedAt: null },
  ];
  expect(pickOutputSession(agents, "w")).toEqual({ id: "new", updatedAt: "2026-10-14T11:00:00Z" });
  expect(pickOutputSession(agents, "none")).toBeNull();
  expect(pickOutputSession([], "w")).toBeNull();
});

test("session ties break by last prompt, creation, then ID", () => {
  const at = "2026-10-14T10:00:00Z";
  expect(
    pickOutputSession(
      [
        { id: "a", workspaceId: "w", updatedAt: at, lastUserMessageAt: "2026-10-14T09:00:00Z" },
        { id: "b", workspaceId: "w", updatedAt: at, lastUserMessageAt: "2026-10-14T08:00:00Z" },
      ],
      "w",
    )?.id,
  ).toBe("a");
  expect(
    pickOutputSession(
      [
        { id: "b", workspaceId: "w", updatedAt: at, createdAt: at },
        { id: "c", workspaceId: "w", updatedAt: at, createdAt: at },
      ],
      "w",
    )?.id,
  ).toBe("c");
});

test("output takes the newest assistant text and skips user, thinking, tool and empty entries", () => {
  expect(
    latestAgentOutput([
      { timestamp: "t1", item: { type: "assistant_message", text: "Earlier **plan**" } },
      { timestamp: "t2", item: { type: "assistant_message", text: "```\n```" } },
      { timestamp: "t3", item: { type: "assistant_message", text: "  " } },
      { timestamp: "t4", item: { type: "reasoning", text: "thinking" } },
      { timestamp: "t5", item: { type: "tool_call" } },
      { timestamp: "t6", item: { type: "user_message", text: "user asks" } },
    ]),
  ).toEqual({ text: "Earlier plan", at: "t1" });
  expect(
    latestAgentOutput([{ timestamp: "t", item: { type: "user_message", text: "hi" } }]),
  ).toBeNull();
  expect(latestAgentOutput([])).toBeNull();
});

test("markdown markers are removed into one line", () => {
  expect(
    plainOutputText(
      "# Done\n\n- [x] Fixed `card.tsx` with **bold** and _em_\n> see [docs](https://x.y) ![shot](a.png)\n\n---\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst hidden = 1;\n```\n~~old~~ new",
    ),
  ).toBe("Done Fixed card.tsx with bold and em see docs shot A B 1 2 old new");
  expect(plainOutputText("```sh\nnpm test\n```")).toBe("npm test");
  const long = plainOutputText("word ".repeat(100), 40);
  expect(long.length).toBeLessThanOrEqual(40);
  expect(long.endsWith("…")).toBe(true);
});

test("limiter bounds concurrency, runs FIFO and releases slots on failure", async () => {
  const run = createLimiter(2);
  const started: number[] = [];
  const gates: (() => void)[] = [];
  const job = (n: number, fail = false) =>
    run(
      () =>
        new Promise<number>((resolve, reject) => {
          started.push(n);
          gates.push(() => (fail ? reject(new Error(String(n))) : resolve(n)));
        }),
    );
  const results = [job(1, true), job(2), job(3), job(4)].map((p) => p.catch((e: Error) => e.message));
  await Promise.resolve();
  expect(started).toEqual([1, 2]);
  gates[0]();
  await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
  gates[1]();
  gates[2]();
  await vi.waitFor(() => expect(started).toEqual([1, 2, 3, 4]));
  gates[3]();
  expect(await Promise.all(results)).toEqual(["1", 2, 3, 4]);
});

test("aborted queued work never starts and frees its place", async () => {
  const run = createLimiter(1);
  let release!: () => void;
  const work = vi.fn(() => Promise.resolve("late"));
  const first = run(() => new Promise<string>((resolve) => (release = () => resolve("first"))));
  const controller = new AbortController();
  const skipped = run(work, controller.signal);
  const next = run(() => Promise.resolve("next"));
  controller.abort();
  await expect(skipped).rejects.toMatchObject({ name: "AbortError" });
  release();
  expect(await first).toBe("first");
  expect(await next).toBe("next");
  expect(work).not.toHaveBeenCalled();
  await expect(run(work, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("running sessions share one output cache key per refresh window", async () => {
  const { outputCacheKey, RUNNING_REFRESH_MS } = await import("./card-output");
  const base = Date.parse("2026-10-15T00:00:00.000Z");
  const at = (ms: number) => new Date(base + ms).toISOString();
  const run = (ms: number) => outputCacheKey({ id: "s", updatedAt: at(ms), status: "running" });
  expect(run(1000)).toBe(run(RUNNING_REFRESH_MS - 1000));
  expect(run(1000)).not.toBe(run(RUNNING_REFRESH_MS + 1000));
  // Idle sessions refetch on every real change.
  expect(outputCacheKey({ id: "s", updatedAt: at(1000), status: "idle" })).toBe(at(1000));
});
