import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { BoardScreen, WorkspaceBoard } from "./client/board";
import { registerSessionChips } from "./client/session-link";
import { intentParams, type BoardIntent } from "./client/shortcuts";

const intentItems: { intent: BoardIntent; title: string; icon: string; keywords: string[] }[] = [
  { intent: "new-task", title: "Ultra Kanban: New task", icon: "Plus", keywords: ["kanban", "card", "create"] },
  { intent: "projects", title: "Ultra Kanban: Switch project", icon: "Folder", keywords: ["kanban", "project"] },
  { intent: "filters", title: "Ultra Kanban: Search and filter tasks", icon: "ListFilter", keywords: ["kanban", "search", "filter"] },
  { intent: "attention", title: "Ultra Kanban: Needs attention", icon: "Bell", keywords: ["kanban", "attention", "unread", "approval"] },
  { intent: "shortcuts", title: "Ultra Kanban: Keyboard shortcuts", icon: "Keyboard", keywords: ["kanban", "keyboard", "hotkey", "help"] },
];

function Sidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="PanelsTopLeft"
      active={currentScreen?.screenId === "board"}
      onPress={() => openScreen({ screenId: "board" })}
    />
  );
}
export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "board",
    title: "Ultra Kanban",
    Component: BoardScreen,
  });
  client.addSidebarHeaderItem({
    id: "board",
    title: "Ultra Kanban",
    Component: Sidebar,
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
  for (const item of intentItems)
    client.addCommandCenterItem({
      id: `board-${item.intent}`,
      title: item.title,
      icon: item.icon,
      keywords: item.keywords,
      context: "global",
      onSelect: ({ openScreen }) =>
        openScreen({ screenId: "board", params: intentParams(item.intent) }),
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
