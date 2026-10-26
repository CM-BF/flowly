import { open } from "node:fs/promises";
import { redactCaptureText } from "./handoff-capture-records";

/**
 * For the one-time gap migration (SESSION-HANDOFF-SPEC §21.17): where in a session's provider history the older builds
 * (684a8fd, 786d9cd) would have raised a gap of a kind, by their own rules. Those builds kept 100 gaps per capture pass and
 * only counted the rest, so a pass that hit the cap left fewer entries than occurrences; this finds every one in the bytes
 * that pass read. Read only; it never writes, follows only the path the ledger's cursor names, and refuses a file that is not
 * the one the cursor names.
 */
export type LegacyCountKind = "opaque_tool_background" | "unknown_record_type" | "unknown_event_type" | "unknown_response_type";
export const legacyCountKinds: ReadonlySet<string> = new Set<LegacyCountKind>(["opaque_tool_background", "unknown_record_type", "unknown_event_type", "unknown_response_type"]);
export type LegacyHistoryQuery = { path: string; identity: string; end: number; provider: "codex" | "claude"; targets: readonly { kind: LegacyCountKind; hint?: string }[] };
/** The line offsets per target (in the order of `targets`), or null when the file is gone, is not the cursor's file, is shorter than `end` or too large. */
export type LegacyHistory = (query: LegacyHistoryQuery) => Promise<number[][] | null>;

/** The older builds' bounds: a line over 256 KiB (newline included) was skipped as a long line, unparsed. */
const lineLimit = 256 * 2 ** 10, maxBytes = 256 * 2 ** 20, chunkBytes = 2 ** 20;
/** Tools those builds itemized (their background table); any other call named `exec` or `Workflow` was an opaque script. */
const itemized = ["register_async_shell", "cancel_async_shell", "Bash", "exec_command", "write_stdin", "browser_new_tab", "close_tab", "browser_close_tab", "create_terminal", "start_workspace_script", "create_agent", "spawn_agent", "create_schedule", "delete_schedule", "cancel_schedule", "create_heartbeat", "delete_heartbeat", "cancel_heartbeat"];
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" ? value : "";
const opaque = (name: string) => !itemized.some((known) => name === known || name.endsWith(`__${known}`) || name.endsWith(`.${known}`)) && ["exec", "Workflow"].includes(name.split(".").pop() ?? "");
const typeHint = (value: unknown) => redactCaptureText(string(value)).slice(0, 80) || "unknown";

/** Which targets one record matches, by the rules of 786d9cd's `CaptureRecords.providerLine` and `call`. */
function matches(provider: "codex" | "claude", entry: Record<string, unknown>, targets: LegacyHistoryQuery["targets"]) {
  const type = typeHint(entry.type), payload = object(entry.payload);
  return targets.map(({ kind, hint }) => {
    if (provider === "claude") {
      if (entry.isSidechain === true) return false;
      if (kind === "opaque_tool_background") { const content = object(entry.message).content; return type === "assistant" && Array.isArray(content) && content.some((block) => object(block).type === "tool_use" && opaque(string(object(block).name))); }
      return kind === "unknown_record_type" && type === hint;
    }
    if (kind === "opaque_tool_background") return type === "response_item" && ["function_call", "custom_tool_call"].includes(string(payload.type)) && opaque(string(payload.name));
    if (kind === "unknown_event_type") return type === "event_msg" && typeHint(payload.type) === hint;
    if (kind === "unknown_response_type") return type === "response_item" && typeHint(payload.type) === hint;
    return type === hint;
  });
}

export const countLegacyHistory: LegacyHistory = async (query) => {
  if (!Number.isSafeInteger(query.end) || query.end < 0 || query.end > maxBytes || !query.targets.length) return null;
  const file = await open(query.path, "r").catch(() => null);
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || `${info.dev}:${info.ino}:${info.birthtimeMs}` !== query.identity.replace(/:\d+$/, "") || info.size < query.end) return null;
    // A cheap test before parsing: a record can only match when it holds the name or the type as a JSON string.
    const needles = query.targets.flatMap(({ kind, hint }) => kind === "opaque_tool_background" ? ["exec\"", "Workflow\""] : hint ? [JSON.stringify(hint)] : []).map((needle) => Buffer.from(needle));
    const found = query.targets.map(() => [] as number[]), chunk = Buffer.alloc(chunkBytes);
    let position = 0, start = 0, parts: Buffer[] = [], length = 0, long = false;
    const line = (raw: Buffer, offset: number) => {
      if (!needles.some((needle) => raw.includes(needle))) return;
      let entry: unknown;
      try { entry = JSON.parse(raw.toString("utf8")); } catch { return; }
      matches(query.provider, object(entry), query.targets).forEach((hit, index) => { if (hit) found[index].push(offset); });
    };
    while (position < query.end) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, query.end - position), position);
      if (!bytesRead) return null;
      let part = 0;
      while (part < bytesRead) {
        const newline = chunk.indexOf(10, part), stop = newline < 0 || newline >= bytesRead ? bytesRead : newline + 1;
        if (!long) {
          length += stop - part;
          if (length > lineLimit) { long = true; parts = []; } else parts.push(Buffer.from(chunk.subarray(part, stop)));
        }
        if (stop <= bytesRead && newline >= 0 && newline < bytesRead) {
          if (!long) line(Buffer.concat(parts), start);
          start = position + stop; parts = []; length = 0; long = false;
        }
        part = stop;
      }
      position += bytesRead;
    }
    return found;
  } finally { await file.close(); }
};
