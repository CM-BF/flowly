import { describe, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { BoardEvent } from "../shared/model";
import {
  cardRecipients,
  commentList,
  commentOperation,
  commentTargets,
  commentTransport,
  composerNote,
  deliverComment,
  deliveryNote,
  dismissFailure,
  editComment,
  newCommentMemory,
  postComment,
  recipientPicker,
  resendComment,
  resolveTarget,
  shownComments,
  subscribeComments,
  type CommentTarget,
  type TargetSource,
} from "./card-comments";

// CARD-COMMENTS-SPEC §1 (recipient, list, failed delivery) and §6 (acceptance), without React.
const at = (minute: number) => new Date(Date.UTC(2026, 9, 23, 10, minute)).toISOString();
const session = (id: string, minute: number, extra: Partial<TargetSource> = {}): TargetSource => ({
  id,
  title: `Session ${id}`,
  workspaceId: "w",
  archivedAt: null,
  createdAt: at(0),
  updatedAt: at(minute),
  status: "idle",
  labels: { "flowly-task": "t" },
  pendingPermissions: [],
  ...extra,
});

describe("who receives a comment", () => {
  test("the automation implementer, even when another session was active more recently", () => {
    const targets = commentTargets([session("impl", 1), session("other", 9)], { workspaceId: "w", implementerId: "impl" });
    expect(targets.defaultId).toBe("impl");
    expect(targets.candidates.find((c) => c.id === "impl")?.role).toBe("implementer");
  });
  test("without a usable implementer: the most recently active session that is not a reviewer", () => {
    const sessions = [
      session("impl", 8, { archivedAt: at(9) }),
      session("older", 2),
      session("newer", 5),
      session("labelled-reviewer", 9, { labels: { "flowly-automation": "reviewer" } }),
      session("job-reviewer", 9),
      session("elsewhere", 9, { workspaceId: "other" }),
    ];
    const targets = commentTargets(sessions, { workspaceId: "w", implementerId: "impl", reviewerId: "job-reviewer" });
    expect(targets.defaultId).toBe("newer");
    // Reviewers stay choosable by hand; archived sessions and other workspaces are never offered.
    expect(targets.candidates.map((c) => c.id)).toEqual(["labelled-reviewer", "job-reviewer", "newer", "older"]);
    expect(targets.candidates.filter((c) => c.role === "reviewer").map((c) => c.id)).toEqual(["labelled-reviewer", "job-reviewer"]);
    // An implementer of another workspace (the job moved on) does not count.
    expect(commentTargets([session("impl", 1, { workspaceId: "other" }), session("x", 2)], { workspaceId: "w", implementerId: "impl" }).defaultId).toBe("x");
  });
  test("a Paseo subagent is not a comment recipient; its main session is", () => {
    const targets = commentTargets(
      [session("main", 1), session("child", 9, { labels: { "paseo.parent-agent-id": "main" } })],
      { workspaceId: "w" },
    );
    expect(targets.defaultId).toBe("main");
    expect(targets.candidates.map((c) => c.id)).toEqual(["main"]);
  });
  test("only reviewers or no session: nothing is chosen; archived-only is told apart", () => {
    expect(commentTargets([session("r", 1, { labels: { "flowly-automation": "reviewer" } })], { workspaceId: "w" }).defaultId).toBeNull();
    expect(commentTargets([], { workspaceId: "w" })).toEqual({ candidates: [], defaultId: null, archivedOnly: false });
    // Wrapped up: its sessions are archived and stay so (no restore).
    expect(commentTargets([session("a", 1, { archivedAt: at(2) })], { workspaceId: "w" })).toEqual({ candidates: [], defaultId: null, archivedOnly: true });
  });
  test("running and pending-permission state come with the target", () => {
    const [target] = commentTargets([session("busy", 1, { status: "running", pendingPermissions: [{ id: "p" }] })], { workspaceId: "w" }).candidates;
    expect(target).toEqual({ id: "busy", title: "Session busy", running: true, pendingPermission: true });
  });
  test("a person's choice holds while it is still a recipient", () => {
    const targets = commentTargets([session("impl", 1), session("other", 2)], { workspaceId: "w", implementerId: "impl" });
    expect(resolveTarget(targets, "other")?.id).toBe("other");
    expect(resolveTarget(targets, "gone")).toBeNull();
    expect(resolveTarget(targets, null)?.id).toBe("impl");
    expect(resolveTarget({ candidates: [], defaultId: null, archivedOnly: false }, "other")).toBeNull();
  });
});

describe("recipients from the drawer's data", () => {
  test("the card's automation job on the board names the implementer, who is the default", () => {
    const sessions = [session("impl", 1), session("rev", 8), session("other", 9)];
    const board = { automation: [{ taskId: "elsewhere", implementerId: "other" }, { taskId: "t", implementerId: "impl", reviewerId: "rev" }] };
    const targets = cardRecipients(sessions, board, { id: "t", workspaceId: "w" });
    expect(targets.defaultId).toBe("impl");
    expect(targets.candidates.find((c) => c.id === "rev")?.role).toBe("reviewer");
    // No board read yet, or no job: the most recently active session.
    expect(cardRecipients(sessions, undefined, { id: "t", workspaceId: "w" }).defaultId).toBe("other");
  });
  test("only a reviewer is live: To: opens even for one, nobody is chosen, and the note says why", () => {
    const targets = commentTargets([session("rev", 1, { labels: { "flowly-automation": "reviewer" } })], { workspaceId: "w" });
    const target = resolveTarget(targets, null);
    expect(target).toBeNull();
    expect(recipientPicker(targets, target)).toEqual({ shown: true, opens: true });
    expect(composerNote(targets, target, { loading: false, archivedKnown: true })).toBe("reviewers");
    // Picked by hand: it is the recipient, and nothing needs explaining.
    const picked = resolveTarget(targets, "rev");
    expect(picked?.id).toBe("rev");
    expect(recipientPicker(targets, picked)).toEqual({ shown: true, opens: false });
    expect(composerNote(targets, picked, { loading: false, archivedKnown: true })).toBeNull();
  });
  test("an explicit Save on the card explains nothing; a save by circumstance still says why", () => {
    // Live 2026-10-25: a managed card whose implementer is live, the person picked Save on the card,
    // and the composer claimed "This card's only live sessions are reviewers".
    const live = commentTargets([session("impl", 1)], { workspaceId: "w", implementerId: "impl" });
    const known = { loading: false, archivedKnown: true };
    expect(deliveryNote("route:save", "save", live, resolveTarget(live, "route:save"), known)).toBeNull();
    expect(deliveryNote("route:auto", "auto", live, resolveTarget(live, "route:auto"), known)).toBeNull();
    // An unmanaged card with only a reviewer live: nobody receives the comment, and the note says why.
    const reviewerOnly = commentTargets([session("rev", 1, { labels: { "flowly-automation": "reviewer" } })], { workspaceId: "w" });
    expect(deliveryNote(null, "save", reviewerOnly, resolveTarget(reviewerOnly, null), known)).toBe("reviewers");
    // A chosen session that is gone: the explicit target is unavailable, so the note explains it.
    expect(deliveryNote("gone", { agentId: "gone" }, reviewerOnly, resolveTarget(reviewerOnly, "gone"), known)).toBe("reviewers");
  });
  test("one or more sessions: To: opens only when there is a choice", () => {
    const one = commentTargets([session("a", 1)], { workspaceId: "w" });
    expect(recipientPicker(one, resolveTarget(one, null))).toEqual({ shown: true, opens: false });
    const two = commentTargets([session("a", 1), session("b", 2)], { workspaceId: "w" });
    expect(recipientPicker(two, resolveTarget(two, null))).toEqual({ shown: true, opens: true });
    const none = commentTargets([], { workspaceId: "w" });
    expect(recipientPicker(none, null)).toEqual({ shown: false, opens: false });
  });
  test("no live session: the note waits for the archived read before promising an agent", () => {
    const none = commentTargets([], { workspaceId: "w" });
    // The live list is empty and the archived scan has not answered: it may be a wrapped-up card.
    expect(composerNote(none, null, { loading: false, archivedKnown: false })).toBeNull();
    expect(composerNote(none, null, { loading: false, archivedKnown: true })).toBe("no-session");
    const wrapped = commentTargets([session("a", 1, { archivedAt: at(2) })], { workspaceId: "w" });
    expect(composerNote(wrapped, null, { loading: false, archivedKnown: true })).toBe("archived");
    expect(composerNote(none, null, { loading: true, archivedKnown: true })).toBeNull();
  });
});

describe("the comment list", () => {
  const event = (id: string, minute: number, extra: Partial<BoardEvent> = {}): BoardEvent => ({ id, taskId: "t", actor: "human", action: "commented", note: `Comment ${id}`, at: at(minute), ...extra });
  test("this card's comments, oldest first, with ones just posted that the board does not show yet", () => {
    const events = [
      event("a", 1),
      event("x", 2, { actor: "agent", action: "progress_reported" }),
      event("other-card", 3, { taskId: "u" }),
      event("b", 4),
    ];
    expect(commentList(events, "t").map((c) => c.id)).toEqual(["a", "b"]);
    expect(commentList(events, "t", [event("b", 4), event("c", 5)]).map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(commentList(events, "t")[0]).toEqual({ id: "a", at: at(1), text: "Comment a" });
  });
  test("three shown by default (the newest, still oldest first), all when expanded", () => {
    const list = ["1", "2", "3", "4", "5"];
    expect(shownComments(list, false)).toEqual(["3", "4", "5"]);
    expect(shownComments(list, true)).toEqual(list);
    expect(shownComments(["1"], false)).toEqual(["1"]);
  });
});

describe("posting and sending", () => {
  const target = (extra: Partial<CommentTarget> = {}): CommentTarget => ({ id: "impl", title: "Implementer", running: false, pendingPermission: false, ...extra });
  const deferred = <T = undefined>() => {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => ((resolve = yes), (reject = no)));
    return { promise, resolve, reject };
  };
  const deps = () => {
    const recorded: BoardEvent[] = [];
    const record = vi.fn(async (input: { taskId: string; text: string; operationId: string }) => {
      const replay = recorded.find((e) => e.id === `e-${input.operationId}`);
      if (replay) return { event: replay };
      const event: BoardEvent = { id: `e-${input.operationId}`, taskId: input.taskId, actor: "human", action: "commented", operationId: input.operationId, note: input.text, at: at(recorded.length + 1) };
      recorded.push(event);
      return { event };
    });
    const send = vi.fn(async (_agentId: string, _text: string, _mode?: "steer" | "interrupt") => undefined);
    const queue = vi.fn(async (_agentId: string, _text: string) => ({ id: "q" }));
    return { recorded, record, send, queue };
  };
  const draft = (text: string) => {
    const memory = newCommentMemory();
    editComment(memory, text);
    return memory;
  };

  test("records first, then sends exactly the text to the target", async () => {
    const x = deps();
    const text = "  Why is the retry test skipped?\n";
    const memory = draft(text);
    const result = await postComment(memory, x, { taskId: "t", target: target(), settings: { sendBehavior: "steer" } });
    expect(x.record).toHaveBeenCalledWith({ taskId: "t", text, operationId: expect.any(String) });
    expect(x.send).toHaveBeenCalledWith("impl", text, undefined, `comment:${x.recorded[0].operationId}`);
    expect(x.record.mock.invocationCallOrder[0]).toBeLessThan(x.send.mock.invocationCallOrder[0]);
    expect(result).toEqual({ kind: "posted", event: x.recorded[0], delivery: { kind: "sent", agentId: "impl" } });
    expect(memory).toMatchObject({ draft: "", busy: false, failed: [], posted: [x.recorded[0]] });
  });
  test("follows the When running preference from the board settings, like the session composer", async () => {
    const x = deps();
    const post = (text: string, settings: { sendBehavior?: "steer" | "queue" | "interrupt" } | undefined, extra: Partial<CommentTarget> = {}, alternate = false) =>
      postComment(draft(text), x, { taskId: "t", target: target({ running: true, ...extra }), settings, alternate });
    await post("Default", undefined);
    expect(x.send).toHaveBeenLastCalledWith("impl", "Default", "steer", expect.stringMatching(/^comment:/));
    await post("Interrupt it", { sendBehavior: "interrupt" });
    expect(x.send).toHaveBeenLastCalledWith("impl", "Interrupt it", "interrupt", expect.stringMatching(/^comment:/));
    expect((await post("After the turn", { sendBehavior: "queue" })).kind === "posted" && x.queue).toHaveBeenLastCalledWith("impl", "After the turn", expect.stringMatching(/^comment:/));
    // ⌘/Ctrl+Enter takes the alternative; a queued message cannot wait behind a permission prompt.
    await post("Alternate", { sendBehavior: "steer" }, {}, true);
    expect(x.queue).toHaveBeenLastCalledWith("impl", "Alternate", expect.stringMatching(/^comment:/));
    await post("Past the prompt", { sendBehavior: "queue" }, { pendingPermission: true });
    expect(x.send).toHaveBeenLastCalledWith("impl", "Past the prompt", "interrupt", expect.stringMatching(/^comment:/));
    // An idle session just gets it.
    await deliverComment(x, target(), "Idle", "queue");
    expect(x.send).toHaveBeenLastCalledWith("impl", "Idle", undefined, undefined);
  });
  test("no recipient: the comment is only saved", async () => {
    const x = deps();
    const result = await postComment(draft("For whoever starts"), x, { taskId: "t", target: null });
    expect(result).toMatchObject({ kind: "posted", delivery: { kind: "saved" } });
    expect(x.record).toHaveBeenCalledTimes(1);
    expect(x.send).not.toHaveBeenCalled();
    expect(x.queue).not.toHaveBeenCalled();
  });
  test("the box clears as soon as the comment is recorded, before the delivery settles", async () => {
    const x = deps();
    const sending = deferred();
    x.send.mockImplementationOnce(() => sending.promise);
    const memory = draft("Why is the build red?");
    const post = postComment(memory, x, { taskId: "t", target: target() });
    await vi.waitFor(() => expect(x.send).toHaveBeenCalled());
    expect(memory).toMatchObject({ draft: "", busy: true });
    sending.resolve(undefined);
    await post;
    expect(memory.busy).toBe(false);
  });
  test("one post at a time per card: a remounted section cannot record or send it again", async () => {
    const x = deps();
    const sending = deferred();
    x.send.mockImplementationOnce(() => sending.promise);
    const memory = draft("Why is the build red?");
    const seen: number[] = [];
    const first = postComment(memory, x, { taskId: "t", target: target() });
    await vi.waitFor(() => expect(x.send).toHaveBeenCalledTimes(1));
    // The drawer showed a session and came back: the new section shares the memory and listens to it.
    const unsubscribe = subscribeComments(memory, () => seen.push(memory.version));
    expect(memory.busy).toBe(true);
    editComment(memory, "Why is the build red?");
    expect(await postComment(memory, x, { taskId: "t", target: target() })).toEqual({ kind: "skipped" });
    sending.resolve(undefined);
    await first;
    expect(x.record).toHaveBeenCalledTimes(1);
    expect(x.send).toHaveBeenCalledTimes(1);
    // It heard the post settle.
    expect(seen.length).toBeGreaterThan(0);
    expect(memory.busy).toBe(false);
    unsubscribe();
  });
  test("a delivery that fails after a remount reaches the new section", async () => {
    const x = deps();
    const sending = deferred();
    x.send.mockImplementationOnce(() => sending.promise);
    const memory = draft("Please rerun the checks");
    const post = postComment(memory, x, { taskId: "t", target: target() });
    await vi.waitFor(() => expect(x.send).toHaveBeenCalled());
    const listener = vi.fn();
    subscribeComments(memory, listener);
    sending.reject(new Error("This session's provider is unavailable."));
    await post;
    expect(listener).toHaveBeenCalled();
    expect(memory.failed).toEqual([
      { eventId: x.recorded[0].id, text: "Please rerun the checks", agentId: "impl", title: "Implementer", error: "This session's provider is unavailable.", messageId: `comment:${x.recorded[0].operationId}` },
    ]);
  });
  test("every failed delivery keeps its own notice; resending one only sends it, and the others stay", async () => {
    const x = deps();
    x.send.mockRejectedValue(new Error("This session's provider is unavailable."));
    const memory = newCommentMemory();
    editComment(memory, "First: rename the flag");
    await postComment(memory, x, { taskId: "t", target: target() });
    editComment(memory, "Second: and add a test");
    await postComment(memory, x, { taskId: "t", target: target() });
    expect(memory.failed.map((f) => f.text)).toEqual(["First: rename the flag", "Second: and add a test"]);
    // A later comment that is delivered clears nobody else's notice.
    x.send.mockResolvedValue(undefined);
    editComment(memory, "Third");
    await postComment(memory, x, { taskId: "t", target: target() });
    expect(memory.failed.map((f) => f.text)).toEqual(["First: rename the flag", "Second: and add a test"]);
    // Resend the first: sent, never recorded again (the deps carry record; resend must not use it).
    const recordedBefore = x.record.mock.calls.length;
    const sent = await resendComment(memory, x, memory.failed[0].eventId, target({ id: "other", title: "Other" }), { sendBehavior: "steer" });
    expect(sent).toEqual({ kind: "sent", agentId: "other" });
    expect(x.send).toHaveBeenLastCalledWith("other", "First: rename the flag", undefined, `comment:${x.recorded[0].operationId}`);
    expect(x.record.mock.calls.length).toBe(recordedBefore);
    expect(memory.failed.map((f) => f.text)).toEqual(["Second: and add a test"]);
    // A resend that fails again keeps its entry with the new reason.
    x.send.mockRejectedValueOnce(new Error("Queue is full (50 messages)."));
    await resendComment(memory, x, memory.failed[0].eventId, target());
    expect(memory.failed).toMatchObject([{ text: "Second: and add a test", error: "Queue is full (50 messages)." }]);
    dismissFailure(memory, memory.failed[0].eventId);
    expect(memory.failed).toEqual([]);
    // A failed queue is a failed delivery too.
    x.queue.mockRejectedValueOnce(new Error("Queue is full (50 messages)."));
    expect(await deliverComment(x, target({ running: true }), "Later", "queue")).toMatchObject({ kind: "failed", error: "Queue is full (50 messages)." });
  });
  test("when recording fails nothing is sent, the text stays and the retry reuses the operation", async () => {
    const x = deps();
    x.record.mockRejectedValueOnce(new Error("Network lost"));
    const memory = draft("Hello");
    expect(await postComment(memory, x, { taskId: "t", target: target() })).toEqual({ kind: "refused", error: "Network lost" });
    expect(x.send).not.toHaveBeenCalled();
    expect(memory).toMatchObject({ draft: "Hello", error: "Network lost", busy: false });
    const firstOperation = x.record.mock.calls[0][0].operationId;
    await postComment(memory, x, { taskId: "t", target: target() });
    expect(x.record.mock.calls[1][0].operationId).toBe(firstOperation);
    expect(memory.error).toBe("");
  });
  test("after a recorded post the same words again are a new comment", async () => {
    const x = deps();
    const memory = draft("Ping");
    await postComment(memory, x, { taskId: "t", target: target() });
    editComment(memory, "Ping");
    await postComment(memory, x, { taskId: "t", target: target() });
    expect(new Set(x.record.mock.calls.map(([input]) => input.operationId)).size).toBe(2);
    expect(x.recorded).toHaveLength(2);
  });
  test("retrying the same text after an unclear failure reuses the operation, so the daemon records it once", () => {
    const first = commentOperation(null, "Same text");
    expect(commentOperation({ text: "Same text", operationId: first }, "Same text")).toBe(first);
    expect(commentOperation({ text: "Same text", operationId: first }, "Edited text")).not.toBe(first);
    expect(commentOperation(null, "Same text")).not.toBe(first);
  });
});

describe("the transport (the session composer's send path)", () => {
  const fixture = (agent: Record<string, unknown> | null) => {
    const send = vi.fn(async (_text: string, _options: unknown) => undefined);
    const paseo = { agents: { ref: () => ({ refresh: async () => (agent ? { agent } : null), send }) } } as unknown as PaseoApi;
    const contextRead = vi.fn(async (_input: { id: string }) => ({ available: true, reason: "", context: "Card context" }));
    const queue = vi.fn(async (_taskId: string, _agentId: string, _text: string) => ({ id: "q" }));
    return { send, contextRead, queue, transport: commentTransport({ paseo, contextRead, queue }, { taskId: "t", workspaceId: "w" }) };
  };
  test("sends exactly the text after checking the session and the card's context", async () => {
    const x = fixture({ id: "impl", workspaceId: "w", status: "running", archivedAt: null });
    await x.transport.send("impl", "  Exact words, no header\n", "interrupt");
    expect(x.contextRead).toHaveBeenCalledWith({ id: "t" });
    expect(x.send).toHaveBeenCalledWith("  Exact words, no header\n", { activeTurnBehavior: "interrupt" });
  });
  test("never restores an archived session, and refuses a session of another workspace", async () => {
    const archived = fixture({ id: "impl", workspaceId: "w", status: "idle", archivedAt: at(5) });
    await expect(archived.transport.send("impl", "Hello", "steer")).rejects.toThrow("archived");
    expect(archived.send).not.toHaveBeenCalled();
    const elsewhere = fixture({ id: "impl", workspaceId: "other", status: "idle", archivedAt: null });
    await expect(elsewhere.transport.send("impl", "Hello", "steer")).rejects.toThrow("different workspace");
    expect(elsewhere.send).not.toHaveBeenCalled();
  });
  test("queues through the daemon queue for this card", async () => {
    const x = fixture({ id: "impl", workspaceId: "w", status: "running", archivedAt: null });
    await x.transport.queue("impl", "After the turn");
    expect(x.queue).toHaveBeenCalledWith("t", "impl", "After the turn", undefined);
    expect(x.send).not.toHaveBeenCalled();
  });
});

test("a daemon-routed pending comment never also takes the client native send path", async () => {
  const memory = newCommentMemory(); editComment(memory, "  原文\n");
  const record = vi.fn(async () => ({ event: { id: "route-event", taskId: "t", action: "commented", actor: "human", at: at(0), note: "  原文\n", operationId: "route-op" } as BoardEvent, delivery: { kind: "pending" as const } }));
  const send = vi.fn(), queue = vi.fn();
  const outcome = await postComment(memory, { record, send, queue }, { taskId: "t", target: null, deliver: "auto" });
  expect(outcome).toMatchObject({ kind: "posted", delivery: { kind: "pending" } });
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ text: "  原文\n", deliver: "auto" }));
  expect(send).not.toHaveBeenCalled(); expect(queue).not.toHaveBeenCalled(); expect(memory.draft).toBe("");
});
