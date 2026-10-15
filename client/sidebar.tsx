import { Pressable } from "react-native";
import { useRpc, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { readSessionReceipts } from "../shared/rpc";
import { attentionBadgeText, attentionFromSources, attentionScreenParams } from "./attention";
import { useBoardQuery, useLiveAgents } from "./queries";
import { CountPill, Theme } from "./ui";

/**
 * Restrained background refresh. The queries share the board's keys, so while
 * the board is open both read one cache (the board's faster interval wins).
 */
const SIDEBAR_POLL_MS = 15_000;

/** Same sources and rule as the board Attention button; null while unavailable or failed. */
function useAttentionCount() {
  const reads = useRpc(readSessionReceipts);
  const poll = { refetchInterval: SIDEBAR_POLL_MS, retry: 1 } as const;
  // Unchanged boards cost an etag round trip; no live agent stream for a badge.
  const board = useBoardQuery(poll);
  const agents = useLiveAgents({ ...poll, stream: false });
  const receipts = useQuery({
    queryKey: ["ultra", "sessionReads"],
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

export function SidebarEntry({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const count = useAttentionCount();
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
              accessibilityLabel={`Open Needs attention, ${text} ${count === 1 ? "card" : "cards"}`}
              hitSlop={10}
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
