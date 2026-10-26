import { isLive, type AutomationJob } from "../shared/automation";
import { msg } from "../shared/i18n";
import type { HandoffIndex } from "./task-handoff";

/**
 * How the card's handoff record reads to a person (SESSION-HANDOFF-SPEC §12): `recorded` (current), `check` (behind,
 * and it matters now) or `settled` (behind later activity, but nothing is unresolved and no agent is about to continue
 * from it, e.g. a delivered or approved card). The next agent always gets the staleness itself (`due`, `HANDOFF_STALE`).
 */
export type HandoffTone = "recorded" | "settled" | "check";
export type HandoffSignal = HandoffIndex & { tone: HandoffTone };
export const handoffToneLabels: Record<HandoffTone, string> = { recorded: msg("Handoff recorded"), settled: msg("Handoff recorded before later activity"), check: msg("Handoff needs checking") };

/** An agent is working on the card, or will continue from its record: a live job, a routed comment, a rotation. */
export function continuationPending(job: AutomationJob | undefined, task: { status: string }) {
  if (!job || task.status === "done" || task.status === "cancelled") return false;
  return isLive(job) || !!job.rotation || !!job.rotateRequested || !!job.pendingInputs?.length;
}
export function handoffTone(index: Pick<HandoffIndex, "fresh" | "open">, pending: boolean, ackRequired = false): HandoffTone {
  if (index.fresh) return "recorded";
  return index.open > 0 || ackRequired || pending ? "check" : "settled";
}
export function handoffSignal(index: HandoffIndex | undefined, job: AutomationJob | undefined, task: { status: string }): HandoffSignal | undefined {
  return index && { ...index, tone: handoffTone(index, continuationPending(job, task)) };
}
