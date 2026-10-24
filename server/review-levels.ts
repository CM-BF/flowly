import { resolveReviewLevel as resolve, reviewPlan as plan, classificationHash, type LevelBoard, type LevelCard } from "../shared/review-levels";
import type { AutomationSettings, LevelReason, ReviewLevel } from "../shared/automation-schema";
import { deepKeyword } from "./review-keywords";
export { deepKeyword } from "./review-keywords";

/** The old rule is now only a fallback, and never shipped to the client. */
export function keywordFallback(board: LevelBoard, card: LevelCard): { level: ReviewLevel; reason: LevelReason } {
  const acceptance = board.workpads?.find((w) => w.taskId === card.id)?.acceptance.map((item) => item.text).join("\n") ?? "";
  for (const [field, text] of [["title", card.title], ["description", card.description], ["acceptance", acceptance]] as const) {
    const keyword = deepKeyword(text);
    if (keyword) return { level: "deep", reason: { kind: "keyword", keyword, field } };
  }
  return { level: "standard", reason: { kind: "default" } };
}
export function withFallback(board: LevelBoard, card: LevelCard): LevelCard {
  const inputHash = classificationHash(board, card);
  if (card.reviewClassification?.inputHash === inputHash) return card;
  return { ...card, reviewClassification: { inputHash, status: "failed", at: "", fallback: keywordFallback(board, card) } };
}
export const resolveReviewLevel = (board: LevelBoard, card: LevelCard) => resolve(board, withFallback(board, card));
export const reviewPlan = (settings: AutomationSettings, board: LevelBoard, card: LevelCard, round: number) => plan(settings, board, withFallback(board, card), round);
