import { expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { turnTimeline } from "./turn-timeline";

vi.mock("./error-report", () => ({ logFailure: vi.fn() }));

const paseoWith = (refetch: (...args: unknown[]) => unknown) =>
  ({ agents: { ref: () => ({ timeline: { refetch } }) } }) as unknown as PaseoApi;

test("a hook that carries the turn is used as it is, with no read", async () => {
  const refetch = vi.fn();
  const hook = [{ type: "assistant_message" }];
  expect(await turnTimeline(paseoWith(refetch), "a", hook)).toBe(hook);
  expect(refetch).not.toHaveBeenCalled();
});

test("an empty hook (Paseo 0.13) is replaced by the last turn of the newest page", async () => {
  const refetch = vi.fn(async () => ({
    entries: [
      { item: { type: "user_message", text: "old" } },
      { item: { type: "assistant_message", text: "old reply" } },
      { item: { type: "user_message", text: "new" } },
      { item: { type: "tool_call", name: "Bash" } },
      { item: { type: "assistant_message", text: "new reply" } },
    ],
  }));
  const turn = await turnTimeline<{ type: string }>(paseoWith(refetch), "agent-1", []);
  expect(turn.map((i) => i.type)).toEqual(["user_message", "tool_call", "assistant_message"]);
  expect(refetch).toHaveBeenCalledWith({ direction: "tail", limit: 200, projection: "projected" });
});

test("a failed read leaves the empty hook value", async () => {
  const turn = await turnTimeline<{ type: string }>(paseoWith(async () => { throw new Error("gone"); }), "a", []);
  expect(turn).toEqual([]);
});

test("an oversized Codex session's empty hook is not replaced by a timeline read (AUTOMATION-SPEC §4.6)", async () => {
  const { mkdtemp, mkdir, rm, truncate, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { historyLimits } = await import("../shared/automation");
  const { forgetHistory } = await import("./provider-history");
  const home = await mkdtemp(join(tmpdir(), "flowly-turn-timeline-"));
  const thread = "019a0000-0000-7000-8000-000000000001";
  try {
    await mkdir(join(home, "archived_sessions"));
    const file = join(home, "archived_sessions", `rollout-2026-01-01T00-00-00-${thread}.jsonl`);
    await writeFile(file, "");
    await truncate(file, historyLimits.rotate + 1);
    vi.stubEnv("CODEX_HOME", home);
    forgetHistory();
    const refetch = vi.fn(async () => ({ entries: [{ item: { type: "user_message", text: "x" } }] }));
    const agent = { id: "big", provider: "codex", persistence: { provider: "codex", sessionId: thread } };
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent }), timeline: { refetch } }) } } as unknown as PaseoApi;
    expect(await turnTimeline(paseo, "big", [])).toEqual([]);
    expect(refetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    forgetHistory();
    await rm(home, { recursive: true, force: true });
  }
});
