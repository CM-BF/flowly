import { describe, expect, test, vi } from "vitest";
import type { BoardEvent } from "../shared/model";
import {
  commentList,
  commentOperation,
  commentTargets,
  deliverComment,
  postComment,
  resolveTarget,
  shownComments,
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
    expect(resolveTarget(targets, "gone")?.id).toBe("impl");
    expect(resolveTarget(targets, null)?.id).toBe("impl");
    expect(resolveTarget({ candidates: [], defaultId: null, archivedOnly: false }, "other")).toBeNull();
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
  const deps = () => {
    const recorded: BoardEvent[] = [];
    const record = vi.fn(async (input: { taskId: string; text: string; operationId: string }) => {
      const event: BoardEvent = { id: `e-${input.operationId}`, taskId: input.taskId, actor: "human", action: "commented", note: input.text, at: at(1) };
      recorded.push(event);
      return { event };
    });
    const send = vi.fn(async (_agentId: string, _text: string, _mode?: "steer" | "interrupt") => undefined);
    const queue = vi.fn(async (_agentId: string, _text: string) => ({ id: "q" }));
    return { recorded, record, send, queue };
  };

  test("records first, then sends exactly the text to the target", async () => {
    const x = deps();
    const text = "  Why is the retry test skipped?\n";
    const result = await postComment(x, { taskId: "t", text, operationId: "op", target: target(), behavior: "steer" });
    expect(x.record).toHaveBeenCalledWith({ taskId: "t", text, operationId: "op" });
    expect(x.send).toHaveBeenCalledWith("impl", text, undefined);
    expect(x.record.mock.invocationCallOrder[0]).toBeLessThan(x.send.mock.invocationCallOrder[0]);
    expect(result).toEqual({ event: x.recorded[0], delivery: { kind: "sent", agentId: "impl" } });
  });
  test("follows the When running preference like the session composer", async () => {
    const x = deps();
    await deliverComment(x, target({ running: true }), "Steer it", "steer");
    expect(x.send).toHaveBeenLastCalledWith("impl", "Steer it", "steer");
    await deliverComment(x, target({ running: true }), "Interrupt it", "interrupt");
    expect(x.send).toHaveBeenLastCalledWith("impl", "Interrupt it", "interrupt");
    expect(await deliverComment(x, target({ running: true }), "After the turn", "queue")).toEqual({ kind: "queued", agentId: "impl" });
    expect(x.queue).toHaveBeenCalledWith("impl", "After the turn");
    // ⌘/Ctrl+Enter takes the alternative; a queued message cannot wait behind a permission prompt.
    await deliverComment(x, target({ running: true }), "Alternate", "steer", true);
    expect(x.queue).toHaveBeenLastCalledWith("impl", "Alternate");
    await deliverComment(x, target({ running: true, pendingPermission: true }), "Past the prompt", "queue");
    expect(x.send).toHaveBeenLastCalledWith("impl", "Past the prompt", "interrupt");
    // An idle session just gets it.
    await deliverComment(x, target(), "Idle", "queue");
    expect(x.send).toHaveBeenLastCalledWith("impl", "Idle", undefined);
  });
  test("no recipient: the comment is only saved", async () => {
    const x = deps();
    const result = await postComment(x, { taskId: "t", text: "For whoever starts", operationId: "op", target: null, behavior: "steer" });
    expect(result.delivery).toEqual({ kind: "saved" });
    expect(x.record).toHaveBeenCalledTimes(1);
    expect(x.send).not.toHaveBeenCalled();
    expect(x.queue).not.toHaveBeenCalled();
  });
  test("a failed send keeps the comment; resending sends again without recording it twice", async () => {
    const x = deps();
    x.send.mockRejectedValueOnce(new Error("This session's provider is unavailable."));
    const first = await postComment(x, { taskId: "t", text: "Please rerun the checks", operationId: "op", target: target(), behavior: "steer" });
    expect(first.delivery).toEqual({ kind: "failed", agentId: "impl", error: "This session's provider is unavailable." });
    expect(x.recorded).toHaveLength(1);
    const again = await deliverComment(x, target(), first.event.note!, "steer");
    expect(again).toEqual({ kind: "sent", agentId: "impl" });
    expect(x.send).toHaveBeenCalledTimes(2);
    expect(x.send).toHaveBeenLastCalledWith("impl", "Please rerun the checks", undefined);
    expect(x.record).toHaveBeenCalledTimes(1);
    // A failed queue is a failed delivery too.
    x.queue.mockRejectedValueOnce(new Error("Queue is full (50 messages)."));
    expect(await deliverComment(x, target({ running: true }), "Later", "queue")).toMatchObject({ kind: "failed", error: "Queue is full (50 messages)." });
  });
  test("when recording fails nothing is sent and the error reaches the composer", async () => {
    const x = deps();
    x.record.mockRejectedValueOnce(new Error("This card or its project is archived, so it can't take comments."));
    await expect(postComment(x, { taskId: "t", text: "Hello", operationId: "op", target: target(), behavior: "steer" })).rejects.toThrow("archived");
    expect(x.send).not.toHaveBeenCalled();
  });
  test("retrying the same text after an unclear failure reuses the operation, so the daemon records it once", () => {
    const first = commentOperation(null, "Same text");
    expect(commentOperation({ text: "Same text", operationId: first }, "Same text")).toBe(first);
    expect(commentOperation({ text: "Same text", operationId: first }, "Edited text")).not.toBe(first);
    expect(commentOperation(null, "Same text")).not.toBe(first);
  });
});
