import type { Board } from "../shared/model";
import { handoffSource } from "./handoff-source";

/** Called on the same mutable snapshot as the authoritative board operation. */
export function markHandoffCommitted(board: Board, taskId: string, source: string) {
  const sourceId = handoffSource(source);
  if (board.handoffConfirmations?.some((entry) => entry.taskId === taskId && entry.sourceId === sourceId)) return false;
  (board.handoffConfirmations ??= []).push({ taskId, sourceId });
  return true;
}
