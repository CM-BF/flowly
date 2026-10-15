import { z } from "zod";

/**
 * A session's recent timeline reduced to what the plugin shows (PERFORMANCE-SPEC
 * §3): projected tool calls carry full payloads (diffs, file contents, logs)
 * that the UI never reads, and every byte crosses the relay into the phone's JS
 * thread.
 */
export const tailItemSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  messageId: z.string().optional(),
  clientMessageId: z.string().optional(),
  callId: z.string().optional(),
});
export const tailEntrySchema = z.object({
  seqStart: z.number().optional(),
  timestamp: z.string().optional(),
  item: tailItemSchema,
});
export type TailEntry = z.infer<typeof tailEntrySchema>;

export const TAIL_TEXT_MAX = 12_000;
export const TAIL_REASONING_MAX = 2_000;

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function slimTimeline(
  entries: readonly { seqStart?: unknown; timestamp?: unknown; item?: unknown }[],
): TailEntry[] {
  return entries.flatMap((entry) => {
    const raw = entry.item as Record<string, unknown> | undefined;
    const type = str(raw?.type);
    if (!raw || !type) return [];
    const item: TailEntry["item"] = { type };
    const text = str(raw.text);
    if (text !== undefined) item.text = clip(text, type === "reasoning" ? TAIL_REASONING_MAX : TAIL_TEXT_MAX);
    for (const field of ["name", "status", "messageId", "clientMessageId", "callId"] as const) {
      const value = str(raw[field]);
      if (value !== undefined) item[field] = value;
    }
    const out: TailEntry = { item };
    if (typeof entry.seqStart === "number") out.seqStart = entry.seqStart;
    const timestamp = str(entry.timestamp);
    if (timestamp) out.timestamp = timestamp;
    return [out];
  });
}
