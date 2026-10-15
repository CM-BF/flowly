import { afterEach, expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { SessionSettingsService } from "./session-settings";
import { configureSession } from "../shared/rpc";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function setup(agent: Record<string, unknown>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-settings-")));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await store.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const calls: string[][] = [];
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent }) }) } } as unknown as PaseoApi;
  const service = new SessionSettingsService(store, async (_bin, args) => {
    calls.push(args);
    return "";
  }, async () => "/bin/paseo");
  return { service, paseo, calls };
}
const live = { id: "a1", workspaceId: "w", archivedAt: null, availableModes: [{ id: "plan" }, { id: "bypassPermissions" }] };

test("reasoning, permissions and stop go to the CLI as argument arrays", async () => {
  const x = await setup(live);
  const result = await x.service.apply({ taskId: "t", agentId: "a1", thinkingOptionId: "high", modeId: "plan", stop: true }, x.paseo);
  expect(result.applied).toEqual(["stopped", "reasoning", "permissions"]);
  expect(x.calls.map((c) => c.slice(0, 4))).toEqual([
    ["agent", "stop", "a1", "--home"],
    ["agent", "update", "a1", "--thinking"],
    ["agent", "mode", "a1", "plan"],
  ]);
  expect(x.calls[1][4]).toBe("high");
});

test("rejects other workspaces, archived sessions and unknown modes without running the CLI", async () => {
  for (const [agent, pattern] of [
    [{ ...live, workspaceId: "other" }, /different workspace/],
    [{ ...live, archivedAt: "2026-10-15T00:00:00Z" }, /Restore/],
  ] as const) {
    const x = await setup(agent);
    await expect(x.service.apply({ taskId: "t", agentId: "a1", modeId: "plan" }, x.paseo)).rejects.toThrow(pattern);
    expect(x.calls).toEqual([]);
  }
  const x = await setup(live);
  await expect(x.service.apply({ taskId: "t", agentId: "a1", modeId: "yolo" }, x.paseo)).rejects.toThrow(/not available/);
  expect(x.calls).toEqual([]);
});

test("RPC input refuses option-like IDs and empty changes", () => {
  const parse = (i: unknown) => configureSession.input.safeParse(i).success;
  expect(parse({ taskId: "t", agentId: "a1", thinkingOptionId: "high" })).toBe(true);
  expect(parse({ taskId: "t", agentId: "a1", thinkingOptionId: "--home" })).toBe(false);
  expect(parse({ taskId: "t", agentId: "-a", stop: true })).toBe(false);
  expect(parse({ taskId: "t", agentId: "a1" })).toBe(false);
});
