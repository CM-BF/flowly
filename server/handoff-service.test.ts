import { afterEach, expect, test, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { agentFixture } from "./agent-fixture";
import { HandoffService } from "./handoff-service";
import { handoffMessageSource } from "./handoff-source";

vi.mock("./provider-history", () => ({ historyBytes: async () => 0 }));
vi.mock("./handoff-git", () => ({ handoffGitDirectories: async () => ({ directories: [], unchecked: [] }), handoffGitSnapshot: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const x = await agentFixture(); roots.push(x.root);
  const h = new HandoffService(x.store); h.attach(x.paseo);
  return { ...x, h };
}
const flowly = { by: { kind: "flowly" as const } };

test("a full original comment survives repeat recording and delivery to a session as one input", async () => {
  const x = await fixture(), text = "原话\n".repeat(2000), input = { taskId: "t", operationId: "same-comment", text };
  const event = await x.h.comment(input);
  expect((await x.h.comment(input)).id).toBe(event.id);
  await x.h.recordInput({ ...x.identity, text, messageId: "comment:same-comment", via: "comment" });
  const record = await x.h.records.read("t", "p");
  expect(record.inputs).toHaveLength(1); expect(record.pendingOperations).toEqual([]);
  const source = await x.h.records.inputRecord("t", "comment:same-comment");
  expect(source?.characters).toBe(text.length); expect(source?.textRef).toBeTruthy();
  expect(source?.status).toBe("open");
  expect((await x.store.read()).events.filter((e) => e.action === "commented")).toHaveLength(1);
});

test("retrying a message preserves exact text and refuses another instruction under its identity", async () => {
  const x = await fixture(), input = { ...x.identity, messageId: "message-1", text: "  不要 push\n", via: "session" as const };
  await x.h.recordInput(input); await x.h.recordInput(input);
  await expect(x.h.recordInput({ ...input, text: "push now" })).rejects.toMatchObject({ code: "OPERATION_REUSED" });
  const record = await x.h.records.read("t", "p");
  expect(record.inputs).toHaveLength(1); expect(record.inputs[0].text).toBe(input.text); expect(record.inputs[0].status).toBe("open");
  await x.h.confirmInput(input); expect((await x.h.records.read("t", "p")).inputs[0].status).toBe("open");
});

test("queued cancellation records the user's withdrawal without erasing original words", async () => {
  const x = await fixture(), messageId = "queued-id", text = "只运行一次";
  await x.h.recordInput({ ...x.identity, messageId, text, via: "session" });
  await x.h.withdrawQueued("t", "actor", messageId);
  const input = await x.h.records.inputRecord("t", handoffMessageSource("actor", messageId));
  expect(input).toMatchObject({ text, status: "declined", handled: { by: { kind: "human" } } });
});

test("an unchanged Git observation does not invalidate the successor's exact-revision ACK", async () => {
  const x = await fixture();
  await x.h.records.setSession("t", "p", { agentId: "actor", n: 1, role: "implementer", provider: "codex", reason: "requested", startedAt: "2026-10-24T00:00:00Z", finalized: false, turns: [], background: [], live: [] }, flowly);
  await x.h.update(x.identity, { handoffRevision: 1, state: "实现已完成", set: [{ section: "next", text: "读验收报告" }] });
  const read = await x.h.records.read("t", "p");
  const result = await x.h.update(x.identity, { handoffRevision: read.revision, ack: { handoffRevision: read.revision, heads: [], understanding: "核对后从验收继续", items: [] } });
  expect(result.ackMissing).toBeUndefined(); expect((await x.h.records.read("t", "p")).ledger[0].ack?.complete).toBe(true);
});

test("question/board two-phase writes remain visibly unconfirmed until the board receipt commits", async () => {
  const x = await fixture(), board = await x.store.read(), text = "真的问题".repeat(2000);
  await x.h.prepareQuestion(x.identity, "question:stable", "question", text, board);
  const pending = await x.h.records.read("t", "p"); expect(pending.questions[0].text).toBe(text); expect(pending.questions[0].unconfirmed).toBe(true);
  await x.h.confirmSource("t", "question:stable");
  expect((await x.h.records.read("t", "p")).questions[0].unconfirmed).toBeUndefined();
});

test("deleting a card backs up the semantic record before removal and keeps it recoverable", async () => {
  const x = await fixture();
  await x.h.comment({ taskId: "t", operationId: "keep", text: "关键指示" });
  x.store.handoffBackup = async (ids, destination) => { for (const id of ids) await x.h.records.exportCard(id, join(destination, id)); };
  const result = await x.h.removeWithBackup(["t"], () => x.store.deleteTask({ id: "t", revision: 1 }));
  expect(await x.h.records.read("t")).toBeNull();
  await x.h.records.restoreCard("t", join(result.backup + ".handoffs", "t"));
  expect((await x.h.records.read("t", "p")).inputs[0].text).toBe("关键指示");
  expect((await x.store.read()).handoffIndex).toEqual([]);
});

test("a failed handoff backup prevents destructive card deletion", async () => {
  const x = await fixture(); await x.h.comment({ taskId: "t", operationId: "keep", text: "必须留住" });
  x.store.handoffBackup = async () => { throw new Error("disk full"); };
  await expect(x.h.removeWithBackup(["t"], () => x.store.deleteTask({ id: "t", revision: 1 }))).rejects.toThrow("disk full");
  expect((await x.store.read()).tasks.some((task) => task.id === "t")).toBe(true); expect((await x.h.records.read("t", "p")).inputs[0].text).toBe("必须留住");
});

test("verified coverage gaps can be closed with an attributed reason while their original description is kept", async () => {
  const x = await fixture();
  await x.h.update(x.identity, { handoffRevision: 0, gaps: [{ text: "A prior read missed a line", status: "open" }] });
  const before = await x.h.records.read("t", "p");
  expect(before.gaps[0]).toMatchObject({ text: "A prior read missed a line", status: "open", by: { kind: "agent", agentId: "actor" } });
  await x.h.update(x.identity, { handoffRevision: before.revision, gaps: [{ id: before.gaps[0].id, status: "closed", note: "Read the preserved source range and linked the result in report.md." }] });
  expect((await x.h.records.read("t", "p")).gaps[0]).toMatchObject({ text: "A prior read missed a line", status: "closed", resolution: { by: { kind: "agent", agentId: "actor" }, note: expect.stringContaining("report.md") } });
});

test("the daemon records a restoring follow-up before sending it to the archived small session", async () => {
  const x = await fixture(); x.actors.actor.archivedAt = new Date().toISOString();
  const send = vi.fn(async () => {
    expect((await x.h.records.read("t", "p")).inputs[0].text).toBe("  原话\n");
    x.actors.actor.archivedAt = null;
  });
  const ref = x.paseo.agents.ref.bind(x.paseo.agents);
  x.paseo.agents.ref = ((id: string) => ({ ...ref(id), send })) as typeof x.paseo.agents.ref;
  await x.h.send({ ...x.identity, messageId: "restoring", text: "  原话\n", via: "session" });
  expect(send).toHaveBeenCalledWith("  原话\n", { messageId: "restoring" });
});

test("a replacement requested while the original is saving blocks its old-target send", async () => {
  const x = await fixture(), send = vi.fn();
  const ref = x.paseo.agents.ref.bind(x.paseo.agents);
  x.paseo.agents.ref = ((id: string) => ({ ...ref(id), send })) as typeof x.paseo.agents.ref;
  const append = x.h.records.appendInput.bind(x.h.records);
  const now = new Date().toISOString();
  vi.spyOn(x.h.records, "appendInput").mockImplementationOnce(async (...args) => {
    const saved = await append(...args);
    await x.store.mutate(board => board.automation.push({ taskId: "t", projectId: "p", state: "working", role: "implementer", generation: 1, implementerId: "actor", reviewRounds: 0, nudges: 0, failures: 0, queuedAt: now, updatedAt: now, rotation: { id: "rotation", fromAgentId: "actor", role: "implementer", reason: "requested", stage: "requested", forced: false, at: now, carry: { id: "work", role: "implementer", text: "continue", fresh: now } } }));
    return saved;
  });
  await expect(x.h.send({ ...x.identity, messageId: "racing", text: "留下但不要发给旧人", via: "session" })).rejects.toMatchObject({ code: "HANDOFF_PENDING" });
  expect(send).not.toHaveBeenCalled();
  expect((await x.h.records.read("t", "p")).inputs[0].text).toBe("留下但不要发给旧人");
});

test("restoring a card holds observation and new input until the full saved record is reinstated", async () => {
  const x = await fixture(), original = (await x.store.read()).tasks.find(t => t.id === "t")!;
  await x.h.comment({ taskId: "t", operationId: "preserve", text: "恢复后也要记住" });
  x.store.handoffBackup = async (ids, destination) => { for (const id of ids) await x.h.records.exportCard(id, join(destination, id)); };
  await x.h.removeWithBackup(["t"], () => x.store.deleteTask({ id: "t", revision: 1 }));
  let arrived!: () => void, release!: () => void;
  const published = new Promise<void>(resolve => { arrived = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const restore = x.h.withCards(["t"], async () => {
    await x.store.mutate(board => board.tasks.push(original)); arrived(); await wait;
    await x.h.restoreLocal(["t"], true);
  });
  await published;
  let observationStarted = false;
  const observation = x.h.serial("t", async () => {
    observationStarted = true;
    await x.h.records.setSession("t", "p", { agentId: "actor", n: 1, role: "manual", provider: "codex", reason: "launch", startedAt: new Date().toISOString(), finalized: false, turns: [], background: [], live: [] }, flowly);
  });
  await Promise.resolve(); expect(observationStarted).toBe(false);
  release(); await restore; await observation;
  const record = await x.h.records.read("t", "p"); expect(record.inputs[0].text).toBe("恢复后也要记住"); expect(record.ledger).toHaveLength(1);
});

test("the production project restore holds card observation until local handoff backups have been restored", async () => {
  const { BoardService } = await import("./service"), { ProjectFolders } = await import("./project-folder"), { HandoffObserver } = await import("./handoff-observer");
  const x = await fixture();
  await x.h.comment({ taskId: "t", operationId: "restore-project", text: "人的原话必须恢复" });
  const folders = new ProjectFolders(() => x.store.read()); await folders.flush(); folders.stop();
  x.store.handoffBackup = async (ids, destination) => { for (const id of ids) await x.h.records.exportCard(id, join(destination, id)); };
  await x.h.removeWithBackup(["t"], () => x.store.removeProject({ id: "p", revision: 1, alsoPaseo: false }));
  Object.assign(x.paseo, { projects: { list: async () => ({ projects: [{ projectId: "native", projectRootPath: x.a }] }) } });
  const service = new BoardService(x.store); service.restoreLock = x.h.withCards.bind(x.h); service.restoreHandoffs = ids => x.h.restoreLocal(ids, true);
  let publish!: () => void, release!: () => void;
  const published = new Promise<void>(resolve => { publish = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  const restore = x.store.restoreProject.bind(x.store);
  vi.spyOn(x.store, "restoreProject").mockImplementation(async (...args) => { const result = await restore(...args); publish(); await hold; return result; });
  const restoring = service.restoreProject({ path: x.a }, x.paseo); await published;
  const observer = new HandoffObserver({ records: x.h.records, board: x.store, paseo: x.paseo, serial: x.h.serial.bind(x.h), syncIndex: x.h.syncIndex.bind(x.h) });
  let observed = false; const observing = observer.ensureSession("t", "actor").then(() => { observed = true; });
  await Promise.resolve(); expect(observed).toBe(false);
  release(); await restoring; await observing; await observer.stop();
  expect((await x.h.records.read("t", "p")).inputs[0].text).toBe("人的原话必须恢复");
});

test("after a confirmation crash, a fresh service recovers an accepted question even when its old writer retired", async () => {
  const x = await fixture(), now = new Date().toISOString(); x.service.handoffs = x.h;
  await x.store.mutate(board => {
    board.projects[0].automation = { enabled: true, maxRunning: 2, maxReviewRounds: 3, nudgeLimit: 2, failureLimit: 2 } as never;
    board.automation.push({ taskId: "t", projectId: "p", state: "working", role: "implementer", generation: 1, implementerId: "actor", reviewRounds: 0, nudges: 0, failures: 0, queuedAt: now, updatedAt: now });
  });
  const current = await x.service.get(x.identity), question = { expectedRevision: current.revision, request: current.request, kind: "question" as const, note: "是否批准这一次清理？", acknowledgeOpen: true };
  await expect(x.service.write(x.identity, "progress", question)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
  const confirm = vi.spyOn(x.h, "confirmSource").mockRejectedValueOnce(new Error("confirmation crash"));
  await expect(x.service.write(x.identity, "progress", question)).rejects.toThrow("confirmation crash"); confirm.mockRestore();
  expect((await x.store.read()).handoffConfirmations).toHaveLength(1);
  await x.store.mutate(board => { const job = board.automation[0]; job.implementerId = "second"; job.retired = [{ agentId: "actor", role: "implementer", reason: "requested", at: now }]; });
  const recovered = new HandoffService(x.store); recovered.attach(x.paseo);
  await recovered.context("t", "second");
  const record = await recovered.records.read("t", "p");
  expect(record.questions[0]).toMatchObject({ text: question.note, status: "open" }); expect(record.questions[0].unconfirmed).toBeUndefined();
  expect(record.pendingOperations).toEqual([]); expect((await x.store.read()).handoffConfirmations).toBeUndefined();
  expect(await recovered.records.openIds("t")).toContain(record.questions[0].id);
});

test("retired writers cannot claim a current session's running item by changing its submitted owner", async () => {
  const x = await fixture(), now = new Date().toISOString();
  await x.store.mutate(board => board.automation.push({ taskId: "t", projectId: "p", state: "working", role: "implementer", generation: 1, implementerId: "second", retired: [{ agentId: "actor", role: "implementer", reason: "requested", at: now }], reviewRounds: 0, nudges: 0, failures: 0, queuedAt: now, updatedAt: now }));
  await x.h.records.update("t", "p", { handoffRevision: 0, set: [{ section: "running", id: "owned-by-second", owner: "second", what: "deployment", how: "inspect result", check: "deployment status", startedAt: now, status: "running" }] }, flowly);
  const before = await x.h.records.read("t", "p");
  await expect(x.h.update(x.identity, { handoffRevision: before.revision, set: [{ section: "running", id: "owned-by-second", owner: "actor", what: "overwrite", how: "none", check: "none", startedAt: now, status: "done" }] })).rejects.toMatchObject({ code: "RETIRED_SESSION" });
  expect((await x.h.records.read("t", "p")).running[0]).toMatchObject({ owner: "second", what: "deployment", status: "running" });
});
