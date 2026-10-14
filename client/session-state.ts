import type { PaseoAgent } from "@getpaseo/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { BoardEvent } from "../shared/model";

export function sessionState(
  agent: Pick<
    PaseoAgent,
    | "id"
    | "status"
    | "archivedAt"
    | "pendingPermissions"
    | "attentionReason"
    | "lastUserMessageAt"
  >,
  events: readonly BoardEvent[] = [],
) {
  if (agent.archivedAt)
    return { label: "Archived", icon: "Archive", active: false };
  if (
    agent.pendingPermissions?.length ||
    agent.attentionReason === "permission"
  )
    return { label: "Waiting for approval", icon: "CircleHelp", active: false };
  if (agent.status === "error" || agent.attentionReason === "error")
    return { label: "Error", icon: "CircleAlert", active: false };
  if (agent.status === "initializing")
    return { label: "Starting", icon: "Loader", active: true };
  if (agent.status === "running")
    return { label: "Running", icon: "Loader", active: true };
  if (agent.status === "closed")
    return { label: "Closed", icon: "CircleStop", active: false };
  if (agent.attentionReason === "finished")
    return { label: "Finished turn", icon: "CircleCheck", active: false };
  const last = events
    .filter(
      (e) =>
        e.agentId === agent.id &&
        (e.action === "agent.turn_started" || e.action === "agent.turn_ended"),
    )
    .at(-1);
  if (
    last?.action === "agent.turn_ended" &&
    (!agent.lastUserMessageAt ||
      Date.parse(last.at) >= Date.parse(agent.lastUserMessageAt))
  )
    return { label: "Turn ended", icon: "CircleCheck", active: false };
  return {
    label: agent.lastUserMessageAt ? "Idle" : "Ready",
    icon: "CirclePause",
    active: false,
  };
}

export function openNativeSession(
  navigation: PluginSurfaceProps["navigation"],
  agentId: string,
  hostId: string,
): boolean {
  if (typeof navigation?.openAgent !== "function") return false;
  navigation.openAgent({ agentId, serverId: hostId });
  return true;
}

export function recentSessionOutput(
  entries: readonly {
    seq?: number;
    item: {
      type: string;
      text?: unknown;
      name?: unknown;
      status?: unknown;
      messageId?: unknown;
      callId?: unknown;
    };
  }[],
) {
  return entries
    .flatMap((entry, index) => {
      const { item } = entry;
      const tool = item.type === "tool_call" && typeof item.name === "string";
      const text = tool
        ? `${item.name} · ${typeof item.status === "string" ? item.status : "activity"}`
        : item.text;
      if (typeof text !== "string" || !text.trim()) return [];
      const author = item.type.includes("user")
        ? "You"
        : item.type.includes("assistant")
          ? "Agent"
          : item.type === "reasoning"
            ? "Thinking"
            : tool
              ? "Tool"
              : "Session";
      const identity = entry.seq ?? item.messageId ?? item.callId ?? index;
      return [
        {
          key: `${identity}-${item.type}`,
          author,
          text,
          kind: tool ? "tool" : item.type,
        },
      ];
    })
    .slice(-18);
}
