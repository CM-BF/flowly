import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BoardStore, columnOrder } from "./server/store";
import { BoardService, dataDirectory } from "./server/service";
import * as rpc from "./shared/rpc";
import { boardViewSettings } from "./shared/settings";
import { ToolServer } from "./server/tool-server";
import { SessionReadStore, SessionReadService } from "./server/session-reads";
import { WrapupService } from "./server/wrapup";
import { SessionImageService } from "./server/session-images";
import { ComposerService, ComposerStore } from "./server/composer";
import { SessionSettingsService } from "./server/session-settings";
import { applyTurnEnded, applyTurnStarted, recordLifecycle } from "./server/progress-rules";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(boardViewSettings);
  const store = new BoardStore(dataDirectory());
  const service = new BoardService(store);
  const sessionReads = new SessionReadStore(store.directory);
  const readService = new SessionReadService(store, sessionReads);
  server.handle(rpc.readSessionReceipts, () => sessionReads.read());
  server.handle(rpc.markSessionRead, (input, { paseo }) =>
    readService.mark(input, paseo),
  );
  const composer = new ComposerService(new ComposerStore(store.directory), store);
  server.handle(rpc.readComposer, (_, { paseo }) => {
    void composer.drainAll(paseo).catch(() => undefined);
    return composer.read();
  });
  server.handle(rpc.saveDraft, (input) => composer.saveDraft(input));
  server.handle(rpc.queueMessage, (input, { paseo }) => composer.push(input, paseo));
  server.handle(rpc.unqueueMessage, (input) => composer.remove(input));
  server.handle(rpc.sendQueuedNow, (input, { paseo }) => composer.sendNow(input, paseo));
  const images = new SessionImageService(store);
  server.handle(rpc.sessionImage, (input, { paseo }) => images.read(input, paseo));
  const wrapups = new WrapupService(store);
  const sessionSettings = new SessionSettingsService(store);
  server.handle(rpc.configureSession, (input, { paseo }) => sessionSettings.apply(input, paseo));
  server.handle(rpc.wrapupCheck, (input, { paseo }) =>
    wrapups.check(input.id, paseo),
  );
  server.handle(rpc.wrapup, (input, { paseo }) => wrapups.run(input, paseo));
  const tools = new ToolServer(store);
  void tools
    .start()
    .catch((e) =>
      console.error(
        "Kanban tools unavailable:",
        e instanceof Error ? e.message : String(e),
      ),
    );
  server.handle(rpc.readBoard, (_, { paseo }) => {
    tools.attach(paseo);
    return store.view();
  });
  server.handle(rpc.managedSessions, () => tools.secrets.managedSessions());
  server.handle(rpc.toolsHealth, async (_, { paseo }) => {
    tools.attach(paseo);
    await tools.start().catch(() => undefined);
    return tools.health();
  });
  server.handle(rpc.prepareSession, (input, { paseo }) =>
    tools.prepareSession(input.id, input.operationId, paseo),
  );
  server.handle(rpc.prepareExisting, (input, { paseo }) =>
    tools.prepareExisting(input.id, input.agentId, paseo),
  );
  server.handle(rpc.accessState, (input, { paseo }) =>
    tools.accessState(input.id, input.agentId, paseo),
  );
  server.handle(rpc.listResources, (_, { paseo }) => service.resources(paseo));
  server.handle(rpc.createProject, (input, { paseo }) =>
    service.createProject(input, paseo),
  );
  server.handle(rpc.createTask, (input, { paseo }) =>
    service.createTask(input, paseo),
  );
  server.handle(rpc.taskContext, (input, { paseo }) =>
    service.context(input.id, paseo),
  );
  server.handle(rpc.updateTask, (input) => store.editTask(input));
  server.handle(rpc.placeTask, (input) => store.placeTask(input));
  server.handle(rpc.updateProject, (input) => {
    return store.mutate((board) => {
      const p = board.projects.find((p) => p.id === input.id);
      if (!p) throw new Error("Project not found.");
      if (p.revision !== input.revision)
        throw new Error("Revision conflict: reload the project before saving.");
      if (input.title !== undefined) p.title = input.title;
      if (input.description !== undefined) p.description = input.description;
      if (input.autoStatus !== undefined) p.autoStatus = input.autoStatus;
      if (input.archived !== undefined)
        p.archivedAt = input.archived ? new Date().toISOString() : null;
      p.revision++;
      p.updatedAt = new Date().toISOString();
      return p;
    });
  });
  // Menu up/down shares the drag placement path: one ordering rule, and only
  // the moved card's revision changes.
  server.handle(rpc.moveTask, async (input) => {
    const board = await store.read();
    const task = board.tasks.find((t) => t.id === input.id);
    if (!task) throw new Error("Task not found.");
    const visible = board.tasks
      .filter(
        (t) =>
          t.projectId === task.projectId &&
          t.status === task.status &&
          !t.archivedAt,
      )
      .sort(columnOrder);
    const index = visible.findIndex((t) => t.id === task.id);
    const other = visible[index + (input.direction === "up" ? -1 : 1)];
    if (!other) {
      if (task.revision !== input.revision)
        throw new Error("Revision conflict: reload before moving.");
      return task;
    }
    return store.placeTask({
      id: task.id,
      revision: input.revision,
      status: task.status,
      beforeId: input.direction === "up" ? other.id : null,
      afterId: input.direction === "up" ? null : other.id,
    });
  });
  // Lifecycle facts are recorded, and status rules run, only for
  // Kanban-managed sessions (AUTO-STATUS-SPEC).
  const managedTask = async (agent: { id: string; workspaceId: string | null }) => {
    const identity = await tools.secrets.managedIdentity(agent.id);
    if (!identity || identity.workspaceId !== agent.workspaceId) return null;
    return identity;
  };
  server.on("agent.turn_started", async (event, { paseo }) => {
    tools.attach(paseo);
    const identity = await managedTask(event.agent);
    if (!identity) return;
    await store.mutate((board) => {
      recordLifecycle(store, board, identity, "agent.turn_started");
      applyTurnStarted(store, board, identity, event.agent.title);
    });
  });
  server.on("agent.turn_ended", async (event, { paseo }) => {
    tools.attach(paseo);
    const identity = await managedTask(event.agent);
    if (!identity) return;
    await store.mutate((board) => {
      recordLifecycle(store, board, identity, "agent.turn_ended", event.outcome);
      applyTurnEnded(store, board, identity, event.outcome);
    });
  });
  // Queued follow-ups go out when any session's turn ends (Paseo "queue").
  server.on("agent.turn_ended", async (event, { paseo }) => {
    if (event.outcome.kind !== "failed") await composer.drain(event.agent.id, paseo).catch(() => undefined);
  });
  server.on("agent.permission_requested", async (event, { paseo }) => {
    tools.attach(paseo);
    const identity = await managedTask(event.agent);
    if (!identity) return;
    await store.mutate((board) =>
      recordLifecycle(store, board, identity, "agent.permission_requested"),
    );
  });
  console.log("Ultra Kanban store ready:", store.directory);
  server.before("agent.session_open", async ({ request }, { paseo }) => {
    tools.attach(paseo);
    if (request.purpose !== "interactive") return;
    try {
      const contextFile = await tools.sessionContext(
        request.agentId,
        request.workspaceId,
        paseo,
      );
      if (contextFile)
        return {
          ...request,
          env: {
            ...request.env,
            ULTRA_KANBAN_CONTEXT_FILE: contextFile,
            ULTRA_KANBAN_CLI: store.directory + "/ultra-kanban.mjs",
            ULTRA_KANBAN_SKILL: store.directory + "/SKILL.md",
          },
        };
    } catch (e) {
      console.error(
        "Kanban session CLI unavailable:",
        e instanceof Error ? e.message : String(e),
      );
    }
  });
  return () => tools.stop();
}
