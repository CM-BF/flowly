import { afterEach, expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { SessionTailService } from "./session-tail";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function setup(agentWorkspace: string | null, refreshed = "w") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-tail-")));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await store.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const calls: unknown[] = [];
  const paseo = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { id: "a", workspaceId: refreshed } }),
        timeline: {
          refetch: async (options: unknown) => {
            calls.push(options);
            return {
              agent: agentWorkspace ? { id: "a", workspaceId: agentWorkspace } : null,
              entries: [{ seqStart: 3, item: { type: "tool_call", name: "edit", status: "completed", detail: { content: "big" } } }],
            };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  return { service: new SessionTailService(store), paseo, calls };
}

test("returns the slim projected tail of a card session", async () => {
  const x = await setup("w");
  const result = await x.service.tail({ taskId: "t", agentId: "a", limit: 35 }, x.paseo);
  expect(result).toEqual({ entries: [{ seqStart: 3, item: { type: "tool_call", name: "edit", status: "completed" } }] });
  expect(x.calls).toEqual([{ direction: "tail", limit: 35, projection: "projected" }]);
});

test("refuses sessions of another workspace and unknown cards", async () => {
  const x = await setup("other");
  await expect(x.service.tail({ taskId: "t", agentId: "a", limit: 5 }, x.paseo)).rejects.toThrow(/different workspace/);
  // Without an agent in the timeline response, the refreshed snapshot decides.
  const y = await setup(null, "other");
  await expect(y.service.tail({ taskId: "t", agentId: "a", limit: 5 }, y.paseo)).rejects.toThrow(/different workspace/);
  const z = await setup(null, "w");
  await expect(z.service.tail({ taskId: "t", agentId: "a", limit: 5 }, z.paseo)).resolves.toBeTruthy();
  await expect(z.service.tail({ taskId: "missing", agentId: "a", limit: 5 }, z.paseo)).rejects.toThrow(/Task not found/);
});
