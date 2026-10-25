/**
 * Card comments in the drawer (CARD-COMMENTS-SPEC §1): which session receives
 * a comment, which comments show, and recording then sending one, with the
 * composer's state kept outside the section. No React; the drawer passes the
 * Paseo API and the RPCs in.
 */
import type { PaseoApi } from "@getpaseo/client";
import type { BoardEvent } from "../shared/model";
import { commentsOf, type CommentInput } from "../shared/comments";
import { sessionTree, type SubagentSource } from "../shared/subagents";
import { preferredSend, resolveSend, type SendBehavior } from "./send-queue";
import { sendCardInstruction, workspaceSession, type HandoffSend } from "./session";

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

/** A card's recipients: its sessions, with its automation job's implementer and reviewer read from the board. */
export function cardRecipients(
  sessions: readonly TargetSource[],
  board: { automation: readonly { taskId: string; implementerId?: string; reviewerId?: string }[] } | undefined,
  task: { id: string; workspaceId: string },
): CommentTargets {
  const job = board?.automation.find((j) => j.taskId === task.id);
  return commentTargets(sessions, { workspaceId: task.workspaceId, implementerId: job?.implementerId, reviewerId: job?.reviewerId });
}

/** The To: row: shown when a live session exists; it opens when there is a choice (several, or none chosen yet). */
export function recipientPicker(targets: CommentTargets, target: CommentTarget | null) {
  const count = targets.candidates.length;
  return { shown: count > 0, opens: count > 1 || (count > 0 && !target) };
}

/** Why a comment would only be saved (CARD-COMMENTS-SPEC §1): no live session, only archived ones, or only reviewers. */
export type ComposerNote = "no-session" | "archived" | "reviewers";

/**
 * The line under the composer when nobody receives the comment. None while the
 * sessions load, nor while the slow archived read has not yet told a card
 * without sessions from a wrapped-up one (the live list alone cannot).
 */
export function composerNote(
  targets: CommentTargets,
  target: CommentTarget | null,
  known: { loading: boolean; archivedKnown: boolean },
): ComposerNote | null {
  if (known.loading || target) return null;
  if (targets.candidates.length) return "reviewers";
  if (targets.archivedOnly) return "archived";
  return known.archivedKnown ? "no-session" : null;
}

export type CommentDelivery =
  | { kind: "saved" }
  | { kind: "sent" | "queued"; agentId: string }
  | { kind: "failed"; agentId: string; error: string };

/** The session composer's send path (sendCardInstruction and the daemon queue). */
export interface CommentTransport {
  send(agentId: string, text: string, mode?: "steer" | "interrupt", messageId?: string): Promise<void>;
  queue(agentId: string, text: string, messageId?: string): Promise<unknown>;
}

/**
 * The transport for one card: the session composer's sendCardInstruction (the
 * session still belongs to the card's workspace, the task context is
 * available) and its daemon queue. Unlike the composer, a comment never
 * restores an archived session (CARD-COMMENTS-SPEC §7.5).
 */
