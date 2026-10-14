import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BoardScreen, WorkspaceBoard } from "./client/board";
import { registerSessionChips } from "./client/session-link";
import { SidebarEntry } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "board",
    title: "Ultra Kanban",
    Component: BoardScreen,
  });
  client.addSidebarHeaderItem({
    id: "board",
    title: "Ultra Kanban",
    Component: SidebarEntry,
  });
  client.addWorkspacePanel({
    id: "board",
    title: "Ultra Kanban",
    icon: "PanelsTopLeft",
    context: "workspace",
    Component: WorkspaceBoard,
  });
  client.addCommandCenterItem({
    id: "open-board",
    title: "Open Ultra Kanban",
    icon: "PanelsTopLeft",
    context: "global",
    onSelect: ({ openScreen }) => openScreen({ screenId: "board" }),
  });
  client.addCommandCenterItem({
    id: "workspace-board",
    title: "Open workspace card",
    icon: "PanelsTopLeft",
    context: "workspace",
    onSelect: ({ openPanel }) => openPanel("board"),
  });
  return registerSessionChips(client);
}
