import { createHash } from "node:crypto";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffService } from "./handoff-service";
import { handoffSource } from "./handoff-source";
import { BoardStore } from "./store";
import { HandoffStore, type HandoffContext } from "./handoff-store";

// Test fixture only; runtime entries never import this module. Card records as the older builds 684a8fd and 786d9cd left
// them (SESSION-HANDOFF-SPEC §21.17): one open Flowly gap per occurrence, its source the capture gap id plus the SHA-256
// of its text, no count, written by the observer's capture batches. Temporary directories only.
export const at = "2026-10-25T00:43:30.367Z";
export const flowly: HandoffContext = { by: { kind: "flowly" } };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export type LegacyPrefix = "type" | "opaque" | "event" | "response" | "handle" | "timeline" | "long";
/** One gap exactly as 786d9cd's observer stored it (`capture-gap:${gap.id}:${digest(text)}`, entryId("g", source)). */
export function legacyGap(agentId: string, prefix: LegacyPrefix, kind: string, offset: number, options: { hint?: string; bytes?: [number, number]; provider?: "codex" | "claude" | "timeline"; session?: string; file?: string } = {}) {
  const { hint, bytes, provider = prefix === "timeline" ? "timeline" : "codex", session = `0199${agentId.padEnd(4, "0").slice(0, 4)}-0000-7000-8000-000000000001`, file = "16777232:139102801:1792722513530.101:0" } = options;
  const text = `Capture gap (${kind})${bytes ? ` in bytes ${bytes[0]}–${bytes[1]}` : ""}${hint ? `: ${hint}` : ""}. This content was not preserved.`;
  const gapId = prefix === "long" ? `long:${agentId}:${file}:${offset}` : `${prefix}:${agentId}:${provider}:${provider === "timeline" ? "" : session}:${provider === "timeline" ? `fp${offset}:1` : file}:${provider === "timeline" ? "" : offset}`;
  const sourceId = handoffSource(`capture-gap:${handoffSource(gapId)}:${sha(text)}`);
  return { section: "gaps" as const, value: { id: `g:${sha(sourceId).slice(0, 32)}`, sourceId, kind: "flowly", agentId, text, status: "open", at } };
}
export const many = (count: number, make: (n: number) => ReturnType<typeof legacyGap>) => Array.from({ length: count }, (_, n) => make(n));
export const session = (agentId: string, n: number, role: "implementer" | "reviewer" | "manual", provider = "codex") => ({ agentId, n, role, provider, reason: n === 1 ? "launch" : "replacement", startedAt: at, finalized: false, turns: [], background: [], live: [] });

/** A provider history file of `lines` (JSON values, or raw strings) in `dir`: each line's byte offset and the cursor identity (`dev:ino:birthtime:epoch`) the observer records for it. */
export async function rollout(dir: string, lines: readonly unknown[], name = "rollout.jsonl") {
  const path = join(dir, name), offsets: number[] = [];
  let size = 0;
  const text = lines.map((line) => { offsets.push(size); const value = `${typeof line === "string" ? line : JSON.stringify(line)}\n`; size += Buffer.byteLength(value); return value; }).join("");
  await writeFile(path, text);
  const info = await stat(path);
  return { path, offsets, size, identity: `${info.dev}:${info.ino}:${info.birthtimeMs}:0` };
}
/**
 * One capture pass of an older build, written as it wrote it: its gaps and the session's ledger version in one transaction
 * at the pass time `at`, the cursor where the pass ended and its coverage text ("N additional capture gaps omitted" when
 * the pass recorded its 100 gaps and dropped the rest).
 */
export async function legacyPass(dir: string, card: string, draft: ReturnType<typeof session>, entries: ReturnType<typeof legacyGap>[], through: { path: string; identity: string; offset: number; size: number }, omitted = 0) {
  const skeleton = omitted ? `Current capture coverage: ${omitted} additional capture gaps omitted. Narration is a bounded excerpt, not the full transcript.` : "Current capture reached the available source. Narration is a bounded excerpt, not the full transcript; skipped or unsupported content is listed separately in gaps.";
  await new HandoffStore(dir, { now: () => at }).capture(card, "project", { entries, session: { ...draft, skeleton, through: { ...through, at, lagBytes: 0, gaps: omitted } } }, flowly);
}
/** A board with one project and the given cards, the service in production wiring (its own store over the same directory). */
export async function migrationFixture(cards: readonly string[] = ["card-a", "card-b"]) {
  const dir = await mkdtemp(join(tmpdir(), "flowly-gap-migration-"));
  const board = new BoardStore(dir), stamp = new Date().toISOString();
  await board.mutate((value) => {
    value.projects.push({ id: "project", title: "P", description: "", paseoProjectId: "native", primaryPath: dir, repos: [dir], revision: 1, createdAt: stamp, updatedAt: stamp, archivedAt: null });
    cards.forEach((id, position) => value.tasks.push({ id, projectId: "project", workspaceId: `workspace-${id}`, sourcePath: dir, repoPaths: [], title: id, description: "", status: "development", priority: "normal", position, revision: 1, operationId: `create-${id}`, createdAt: stamp, updatedAt: stamp, archivedAt: null }));
  });
  const service = new HandoffService(board);
  /** Writes entries the way a legacy capture batch did, a few per pass, so the oldest overflow into the archive past 40. */
  const write = async (card: string, entries: ReturnType<typeof legacyGap>[], batch = 25) => {
    for (let start = 0; start < entries.length; start += batch) await service.records.capture(card, "project", { entries: entries.slice(start, start + batch) }, flowly);
  };
  return { dir, handoffs: join(dir, "handoffs"), board, service, write, start: () => new HandoffService(new BoardStore(dir)) };
}