export function commentTransport(
  deps: {
    paseo: PaseoApi;
    contextRead(input: { id: string }): Promise<{ available: boolean; reason: string; context: string }>;
    queue(taskId: string, agentId: string, text: string, messageId?: string): Promise<unknown>;
    handoff?: HandoffSend;
  },
  card: { taskId: string; workspaceId: string },
): CommentTransport {
  return {
    send: async (agentId, text, mode, messageId) => {
      await workspaceSession(deps.paseo, agentId, card.workspaceId, true);
      await sendCardInstruction(deps.paseo, { id: card.taskId, workspaceId: card.workspaceId }, agentId, deps.contextRead, text, mode, [], messageId, deps.handoff);
    },
    queue: (agentId, text, messageId) => deps.queue(card.taskId, agentId, text, messageId),
  };
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
  messageId?: string,
): Promise<CommentDelivery> {
  if (!target) return { kind: "saved" };
  const action = resolveSend(behavior, { running: target.running, alternate, pendingPermission: target.pendingPermission });
  try {
    if (action.kind === "queue") {
      await transport.queue(target.id, text, messageId);
      return { kind: "queued", agentId: target.id };
    }
    await transport.send(target.id, text, action.activeTurnBehavior, messageId);
    return { kind: "sent", agentId: target.id };
  } catch (error) {
    return { kind: "failed", agentId: target.id, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A recorded comment whose delivery failed: Resend only sends it again (CARD-COMMENTS-SPEC §7.6). */
export type FailedDelivery = { eventId: string; text: string; agentId: string; title: string; error: string; messageId?: string };

/**
 * What a card's comment composer keeps while the drawer shows a session instead
 * (the Comments section unmounts then): the draft, the chosen recipient, the
 * comments not delivered yet and the post in flight. A remounted section reads
 * it and subscribes, so it sees a post that settles meanwhile.
 */
export type CommentMemory = {
  draft: string;
  chosen: string | null;
  /** Each undelivered comment, oldest first, until it is resent or dismissed. */
  failed: FailedDelivery[];
  /** The last post that got no answer: retrying the same text reuses its operation. */
  last: { text: string; operationId: string } | null;
  /** A post or resend in flight, whichever section started it: one at a time per card. */
  busy: boolean;
  /** Why the last post was not recorded (the text stays in the box). */
  error: string;
  /** Comments recorded here that the board read may not hold yet. */
  posted: BoardEvent[];
  /** Bumped on every change (useSyncExternalStore). */
  version: number;
  listeners: Set<() => void>;
};

export const newCommentMemory = (): CommentMemory => ({
  draft: "",
  chosen: null,
  failed: [],
  last: null,
  busy: false,
  error: "",
  posted: [],
  version: 0,
  listeners: new Set(),
});

export function subscribeComments(memory: CommentMemory, listener: () => void) {
  memory.listeners.add(listener);
  return () => void memory.listeners.delete(listener);
}

function changed(memory: CommentMemory) {
  memory.version++;
  [...memory.listeners].forEach((listener) => listener());
}

export function editComment(memory: CommentMemory, text: string) {
  if (memory.draft === text) return;
  memory.draft = text;
  changed(memory);
}

export function chooseRecipient(memory: CommentMemory, agentId: string) {
  memory.chosen = agentId;
  changed(memory);
}

export function dismissFailure(memory: CommentMemory, eventId: string) {
  memory.failed = memory.failed.filter((f) => f.eventId !== eventId);
  changed(memory);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type PostOutcome =
  | { kind: "skipped" }
  /** Not recorded: the text stays in the box, and the same text retries the same operation. */
  | { kind: "refused"; error: string }
  | { kind: "posted"; event: BoardEvent; delivery: CommentDelivery };

/**
 * Posts the draft (CARD-COMMENTS-SPEC §4): records it on the card, clears the
 * box as soon as it is recorded (as the session composer does), then sends the
 * exact text with the "When running" preference. One post or resend at a time
 * per card, also across a remount of the section. A failed record throws
 * nothing and keeps the text; a failed delivery joins `failed`.
 */
export async function postComment(
  memory: CommentMemory,
  deps: CommentTransport & { record(input: CommentInput): Promise<{ event: BoardEvent }> },
  input: { taskId: string; target: CommentTarget | null; settings?: { sendBehavior?: SendBehavior } | null; alternate?: boolean },
): Promise<PostOutcome> {
  const text = memory.draft;
  if (memory.busy || !text.trim()) return { kind: "skipped" };
  const operationId = commentOperation(memory.last, text);
  memory.last = { text, operationId };
  memory.busy = true;
  memory.error = "";
  changed(memory);
  try {
    let event: BoardEvent;
    try {
      ({ event } = await deps.record({ taskId: input.taskId, text, operationId }));
    } catch (error) {
      memory.error = errorText(error);
      return { kind: "refused", error: memory.error };
    }
    memory.last = null;
    memory.posted = [...memory.posted, event];
    if (memory.draft === text) memory.draft = "";
    changed(memory);
    const messageId = `comment:${event.operationId ?? operationId}`;
    const delivery = await deliverComment(deps, input.target, text, preferredSend(input.settings), input.alternate, messageId);
    if (delivery.kind === "failed")
      memory.failed = [...memory.failed, { eventId: event.id, text, agentId: delivery.agentId, title: input.target?.title ?? "", error: delivery.error, messageId }];
    return { kind: "posted", event, delivery };
  } finally {
    memory.busy = false;
    changed(memory);
  }
}

/**
 * Sends an undelivered comment again, to the current recipient: only sends, it
 * is already on the card. Its entry goes on success and keeps the new reason on
 * failure; the other entries stay.
 */
export async function resendComment(
  memory: CommentMemory,
  transport: CommentTransport,
  eventId: string,
  target: CommentTarget | null,
  settings?: { sendBehavior?: SendBehavior } | null,
): Promise<CommentDelivery | null> {
  const entry = memory.failed.find((f) => f.eventId === eventId);
  if (memory.busy || !entry || !target) return null;
  memory.busy = true;
  changed(memory);
  try {
    const delivery = await deliverComment(transport, target, entry.text, preferredSend(settings), false, entry.messageId);
    memory.failed =
      delivery.kind === "failed"
        ? memory.failed.map((f) => (f.eventId === eventId ? { ...f, agentId: delivery.agentId, title: target.title, error: delivery.error } : f))
        : memory.failed.filter((f) => f.eventId !== eventId);
    return delivery;
  } finally {
    memory.busy = false;
    changed(memory);
  }
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
