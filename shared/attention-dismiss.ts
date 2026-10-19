import { z } from "zod";

/** Dismissing a card from Attention until something new happens (ATTENTION-DISMISS-SPEC). */
export const attentionDismissLimits = { signals: 100, signal: 600, records: 10000 } as const;

const signalList = z
  .array(z.string().min(1).max(attentionDismissLimits.signal))
  .min(1)
  .max(attentionDismissLimits.signals)
  .refine((list) => new Set(list).size === list.length, "Duplicate attention signal.");

export const attentionDismissalSchema = z.object({
  taskId: z.string().min(1).max(200),
  signals: signalList,
  dismissedAt: z.string().datetime(),
});
export type AttentionDismissal = z.infer<typeof attentionDismissalSchema>;

export const attentionDismissInput = z.strictObject({
  taskId: z.string().min(1).max(200),
  signals: signalList,
});
export type AttentionDismissInput = z.infer<typeof attentionDismissInput>;
export const attentionRestoreInput = z.strictObject({ taskId: z.string().min(1).max(200) });
export type AttentionRestoreInput = z.infer<typeof attentionRestoreInput>;

/** One session's attention, as counted by Attention; each part is one concrete thing to deal with. */
export interface SessionSignals {
  agent: {
    id: string;
    attentionTimestamp?: string | null;
    lastUserMessageAt?: string | null;
  };
  /** The open Kanban question event, if any. */
  questionEventId: string | null;
  /** Pending permission/question request IDs; empty when the host omits them. */
  requestIds: readonly string[];
  permission: boolean;
  error: boolean;
  unread: boolean;
  /** Native attention token of the unread generation; null when unknown. */
  token: string | null;
  manualUnread: boolean;
}

/**
 * Stable identities of what a session is waiting on: a new question, request,
 * error or finished turn gets a new key (§2.2).
 */
export function sessionSignalKeys(s: SessionSignals): string[] {
  const id = s.agent.id,
    keys: string[] = [];
  if (s.questionEventId) keys.push(`q:${s.questionEventId}`);
  if (s.permission || s.requestIds.length) {
    if (s.requestIds.length) for (const r of s.requestIds) keys.push(`p:${id}:${r}`);
    else keys.push(`p:${id}:${s.agent.attentionTimestamp || ""}`);
  }
  if (s.error) keys.push(`e:${id}:${s.agent.attentionTimestamp || "status"}`);
  if (s.unread)
    keys.push(
      s.manualUnread ? `u:${id}:manual` : s.token ? `u:${s.token}` : `u:${id}:${s.agent.lastUserMessageAt || ""}`,
    );
  return keys;
}

/** Hidden while every current signal was already there when the card was dismissed (§2.3). */
export function isDismissed(signals: readonly string[], record: Pick<AttentionDismissal, "signals"> | undefined | null) {
  if (!record || !signals.length) return false;
  const seen = new Set(record.signals);
  return signals.every((s) => seen.has(s));
}

/** The signal list to store: unique, bounded, order kept. */
export function dismissalSignals(signals: readonly string[]) {
  return [...new Set(signals)].slice(0, attentionDismissLimits.signals);
}
