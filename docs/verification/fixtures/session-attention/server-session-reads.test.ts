import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionReadStore } from "../../../../server/session-reads";

const directories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "kanban-session-attention-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SessionReadStore serialized persistence", () => {
  test("serializes same-generation concurrent marks and keeps idempotent bytes/readAt", async () => {
    const directory = await temporaryDirectory();
    const reads = new SessionReadStore(directory);
    const boardBytes = '{"fixture":"board stays byte-identical"}';
    await writeFile(join(directory, "board.json"), boardBytes);
    const input = { taskId: "task", agentId: "agent", token: "generation-1" };
    const validate = async () => ({ workspaceId: "workspace", token: "generation-1" });
    const [first, concurrent] = await Promise.all([reads.mark(input, validate), reads.mark(input, validate)]);
    expect(concurrent).toEqual(first);
    const bytes = await readFile(reads.path, "utf8");
    expect(await reads.mark(input, validate)).toEqual(first);
    expect(await readFile(reads.path, "utf8")).toBe(bytes);
    expect(await readFile(join(directory, "board.json"), "utf8")).toBe(boardBytes);
    const reopened = new SessionReadStore(directory);
    expect(await reopened.read()).toEqual({ version: 1, receipts: [first] });
  });

  test("rejects stale retries without overwriting a newer generation", async () => {
    const reads = new SessionReadStore(await temporaryDirectory());
    const older = { taskId: "task", agentId: "agent", token: "old" };
    const current = { workspaceId: "workspace", token: "old" };
    await reads.mark(older, async () => current);
    current.token = "new";
    const newer = { ...older, token: "new" };
    await reads.mark(newer, async () => current);
    await expect(reads.mark(older, async () => current)).rejects.toThrow(/attention changed/i);
    expect((await reads.read()).receipts).toHaveLength(1);
    expect((await reads.read()).receipts[0].token).toBe("new");
  });

  test("validates membership for an idempotent retry and rejects unknown native generation", async () => {
    const reads = new SessionReadStore(await temporaryDirectory());
    const input = { taskId: "task", agentId: "agent", token: "t" };
    await reads.mark(input, async () => ({ workspaceId: "workspace", token: "t" }));
    await expect(reads.mark(input, async () => { throw new Error("Session belongs to a different workspace."); })).rejects.toThrow(/different workspace/);
    await expect(reads.mark({ ...input, token: "unknown" }, async () => ({ workspaceId: "workspace", token: null }))).rejects.toThrow(/no current acknowledgeable/);
  });

  test("preserves invalid persisted data and does not create a replacement", async () => {
    const directory = await temporaryDirectory();
    const reads = new SessionReadStore(directory);
    const invalid = '{broken store bytes\n';
    await writeFile(reads.path, invalid);
    await expect(reads.read()).rejects.toThrow(/preserved at/);
    await expect(reads.mark({ taskId: "task", agentId: "agent", token: "t" }, async () => ({ workspaceId: "workspace", token: "t" }))).rejects.toThrow(/preserved at/);
    expect(await readFile(reads.path, "utf8")).toBe(invalid);
  });

  test("accepts every non-archiving Paseo workspace state and rejects archivingAt", async () => {
    const { SessionReadService } = await import("../../../../server/session-reads");
    const { BoardStore } = await import("../../../../server/store");
    const directory = await temporaryDirectory();
    const boardDirectory = join(directory, "board");
    const task = {
      id: "task", projectId: "project", workspaceId: "workspace", sourcePath: "/fixture", repoPaths: ["/fixture"],
      title: "Fixture", description: "", status: "todo", priority: "normal", position: 0, revision: 1,
      operationId: "op", createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", archivedAt: null,
    };
    const project = {
      id: "project", title: "Fixture", description: "", paseoProjectId: "native-project", primaryPath: "/fixture", repos: ["/fixture"],
      revision: 1, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", archivedAt: null,
    };
    await import("node:fs/promises").then(({ mkdir }) => mkdir(boardDirectory, { recursive: true }));
    await writeFile(join(boardDirectory, "board.json"), JSON.stringify({ version: 3, revision: 3, projects: [project], tasks: [task], events: [], agentReceipts: [] }));
    const board = new BoardStore(boardDirectory);
    const reads = new SessionReadStore(join(directory, "reads"));
    const service = new SessionReadService(board, reads);
    const input = { taskId: "task", agentId: "agent", token: "" };
    const statuses = ["running", "attention", "needs_input", "failed", "done"];
    for (const [index, status] of statuses.entries()) {
      const timestamp = `2026-10-14T01:0${index}:00.000Z`;
      input.token = JSON.stringify(["agent", "finished", timestamp]);
      const paseo = {
        agents: { ref: () => ({ refresh: async () => ({ agent: {
          id: "agent", workspaceId: "workspace", status: "idle", archivedAt: null,
          requiresAttention: true, attentionReason: "finished", attentionTimestamp: timestamp,
        } }) }) },
        workspaces: { ref: () => ({ refresh: async () => ({ id: "workspace", status, archivingAt: null }) }) },
      } as any;
      await service.mark(input, paseo);
    }
    const archivingTimestamp = "2026-10-14T02:00:00.000Z";
    const archiving = {
      agents: { ref: () => ({ refresh: async () => ({ agent: {
        id: "agent", workspaceId: "workspace", status: "idle", archivedAt: null, requiresAttention: true,
        attentionReason: "finished", attentionTimestamp: archivingTimestamp,
      } }) }) },
      workspaces: { ref: () => ({ refresh: async () => ({ id: "workspace", status: "running", archivingAt: "2026-10-14T02:00:00.000Z" }) }) },
    } as any;
    const before = await reads.read();
    await expect(service.mark({ ...input, token: JSON.stringify(["agent", "finished", archivingTimestamp]) }, archiving)).rejects.toThrow(/workspace is unavailable/i);
    expect(await reads.read()).toEqual(before);
  });
});
