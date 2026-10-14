import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { readSessionReceipts, markSessionRead } from "../shared/rpc";
import type { MarkSessionReadInput } from "../shared/session-attention";

export function useSessionReads() {
  const read = useRpc(readSessionReceipts),
    mark = useRpc(markSessionRead);
  const query = useQuery({
    queryKey: ["ultra", "sessionReads"],
    queryFn: () => read({}),
    refetchInterval: 5000,
  });
  return {
    query,
    receipts: query.data?.receipts || [],
    async markRead(input: MarkSessionReadInput) {
      const receipt = await mark(input);
      await query.refetch();
      return receipt;
    },
  };
}
