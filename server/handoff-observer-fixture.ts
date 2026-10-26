import { vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { captureHandoff } from "./handoff-capture";
import { HandoffObserver, type HandoffObservation, type HandoffObserverDeps } from "./handoff-observer";
import { HandoffStore } from "./handoff-store";
import { BoardStore } from "./store";
import { forgetHistory } from "./provider-history";
import { handoffOpenIds, type CardHandoff } from "../shared/handoff";

// Test fixture only; runtime entries never import this module. It never reaches a daemon or a real provider
// history: the Paseo API is an in-memory fake, and the board and the synthetic Codex/Claude homes live in a temp directory.
export const fixtureAt = "2026-10-25T02:00:00.000Z";
export const fixtureUuid = "019a15e5-0000-7abc-8def-0123456789ab";
const roots: string[] = [], observers: HandoffObserver[] = [];
export async function cleanupObserverFixtures() {
  forgetHistory();
  await Promise.all(observers.splice(0).map((observer) => observer.stop()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}
export const jsonLine = (value: unknown) => JSON.stringify(value) + "\n";
/** Codex rollout records. */
export const codexEvent = (type: string, data: Record<string, unknown> = {}) => ({ timestamp: fixtureAt, type: "event_msg", payload: { type, ...data } });
export const codexResponse = (type: string, data: Record<string, unknown>) => ({ timestamp: fixtureAt, type: "response_item", payload: { type, ...data } });
export const codexItem = (value: Record<string, unknown>) => codexEvent("item_completed", { thread_id: fixtureUuid, turn_id: "t", item: value });
export const codexTyped = (itemId: string, text: string) => codexItem({ type: "UserMessage", id: itemId, content: [{ type: "text", text }] });
/** Common fields of a Claude Code transcript record written through the SDK (Paseo's entrypoint). */
export const claudeBase = { sessionId: fixtureUuid, entrypoint: "sdk-cli", isSidechain: false, timestamp: fixtureAt, userType: "external", cwd: "/tmp/synthetic", version: "2.9.0" };

/**
 * One managed session (`worker`) of card `card`, observed through the real HandoffObserver and HandoffStore. `running`: the
 * session is in a turn (Paseo reports it running with an active turn) instead of idle; `actor` can be changed between polls.
 */
export async function observerFixture(options: { provider?: "codex" | "claude"; maxLineBytes?: number; running?: boolean } = {}) {
  const provider = options.provider ?? "codex";
  const directory = await mkdtemp(join(tmpdir(), "flowly-observer-fixture-")); roots.push(directory);
  const board = new BoardStore(directory), records = new HandoffStore(directory), home = join(directory, `synthetic-${provider}`);
  await board.mutate((value) => {
    value.projects.push({ id: "project", title: "P", description: "", paseoProjectId: "native", primaryPath: directory, repos: [directory], revision: 1, createdAt: fixtureAt, updatedAt: fixtureAt, archivedAt: null });
    value.tasks.push({ id: "card", projectId: "project", workspaceId: "workspace", sourcePath: directory, repoPaths: [], title: "Card", description: "", status: "development", priority: "normal", position: 0, revision: 1, operationId: "create", createdAt: fixtureAt, updatedAt: fixtureAt, archivedAt: null });
  });
  let path: string;
  if (provider === "codex") {
    const stamp = new Date(parseInt(fixtureUuid.replace(/-/g, "").slice(0, 12), 16));
    const folder = join(home, "sessions", String(stamp.getFullYear()), String(stamp.getMonth() + 1).padStart(2, "0"), String(stamp.getDate()).padStart(2, "0"));
    await mkdir(folder, { recursive: true }); path = join(folder, `rollout-fixture-${fixtureUuid}.jsonl`);
    await writeFile(path, jsonLine({ timestamp: fixtureAt, type: "session_meta", payload: { id: fixtureUuid, session_id: fixtureUuid, cwd: directory } }));
  } else {
    const folder = join(home, "projects", "synthetic-project"); await mkdir(folder, { recursive: true });
    path = join(folder, `${fixtureUuid}.jsonl`); await writeFile(path, "");
  }
  const actor: { status: string; activeTurn: { turnId: string; startedAt: string } | null } & Record<string, unknown> = { id: "worker", provider, model: `${provider}-fixture`, cwd: directory, workspaceId: "workspace", status: options.running ? "running" : "idle", activeTurn: options.running ? { turnId: "turn-1", startedAt: fixtureAt } : null, pendingPermissions: [] as unknown[], createdAt: fixtureAt, updatedAt: fixtureAt, lastUserMessageAt: fixtureAt, persistence: { provider, nativeHandle: fixtureUuid, sessionId: fixtureUuid }, archivedAt: null };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: actor }) }) } } as unknown as PaseoApi;
  const deps: HandoffObserverDeps = { records, board, paseo: () => paseo, serial: <T>(_: string, fn: () => Promise<T>) => fn(), syncIndex: async () => undefined, clock: () => Date.parse(fixtureAt),
    capture: (agent, previous, o) => captureHandoff(agent, previous, { ...o, codexHome: provider === "codex" ? home : join(directory, "unused-codex"), claudeHome: provider === "claude" ? home : join(directory, "unused-claude"), ...(options.maxLineBytes ? { maxLineBytes: options.maxLineBytes } : {}) }),
    git: vi.fn(async () => ({ snapshots: [], unchecked: [] })) };
  const observer = new HandoffObserver(deps); observers.push(observer);
  const read = () => records.read("card", "project");
  /** The successor's ACK of every pending id (or the filtered ones) against the revision it just read. */
  const ack = async (disposition: "done" | "obsolete" | "doing" | "ask", note: string, filter: (id: string) => boolean = () => true, record?: CardHandoff) => {
    const read1 = record ?? await read();
    return records.update("card", "project", { handoffRevision: read1.revision, ack: { handoffRevision: read1.revision, heads: [], understanding: "synthetic", items: handoffOpenIds(read1).filter(filter).map((id) => ({ id, disposition, note })) } }, { by: { kind: "agent", agentId: "worker" } }, { agentId: "worker", actualHeads: [] });
  };
  /** The automation's seal of this session for a rotation (no finalize turn ran). */
  const seal = (rotationId = "rotation:fixture") => observer.bridge.seal({ taskId: "card", rotationId, role: "implementer", fromAgentId: "worker", reason: "run_again", allowFinalize: false, carry: { id: "instruction", role: "implementer", text: "Continue", fresh: "Continue", kind: "again" } });
  return { observer, records, path, read, ack, seal, actor, board,
    append: (lines: unknown[]) => appendFile(path, lines.map(jsonLine).join("")),
    poll: () => observer.observe("card", "worker"),
    hook: (timeline: unknown[], outcome: HandoffObservation["outcome"] = "completed") => observer.observe("card", "worker", { outcome, timeline }) };
}

/** What a successor reading the card sees: inputs, notes, gaps, background items and the number of ids to acknowledge. */
export function successorView(record: CardHandoff) {
  return {
    inputs: record.inputs.map((input) => `${input.via}:${input.status}:${input.from?.title ?? "-"}:${input.text ?? ""}`),
    notes: record.notes.map((note) => `${note.kind}:${note.text}`),
    gaps: record.gaps.map((gap) => `${gap.status}:${gap.count ?? 1}:${gap.text}`),
    background: record.ledger.flatMap((session) => session.background).map((entry) => `${entry.kind}:${entry.status}:${entry.ref}:${entry.label}${entry.outcome ? `:${entry.outcome}` : ""}${entry.event ? `:event=${entry.event}` : ""}`),
    open: handoffOpenIds(record).length,
  };
}
