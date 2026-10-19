import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { BoardStore } from "./store";
import { ToolSecrets } from "./tool-context";
import { AgentService } from "./agent-service";

// Test fixture only; runtime entries never import this module.
export async function agentFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "flowly-agent-test-")),
  );
  const a = join(root, "a"),
    b = join(root, "b");
  await mkdir(a);
  await mkdir(b);
  const store = new BoardStore(join(root, "data")),
    stamp = new Date().toISOString();
  await store.mutate((board) => {
    board.projects.push({
      id: "p",
      paseoProjectId: "native",
      title: "Project",
      description: "",
      primaryPath: a,
      repos: [a, b],
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null,
    });
    board.tasks.push({
      id: "t",
      projectId: "p",
      workspaceId: "w",
      sourcePath: a,
      repoPaths: [],
      title: "Card",
      description: "",
      status: "todo",
      priority: "normal",
      position: 0,
      revision: 1,
      operationId: "create",
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null,
    });
  });
  let now = Date.now();
  const secrets = new ToolSecrets(store.directory, () => now);
  await secrets.initialize();
  const identity = { agentId: "actor", taskId: "t", workspaceId: "w" };
  const actors: Record<
    string,
    {
      id: string;
      workspaceId: string;
      title: string;
      status: string;
      archivedAt: string | null;
    }
  > = {
    actor: {
      id: "actor",
      workspaceId: "w",
      title: "First actor",
      status: "idle",
      archivedAt: null,
    },
    second: {
      id: "second",
      workspaceId: "w",
      title: "Second actor",
      status: "idle",
      archivedAt: null,
    },
    wrong: {
      id: "wrong",
      workspaceId: "different-workspace",
      title: "Wrong",
      status: "idle",
      archivedAt: null,
    },
  };
  let workspace: {
    id: string;
    projectId: string;
    projectDisplayName: string;
    workspaceDirectory: string;
    workspaceKind: string;
    status: string;
    archivingAt: string | null;
  } | null = {
    id: "w",
    projectId: "foreign-owner",
    projectDisplayName: "Foreign owner",
    workspaceDirectory: a,
    workspaceKind: "directory",
    status: "done",
    archivingAt: null,
  };
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => (actors[id] ? { agent: actors[id] } : null),
      }),
      list: async () => ({
        entries: Object.values(actors).map((agent) => ({ agent })),
        pageInfo: { nextCursor: null },
      }),
    },
    workspaces: { ref: () => ({ refresh: async () => workspace }) },
  } as unknown as PaseoApi;
  const service = new AgentService(store, secrets, () => now);
  service.attach(paseo);
  return {
    root,
    a,
    b,
    store,
    secrets,
    identity,
    actors,
    paseo,
    service,
    advance: (ms: number) => {
      now += ms;
    },
    setWorkspace: (value: typeof workspace) => {
      workspace = value;
    },
    workspace: () => workspace!,
  };
}
