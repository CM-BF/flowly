import { afterEach, expect, test, vi } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { HandoffService } from "./handoff-service";
import type { ComposerService } from "./composer";
import { CommentRouter } from "./comment-routing";
import { handoffSource } from "./handoff-source";

vi.mock("./provider-history", () => ({ historyBytes: async () => 0 }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const x = await agentFixture(); roots.push(x.root);
  const handoffs = new HandoffService(x.store); handoffs.attach(x.paseo);
  const send = vi.fn(async (_text: string, _options?: unknown) => {}), queue = vi.fn(async (_input: Record<string, unknown>, _api: unknown) => ({}));
  const ref = x.paseo.agents.ref.bind(x.paseo.agents);
  x.paseo.agents.ref = ((id: string) => ({ ...ref(id), send })) as typeof x.paseo.agents.ref;
  const make = () => new CommentRouter(x.store, handoffs, { push: queue } as unknown as ComposerService, () => x.paseo);
  return { ...x, handoffs, send, queue, make, router: make() };
}
const comment = { taskId: "t", text: "  保留原话\n", operationId: "comment-one", deliver: { agentId: "actor" } };

test("a routed original is persisted before send and a reload retry does not send it twice", async () => {
  const x = await fixture();
  x.send.mockImplementationOnce(async () => {
    expect((await x.store.read()).commentRoutes?.[0]).toMatchObject({ phase: "sending", agentId: "actor", messageId: "comment:comment-one" });
    expect(await x.handoffs.records.inputText("t", "comment:comment-one")).toBe(comment.text);
  });
  expect((await x.router.post(comment)).delivery).toEqual({ kind: "sent", agentId: "actor" });
  await x.make().post(comment);
  expect(x.send).toHaveBeenCalledTimes(1); expect(x.send).toHaveBeenCalledWith(comment.text, { messageId: "comment:comment-one" });
  expect((await x.handoffs.records.read("t", "p")).inputs).toHaveLength(1);
  expect((await x.store.read()).events.filter(e => e.action === "commented")).toHaveLength(1);
});

test("save records a complete long original and neither dispatches nor marks it processed", async () => {
  const x = await fixture(), text = "待办内容".repeat(2000);
  expect((await x.router.post({ ...comment, text, deliver: "save" })).delivery?.kind).toBe("saved");
  const source = handoffSource("comment:comment-one");
  expect(await x.handoffs.records.inputText("t", source)).toBe(text);
  expect((await x.handoffs.records.inputRecord("t", source))?.status).toBe("open");
  expect(x.send).not.toHaveBeenCalled(); expect(x.queue).not.toHaveBeenCalled();
});

test("a failed native acknowledgment keeps its original target and stable message id across reload", async () => {
  const x = await fixture(); x.send.mockRejectedValueOnce(new Error("connection lost after dispatch"));
  expect((await x.router.post(comment)).delivery?.kind).toBe("failed");
  expect((await x.store.read()).commentRoutes?.[0]).toMatchObject({ phase: "sending", agentId: "actor" });
  await expect(x.make().post({ ...comment, deliver: { agentId: "some-other-agent" } })).rejects.toMatchObject({ code: "REQUEST_REUSED" });
  expect((await x.make().post(comment)).delivery?.kind).toBe("sent");
  expect(x.send.mock.calls.map(c => c[1])).toEqual([{ messageId: "comment:comment-one" }, { messageId: "comment:comment-one" }]);
});

test("running comments obey the explicit queue preference and queued retries remain one operation", async () => {
  const x = await fixture(); x.actors.actor.status = "running";
  const input = { ...comment, whenRunning: "queue" as const };
  expect((await x.router.post(input)).delivery?.kind).toBe("queued"); await x.make().post(input);
  expect(x.queue).toHaveBeenCalledTimes(1); expect(x.send).not.toHaveBeenCalled();
  expect(x.queue.mock.calls[0][0]).toMatchObject({ text: comment.text, messageId: "comment:comment-one" });
});

test("pending automated routing retains source references and can recover the complete original after events age out", async () => {
  const x = await fixture(), now = new Date().toISOString();
  await x.store.mutate(b => b.automation.push({ taskId: "t", projectId: "p", generation: 1, implementerId: "actor", state: "reviewing", role: "reviewer", queuedAt: now, updatedAt: now, reviewRounds: 1, nudges: 0, failures: 0 }));
  x.router.routeManaged = vi.fn(async () => ({ kind: "pending" as const }));
  await x.router.post({ ...comment, deliver: "auto" });
  await x.store.mutate(b => { b.events = []; });
  expect(await x.make().read("t", "comment:comment-one")).toMatchObject({ text: comment.text, messageId: "comment:comment-one" });
  expect((await x.store.read()).commentRoutes?.[0].phase).toBe("pending");
  expect(x.send).not.toHaveBeenCalled();
});

test("old clients receive only a saved event and retain their original dispatch path", async () => {
  const x = await fixture(); const { deliver: _, ...old } = comment;
  expect(await x.router.post(old)).not.toHaveProperty("delivery");
  expect(x.send).not.toHaveBeenCalled(); expect((await x.store.read()).commentRoutes).toBeUndefined();
});

test("interruption immediately after comment acceptance preserves the route and a recoverable source confirmation", async () => {
  const x = await fixture();
  vi.spyOn(x.handoffs, "confirmSource").mockRejectedValueOnce(new Error("process ended after authoritative acceptance"));
  await expect(x.router.post({ ...comment, deliver: "fresh" })).rejects.toThrow("authoritative acceptance");
  const accepted = await x.store.read();
  expect(accepted.events.filter(e => e.action === "commented")).toHaveLength(1);
  expect(accepted.commentRoutes?.[0]).toMatchObject({ phase: "prepared", choice: "fresh", messageId: "comment:comment-one" });
  expect(accepted.handoffConfirmations).toHaveLength(1);
  const resumed = new HandoffService(x.store); resumed.attach(x.paseo);
  const router = new CommentRouter(x.store, resumed, { push: x.queue } as unknown as ComposerService, () => x.paseo);
  expect(await router.read("t", "comment:comment-one")).toMatchObject({ text: comment.text, messageId: "comment:comment-one", fresh: true });
  expect((await x.store.read()).handoffConfirmations).toBeUndefined();
  expect(x.send).not.toHaveBeenCalled();
});

test("known pre-send rejection is a failed delivery, not an unknown native send or a pending-slot leak", async () => {
  const x = await fixture();
  for (let n = 0; n < 21; n++) {
    const response = await x.router.post({ ...comment, operationId: `wrong-${n}`, deliver: { agentId: "wrong" } });
    expect(response.delivery?.kind).toBe("failed");
  }
  expect(x.send).not.toHaveBeenCalled();
  const receipts = await x.router.deliveries("t");
  expect(receipts).toHaveLength(21); expect(receipts.every(r => r.delivery.kind === "failed" && r.delivery.reason !== "send_unconfirmed")).toBe(true);
}, 20_000);

test.each(["task", "project"])("deleting a %s backs up its delivery receipts then frees their live budget", async kind => {
  const x = await fixture(); await x.router.post({ ...comment, deliver: "save" });
  const result = kind === "task" ? await x.store.deleteTask({ id: "t", revision: 1 }) : await x.store.removeProject({ id: "p", revision: 1, alsoPaseo: false });
  expect((await x.store.read()).commentRoutes).toEqual([]);
  expect(JSON.parse(await readFile(result.backup, "utf8")).commentRoutes).toMatchObject([{ taskId: "t", phase: "saved" }]);
});
