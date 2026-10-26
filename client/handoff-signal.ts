import { isLive, type AutomationJob } from "../shared/automation";
import { msg } from "../shared/i18n";
import type { HandoffIndex } from "./task-handoff";

/**
 * How the card's handoff record reads to a person (SESSION-HANDOFF-SPEC §12): `recorded` (current, or only a successor's
 * acknowledgement is missing), `settled` (behind changes after the agent's checkpoint), `unwritten` (no agent wrote one)
 * or `check` (a warning). The neutral tones need nothing unresolved, no agent about to continue from the record and a
 * readable record; anything that could not be checked is a warning. The next agent always gets the staleness itself
 * (`due`, `HANDOFF_STALE`). The drawer, its section summary and the card face all use `handoffTone`.
 */
export type HandoffTone = "recorded" | "settled" | "unwritten" | "check";
export type HandoffSignal = HandoffIndex & { tone: HandoffTone };
export const handoffToneLabels: Record<HandoffTone, string> = { recorded: msg("Handoff recorded"), settled: msg("Handoff recorded before later activity"), unwritten: msg("No agent handoff written"), check: msg("Handoff needs checking") };

/** An agent will continue from the card's record: a live job, a routed comment, a rotation, a requested fresh session. */
export function continuationPending(job: AutomationJob | undefined, task: { status: string }) {
  if (!job || task.status === "done" || task.status === "cancelled") return false;
  return isLive(job) || !!job.rotation || !!job.rotateRequested || !!job.pendingInputs?.length;
}
const neutral: Record<NonNullable<HandoffIndex["behind"]>, HandoffTone> = { ack: "recorded", activity: "settled", unwritten: "unwritten", unverified: "check" };
/** `unavailable`: the drawer could not read the record. An index entry without `behind` (written earlier) reads as `activity`. */
export function handoffTone(index: Pick<HandoffIndex, "fresh" | "open" | "behind">, pending: boolean, unavailable = false): HandoffTone {
  if (unavailable) return "check";
  if (index.fresh) return "recorded";
  return index.open > 0 || pending ? "check" : neutral[index.behind ?? "activity"];
}
export function handoffSignal(index: HandoffIndex | undefined, job: AutomationJob | undefined, task: { status: string }): HandoffSignal | undefined {
  return index && { ...index, tone: handoffTone(index, continuationPending(job, task)) };
}
