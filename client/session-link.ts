import { z } from "zod";
import type { PaseoApi } from "@getpaseo/client";
import type {
  PluginClientContext,
  PluginButtonRegistration,
  PluginScreenParams,
} from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { readBoard } from "../shared/rpc";
import { listAgents } from "./resources";

const id = z.string().min(1).max(200);
const linkSchema = z.object({
  taskId: id,
  sessionId: id,
  workspaceId: id,
  requestId: id,
});
export type CardSessionLink = z.infer<typeof linkSchema>;
export type SessionEntry = { sessionId: string; requestId: string };
export type LinkBoard = RpcOutput<typeof readBoard>;

export function parseSessionLink(
  params?: PluginScreenParams,
): CardSessionLink | null {
  if (
    !params ||
    !["taskId", "sessionId", "workspaceId", "requestId"].some(
      (key) => key in params,
    )
  )
    return null;
  const result = linkSchema.safeParse(params);
  if (!result.success)
    throw new Error(
      "Invalid Kanban session link. Open it again from the session chip.",
    );
  return result.data;
}
export function sessionLinkKey(link: CardSessionLink) {
  return JSON.stringify([
    link.taskId,
    link.sessionId,
    link.workspaceId,
    link.requestId,
  ]);
}

/** Prefix a failure with the step that produced it, so host toasts are diagnosable. */
async function step<T>(label: string, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${text}`);
  }
}

export async function resolveSessionLink(
  paseo: PaseoApi,
  read: () => Promise<LinkBoard>,
  link: CardSessionLink,
) {
  const [board, snapshot] = await Promise.all([
    step("Kanban board read failed", read),
    step("Session lookup failed", () => paseo.agents.ref(link.sessionId).refresh()),
  ]);
  const task = board?.tasks?.find(
    (t) => t.id === link.taskId && t.workspaceId === link.workspaceId,
  );
  const project = task
    ? board.projects?.find((p) => p.id === task.projectId)
    : undefined;
  const actor = snapshot?.agent;
  if (!task || !project)
    throw new Error(
      "This session's linked card is unavailable. Refresh the session chip or open Ultra Kanban.",
    );
  if (
    !actor ||
    actor.id !== link.sessionId ||
    actor.workspaceId !== task.workspaceId
  )
    throw new Error(
      "This session is unavailable or its workspace changed. Refresh the session chip.",
    );
  return { board, task, project, actor, link };
}

let requestSequence = 0;
const newRequestId = () => `${Date.now()}-${++requestSequence}`;

export function registerSessionChips(
  client: PluginClientContext,
  interval = 5000,
) {
  const registrations = new Map<
    string,
    { binding: string; chip: PluginButtonRegistration }
  >();
  const opening = new Set<string>();
  let disposed = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    latestClick = 0;
  function clear() {
    for (const { chip } of registrations.values()) chip.remove();
    registrations.clear();
  }
  // The board screen re-reads and validates the link before showing anything
  // (fail-closed), so the chip only navigates. Keeping SDK/RPC calls out of
  // the press handler avoids host-specific failures in the action context.
  async function open(link: CardSessionLink) {
    if (disposed) return;
    await step("Couldn't open Ultra Kanban", () =>
      client.openScreen({
        screenId: "board",
        params: { ...link, requestId: newRequestId() },
      }),
    );
  }
  async function refresh() {
    try {
      const results = await Promise.allSettled([
        client.rpc(readBoard, {}),
        listAgents(client.paseo, undefined, true),
      ]);
      if (disposed) return;
      const [boardResult, agentsResult] = results;
      if (
        boardResult.status !== "fulfilled" ||
        agentsResult.status !== "fulfilled"
      ) {
        clear();
        return;
      }
      const board = boardResult.value,
        agents = agentsResult.value;
      const tasks = new Map(
        board.tasks
          .filter((t) => board.projects.some((p) => p.id === t.projectId))
          .map((t) => [t.workspaceId, t]),
      );
      const found = new Set<string>();
      for (const actor of agents) {
        const task = actor.workspaceId
          ? tasks.get(actor.workspaceId)
          : undefined;
        if (!task) continue;
        found.add(actor.id);
        const binding = JSON.stringify([task.id, task.workspaceId]);
        let existing = registrations.get(actor.id);
        if (existing && existing.binding !== binding) {
          existing.chip.remove();
          registrations.delete(actor.id);
          existing = undefined;
        }
        const titleCharacters = Array.from(task.title);
        const button = {
          title: `Open Kanban task: ${task.title}`,
          label: `Task · ${titleCharacters.length > 28 ? titleCharacters.slice(0, 28).join("") + "…" : task.title}`,
          icon: "PanelsTopLeft",
          behavior: {
            kind: "action" as const,
            onPress: () =>
              open({
                taskId: task.id,
                workspaceId: task.workspaceId,
                sessionId: actor.id,
                requestId: newRequestId(),
              }),
          },
        };
        if (existing) existing.chip.update(button);
        else
          registrations.set(actor.id, {
            binding,
            chip: client.addComposerPill({
              id: "kanban-task",
              workspaceId: task.workspaceId,
              agentId: actor.id,
              button,
            }),
          });
      }
      for (const [agentId, registration] of registrations) {
        if (!found.has(agentId)) {
          registration.chip.remove();
          registrations.delete(agentId);
        }
      }
    } catch {
      if (!disposed) clear();
    } finally {
      if (!disposed)
        timer = setTimeout(() => {
          void refresh();
        }, interval);
    }
  }
  void refresh();
  return () => {
    disposed = true;
    latestClick++;
    clearTimeout(timer);
    clear();
  };
}
