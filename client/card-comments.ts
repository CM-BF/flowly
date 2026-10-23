/**
 * Card comments in the drawer (CARD-COMMENTS-SPEC §1): which session receives
 * a comment, which comments show, and recording then sending one. Pure: no
 * React, no SDK; the drawer passes the Paseo calls in.
 */
import type { BoardEvent } from "../shared/model";
import { commentsOf, type CommentInput } from "../shared/comments";
import { sessionTree, type SubagentSource } from "../shared/subagents";
import { resolveSend, type SendBehavior } from "./send-queue";

/** Comments shown before "Show all". */
export const commentPreviewCount = 3;

export type CommentItem = { id: string; at: string; text: string };

/** This card's comments, oldest first, plus ones just posted that the board read does not hold yet. */
export function commentList(events: readonly BoardEvent[], taskId: string, posted: readonly BoardEvent[] = []): CommentItem[] {
  const list = commentsOf(events, taskId);
  const ids = new Set(list.map((e) => e.id));
  const fresh = commentsOf(posted, taskId).filter((e) => !ids.has(e.id));
  return [...list, ...fresh]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((e) => ({ id: e.id, at: e.at, text: e.note ?? "" }));
}

/** The newest few (still oldest first), or all of them. */
export function shownComments<T>(list: readonly T[], expanded: boolean, preview = commentPreviewCount): T[] {
  return expanded ? [...list] : list.slice(-preview);
}

/** What the drawer knows about a session of the card (a Paseo agent snapshot fits). */
export interface TargetSource extends SubagentSource {
  title?: string | null;
  workspaceId?: string | null;
  updatedAt: string;
}

export type CommentTarget = {
  id: string;
  title: string;
  running: boolean;
  pendingPermission: boolean;
  /** The card's automation implementer or reviewer, when it is one. */
  role?: "implementer" | "reviewer";
};

export type CommentTargets = {
  /** Live main sessions of the card's workspace, most recently active first: what To: offers. */
  candidates: CommentTarget[];
  /** The recipient when nobody picked one; null: the comment is only saved on the card. */
  defaultId: string | null;
  /** No live session, but archived ones (a wrapped-up card): they are not restored for a comment. */
  archivedOnly: boolean;
};

const reviewerLabel = (s: TargetSource) => s.labels?.["flowly-automation"] === "reviewer";

/**
 * The sessions a comment can go to and the default (CARD-COMMENTS-SPEC §1):
 * the automation implementer when it is still a live session of this
 * workspace, otherwise the most recently active live session that is not a
 * reviewer. Archived sessions are never offered (sending would restore them),
 * and a Paseo subagent is reached through its main session.
 */
export function commentTargets(
  sessions: readonly TargetSource[],
  card: { workspaceId: string; implementerId?: string; reviewerId?: string },
): CommentTargets {
  const here = sessions.filter((s) => s.workspaceId === card.workspaceId);
  const live = here.filter((s) => !s.archivedAt);
  const recent = (a: TargetSource, b: TargetSource) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  const mains = sessionTree(live).map((node) => node.agent).sort(recent);
  const candidates = mains.map((s): CommentTarget => {
    const role = s.id === card.implementerId ? "implementer" : s.id === card.reviewerId || reviewerLabel(s) ? "reviewer" : undefined;
    return {
      id: s.id,
      title: s.title || "",
      running: s.status === "running" || s.status === "initializing",
      pendingPermission: !!s.pendingPermissions?.length,
      ...(role ? { role } : {}),
    };
  });
  const implementer = candidates.find((c) => c.role === "implementer");
  const fallback = candidates.find((c) => c.role !== "reviewer");
  return {
    candidates,
    defaultId: (implementer ?? fallback)?.id ?? null,
    archivedOnly: !live.length && here.length > 0,
  };
}

/** The recipient: the person's choice while it is still offered, else the default. */
export function resolveTarget(targets: CommentTargets, chosen: string | null | undefined): CommentTarget | null {
  return targets.candidates.find((c) => c.id === chosen) ?? targets.candidates.find((c) => c.id === targets.defaultId) ?? null;
}

export type CommentDelivery =
  | { kind: "saved" }
  | { kind: "sent" | "queued"; agentId: string }
  | { kind: "failed"; agentId: string; error: string };

/** The session composer's send path, supplied by the drawer (sendCardInstruction and the daemon queue). */
export interface CommentTransport {
  send(agentId: string, text: string, mode?: "steer" | "interrupt"): Promise<void>;
  queue(agentId: string, text: string): Promise<unknown>;
}

/**
 * Sends a recorded comment to its session with the "When running" preference,
 * as the session composer does. Never throws: the comment is already on the
 * card, so a failure is reported for a resend, which only sends again.
 */
export async function deliverComment(
  transport: CommentTransport,
  target: CommentTarget | null,
  text: string,
  behavior: SendBehavior,
  alternate = false,
): Promise<CommentDelivery> {
  if (!target) return { kind: "saved" };
  const action = resolveSend(behavior, { running: target.running, alternate, pendingPermission: target.pendingPermission });
  try {
    if (action.kind === "queue") {
      await transport.queue(target.id, text);
      return { kind: "queued", agentId: target.id };
    }
    await transport.send(target.id, text, action.activeTurnBehavior);
    return { kind: "sent", agentId: target.id };
  } catch (error) {
    return { kind: "failed", agentId: target.id, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Records the comment on the card, then sends it (CARD-COMMENTS-SPEC §4). A
 * failed record throws, so the composer keeps the text; a failed send does not.
 */
export async function postComment(
  deps: CommentTransport & { record(input: CommentInput): Promise<{ event: BoardEvent }> },
  input: CommentInput & { target: CommentTarget | null; behavior: SendBehavior; alternate?: boolean },
): Promise<{ event: BoardEvent; delivery: CommentDelivery }> {
  const { event } = await deps.record({ taskId: input.taskId, text: input.text, operationId: input.operationId });
  const delivery = await deliverComment(deps, input.target, input.text, input.behavior, input.alternate);
  return { event, delivery };
}

/**
 * The operation id for posting `text`: the previous attempt's when it was the
 * same text (its answer may have been lost after the daemon recorded it), so a
 * retry returns that comment instead of a second one.
 */
export function commentOperation(previous: { text: string; operationId: string } | null, text: string): string {
  if (previous && previous.text === text) return previous.operationId;
  const crypto = (globalThis as { crypto?: { randomUUID?(): string } }).crypto;
  return `comment-${crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
