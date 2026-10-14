import { Pressable } from "react-native";
import { usePaseo, useRpc, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { readBoard, readSessionReceipts } from "../shared/rpc";
import { attentionBadgeText, attentionFromSources, attentionScreenParams } from "./attention";
import { listAgents } from "./resources";
import { CountPill, Theme } from "./ui";

/** Restrained background refresh; the board itself polls faster while open. */
const SIDEBAR_POLL_MS = 10_000;

/** Same sources and rule as the board Attention button; null while unavailable or failed. */
function useAttentionCount(hostId: string) {
  const read = useRpc(readBoard),
    reads = useRpc(readSessionReceipts),
    paseo = usePaseo();
  const poll = { refetchInterval: SIDEBAR_POLL_MS, retry: 1 } as const;
  const board = useQuery({
    queryKey: ["ultra", "sidebar", hostId, "board"],
    queryFn: () => read({}),
    ...poll,
  });
  const agents = useQuery({
    queryKey: ["ultra", "sidebar", hostId, "agents"],
    queryFn: () => listAgents(paseo),
    ...poll,
  });
  const receipts = useQuery({
    queryKey: ["ultra", "sidebar", hostId, "sessionReads"],
    queryFn: () => reads({}),
    ...poll,
  });
  const items = attentionFromSources({
    board: board.isError ? null : board.data,
    agents: agents.isError ? null : agents.data,
    receipts: receipts.data?.receipts || [],
    readUnavailable: receipts.isPending || receipts.isError,
  });
  return items ? items.length : null;
}

export function SidebarEntry({ currentScreen, openScreen, host, theme }: PluginSidebarItemProps) {
  const count = useAttentionCount(host.id);
  const text = attentionBadgeText(count);
  return (
    <SidebarRow
      icon="PanelsTopLeft"
      active={currentScreen?.screenId === "board"}
      onPress={() => openScreen({ screenId: "board" })}
      trailing={
        text ? (
          <Theme.Provider value={theme}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open needs attention, ${count} cards`}
              hitSlop={6}
              onPress={() =>
                openScreen({
                  screenId: "board",
                  params: attentionScreenParams(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
                })
              }
            >
              <CountPill text={text} />
            </Pressable>
          </Theme.Provider>
        ) : null
      }
    />
  );
}
