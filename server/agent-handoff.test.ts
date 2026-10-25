import { afterEach, expect, test, vi } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { HandoffService } from "./handoff-service";
import { AutomationService } from "./automation";
import { ToolError } from "./tool-error";
import type { AutomationJob } from "../shared/automation";
import type { ToolPreparation } from "../shared/tools";

const roots: string[] = [], stopped: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const stop of stopped.splice(0)) await stop(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(options: { auto?: boolean; tags?: boolean } = {}) {
  const fixture = await agentFixture({ tags: options.tags }); roots.push(fixture.root);
  const handoffs = new HandoffService(fixture.store); handoffs.attach(fixture.paseo); fixture.service.handoffs = handoffs;
  if (options.auto) await fixture.store.mutate((board) => { board.projects[0].automation = { enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 }; });
  return { ...fixture, handoffs };
}
const job = (extra: Partial<AutomationJob> = {}): AutomationJob => ({ taskId: "t", projectId: "p", role: "implementer", state: "working", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra });
async function signed(x: Awaited<ReturnType<typeof setup>>) { const current = await x.service.get(x.identity); return { expectedRevision: current.revision, request: current.request }; }

test("get exposes bounded continuity and handoff updates need no signed board request or agent receipt", async () => {
  const x = await setup(), first = await x.service.get(x.identity); expect(first.handoff?.view?.complete).toBe(true); expect(first.handoff?.fresh).toBe(false);
  const result = await x.service.updateHandoff(x.identity, { handoffRevision: first.handoff!.revision, operationId: "checkpoint", state: "Ready to verify", set: [{ section: "next", text: "Run the migration rehearsal" }] });
  expect(result.ok).toBe(true); expect((await x.store.read()).agentReceipts).toEqual([]); expect((await x.handoffs.records.read("t", "p")).state?.text).toBe("Ready to verify");
  const full = await x.service.get(x.identity, true, false, { handoff: "full" }); expect(full.handoff?.page?.complete).toBe(true);
});

test("retired/finalizing sessions read continuity but cannot do ordinary writes or sub-card actions", async () => {
  const x = await setup({ auto: true }); await x.store.mutate((board) => { board.automation.push(job({ implementerId: "second", retired: [{ agentId: "actor", role: "implementer", at: new Date().toISOString(), reason: "history" }] })); });
  const context = await x.service.get(x.identity); expect(context.writable).toBe(false); expect(context.reason).toContain("RETIRED_SESSION");
  await expect(x.service.write(x.identity, "progress", { ...(await signed(x)), note: "stale write" })).rejects.toMatchObject({ code: "RETIRED_SESSION" });
  await expect(x.service.createCard(x.identity, { ...(await signed(x)), title: "stale child", start: "later" })).rejects.toMatchObject({ code: "RETIRED_SESSION" });
  await expect(x.service.updateCard(x.identity, { ...(await signed(x)), cardId: "child", action: "start" })).rejects.toMatchObject({ code: "RETIRED_SESSION" });
  await x.store.mutate((board) => { board.automation[0].implementerId = "actor"; board.automation[0].rotation = { id: "rotation", role: "implementer", fromAgentId: "actor", reason: "history", stage: "finalizing", forced: false, carry: { id: "instruction", role: "implementer", text: "continue", fresh: "continue" }, at: new Date().toISOString() }; });
  expect((await x.service.get(x.identity)).writable).toBe(false);
  await expect(x.service.write(x.identity, "progress", { ...(await signed(x)), note: "during finalization" })).rejects.toMatchObject({ code: "FINALIZING" });
});

test("the transaction rechecks replacement after the async authorizer has passed", async () => {
  const x = await setup({ auto: true }); await x.store.mutate((board) => { board.automation.push(job({ implementerId: "actor" })); }); const request = await signed(x);
  const assert = x.handoffs.assertWriter.bind(x.handoffs);
  vi.spyOn(x.handoffs, "assertWriter").mockImplementationOnce(async (...args) => { await assert(...args); await x.store.mutate((board) => { board.automation[0].implementerId = "second"; board.automation[0].retired = [{ agentId: "actor", role: "implementer", at: new Date().toISOString(), reason: "history" }]; }); });
  await expect(x.service.write(x.identity, "progress", { ...request, note: "raced old write" })).rejects.toMatchObject({ code: "RETIRED_SESSION" }); expect((await x.store.read()).agentReceipts).toHaveLength(0);
});

test("a stale question has one refusal before its full original is prepared and committed", async () => {
  const x = await setup({ auto: true }), prepare = vi.spyOn(x.handoffs, "prepareQuestion"), original = "?".repeat(10000), input = { ...(await signed(x)), kind: "question" as const, note: original, acknowledgeOpen: true };
  await expect(x.service.write(x.identity, "progress", input)).rejects.toMatchObject({ code: "HANDOFF_STALE" }); expect(prepare).not.toHaveBeenCalled(); expect((await x.store.read()).events).toHaveLength(0);
  await expect(x.service.write(x.identity, "progress", input)).resolves.toMatchObject({ replayed: false }); expect(prepare).toHaveBeenCalledTimes(1);
  const record = await x.handoffs.records.read("t", "p"); expect(record.questions).toHaveLength(1); expect(record.questions[0].text).toBe(original); expect(record.questions[0].unconfirmed).toBeUndefined(); expect(record.questions[0].status).toBe("open");
  await x.service.write(x.identity, "progress", input); expect(prepare).toHaveBeenCalledTimes(1); expect((await x.handoffs.records.read("t", "p")).questions).toHaveLength(1);
});

test("setup and handoff gaps share the existing refusal rather than producing sequential gates", async () => {
  const x = await setup({ auto: true, tags: false }), input = { ...(await signed(x)), status: "in_review" as const, note: "Delivered", outputs: [], acknowledgeOpen: true };
  await expect(x.service.write(x.identity, "status", input)).rejects.toMatchObject({ code: "SETUP_INCOMPLETE", message: expect.stringContaining("HANDOFF_STALE") });
  expect((await x.handoffs.records.read("t", "p")).reviews).toHaveLength(0);
  await expect(x.service.write(x.identity, "status", input)).resolves.toMatchObject({ receipt: { status: "in_review" } }); expect((await x.handoffs.records.read("t", "p")).reviews[0].delivery?.text).toBe("Delivered");
});

test("a board failure leaves an unconfirmed original that the same request can finish once", async () => {
  const x = await setup(), original = "q".repeat(10000), input = { ...(await signed(x)), note: original, kind: "blocker" as const }, transaction = x.store.transaction.bind(x.store), before = await readFile(x.store.path, "utf8");
  vi.spyOn(x.store, "transaction").mockImplementationOnce((operation) => transaction(async (board) => { await operation(board); throw new Error("commit failed"); }));
  await expect(x.service.write(x.identity, "progress", input)).rejects.toThrow("commit failed"); expect(await readFile(x.store.path, "utf8")).toBe(before);
  let record = await x.handoffs.records.read("t", "p"); expect(record.questions[0]).toMatchObject({ text: original, unconfirmed: true }); expect(record.pendingOperations).toHaveLength(1);
  await x.service.write(x.identity, "progress", input); record = await x.handoffs.records.read("t", "p"); expect(record.questions).toHaveLength(1); expect(record.questions[0].unconfirmed).toBeUndefined(); expect(record.pendingOperations).toHaveLength(0); expect((await x.store.read()).agentReceipts).toHaveLength(1);
});

test("unavailable source persistence cannot create a board delivery", async () => {
  const x = await setup(); vi.spyOn(x.handoffs, "prepareDelivery").mockRejectedValueOnce(new ToolError("HANDOFF_UNAVAILABLE", "disk unavailable"));
  const input = { ...(await signed(x)), status: "in_review" as const, note: "delivery", outputs: [] }; await expect(x.service.write(x.identity, "status", input)).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" }); expect((await x.store.read()).tasks[0].status).toBe("todo"); expect((await x.store.read()).agentReceipts).toHaveLength(0);
});

test("only an accepted review prepares source text; closed replay cannot introduce new findings", async () => {
  const x = await setup({ auto: true }), automation = new AutomationService(x.store, { clock: () => Date.now(), globalModel: async () => ({ provider: "claude", model: "claude-haiku-4-5" }), prepare: async (): Promise<ToolPreparation> => ({ agentId: "reviewer", contextFile: "/c", cliPath: "/cli", skillPath: "/s", instructions: "", mcp: { type: "http", url: "http://invalid", headers: {} } }) });
  stopped.push(() => automation.stop()); x.service.automation = automation;
  await x.store.mutate((board) => { board.tasks[0].status = "in_review"; board.automation.push(job({ role: "reviewer", state: "reviewing", implementerId: "second", reviewerId: "actor", reviewRounds: 1 })); });
  const originalPrepare = x.handoffs.prepareReview.bind(x.handoffs), prepare = vi.spyOn(x.handoffs, "prepareReview");
  await expect(x.service.review({ ...x.identity, agentId: "second" }, { verdict: "approve", summary: "not the reviewer" })).rejects.toMatchObject({ code: "NOT_REVIEWER" }); expect(prepare).not.toHaveBeenCalled();
  prepare.mockImplementationOnce(async (...args) => { await originalPrepare(...args); throw new Error("after review prepare"); });
  await expect(x.service.review(x.identity, { verdict: "approve", summary: "original summary" })).rejects.toThrow("after review prepare"); expect((await x.store.read()).automation[0].verdict).toBeUndefined(); expect((await x.handoffs.records.read("t", "p")).reviews[0].unconfirmed).toBe(true);
  await x.service.review(x.identity, { verdict: "approve", summary: "original summary" }); expect(prepare).toHaveBeenCalledTimes(2);
  await expect(x.service.review(x.identity, { verdict: "approve", summary: "different replay text", findings: ["not actually accepted"] })).resolves.toMatchObject({ replayed: true }); expect(prepare).toHaveBeenCalledTimes(2);
  const record = await x.handoffs.records.read("t", "p"); expect(record.reviews).toHaveLength(1); expect(record.reviews[0].summary).toBe("original summary"); expect(record.reviews[0].findings).toEqual([]); expect(record.reviews[0].unconfirmed).toBeUndefined();
});
