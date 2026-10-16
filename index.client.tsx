import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BoardScreen, WorkspaceBoard } from "./client/board";
import { registerSessionChips } from "./client/session-link";
import { SidebarEntry } from "./client/sidebar";
import { intentParams, type BoardIntent } from "./client/shortcuts";
import { deviceLocale, msg, setLocale, t } from "./shared/i18n";

const intentItems: { intent: BoardIntent; title: string; icon: string; keywords: string[] }[] = [
  { intent: "new-task", title: msg("Flowly: New task"), icon: "Plus", keywords: ["kanban", "card", "create"] },
  { intent: "projects", title: msg("Flowly: Switch project"), icon: "Folder", keywords: ["kanban", "project"] },
  { intent: "filters", title: msg("Flowly: Search and filter tasks"), icon: "ListFilter", keywords: ["kanban", "search", "filter"] },
  { intent: "attention", title: msg("Flowly: Needs attention"), icon: "Bell", keywords: ["kanban", "attention", "unread", "approval"] },
  { intent: "shortcuts", title: msg("Flowly: Keyboard shortcuts"), icon: "Keyboard", keywords: ["kanban", "keyboard", "hotkey", "help"] },
  { intent: "welcome", title: msg("Flowly: Welcome tour"), icon: "CircleHelp", keywords: ["kanban", "welcome", "tour", "onboarding", "help", "guide"] },
];

export default function contribute(client: PluginClientContext) {
  // Command Center entries are registered once, before any setting can be read: they follow the device language.
  setLocale(deviceLocale());
  client.addScreen({
    id: "board",
    title: "Flowly",
    Component: BoardScreen,
  });
  client.addSidebarHeaderItem({
    id: "board",
    title: "Flowly",
    Component: SidebarEntry,
  });
  client.addWorkspacePanel({
    id: "board",
    title: "Flowly",
    icon: "PanelsTopLeft",
    context: "workspace",
    Component: WorkspaceBoard,
  });
  client.addCommandCenterItem({
    id: "open-board",
    title: t("Open Flowly"),
    icon: "PanelsTopLeft",
    context: "global",
    onSelect: ({ openScreen }) => openScreen({ screenId: "board" }),
  });
  for (const item of intentItems)
    client.addCommandCenterItem({
      id: `board-${item.intent}`,
      title: t(item.title),
      icon: item.icon,
      keywords: item.keywords,
      context: "global",
      onSelect: ({ openScreen }) =>
        openScreen({ screenId: "board", params: intentParams(item.intent) }),
    });
  client.addCommandCenterItem({
    id: "workspace-board",
    title: t("Open workspace card"),
    icon: "PanelsTopLeft",
    context: "workspace",
    onSelect: ({ openPanel }) => openPanel("board"),
  });
  return registerSessionChips(client);
}
