import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { agentFixture } from "./agent-fixture";
import { AutomationService } from "./automation";
import type { ToolPreparation } from "../shared/tools";
import { reviewerChecklist, turnChecklist } from "../shared/turn-checklist";
import { changesPrompt, nudgePrompt, startPrompt, type AutomationJob } from "../shared/automation";

// Upstream's turn checklist and refusal-first delivery gate under the fork's automation (AUTOMATION-SPEC §4.2, §7).
const roots: string[] = [];
const services: AutomationService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const stamp = () => new Date().toISOString();
const job = (extra: Partial<AutomationJob>): AutomationJob => ({
  taskId: "t", projectId: "p", role: "implementer", state: "working", generation: 1,
  nudges: 0, failures: 0, reviewRounds: 0, queuedAt: stamp(), updatedAt: stamp(), ...extra,
});

async function setup(seed?: Parameters<typeof agentFixture>[0]) {
  const x = await agentFixture(seed);
  roots.push(x.root);
  await x.store.mutate((board) => {
    board.projects[0].automation = { enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 };
  });
  return x;
}

type Fixture = Awaited<ReturnType<typeof setup>>;
const signed = async (x: Fixture, identity = x.identity) => {
  const ctx = await x.service.get(identity);
  return { expectedRevision: ctx.revision, request: ctx.request };
};

test("a reviewer reads the reviewer checklist and cannot work the card; its verdict still lands", async () => {
  const x = await setup();
  const automation = new AutomationService(x.store, {
    clock: () => Date.now(),
    globalModel: async () => ({ provider: "claude", model: "claude-haiku-4-5" }),
    prepare: async (taskId): Promise<ToolPreparation> => ({ agentId: `${taskId}-agent`, contextFile: "/c", cliPath: "/cli", skillPath: "/s", instructions: "", mcp: { type: "http", url: "http://x", headers: {} } }),
  });
  services.push(automation);
  automation.attach(x.paseo as PaseoApi);
  x.service.automation = automation;
  await x.store.mutate((board) => {
    board.tasks[0].status = "in_review";
    board.automation.push(job({ role: "reviewer", state: "reviewing", implementerId: "second", reviewerId: "actor", reviewRounds: 1 }));
  });
  const implementer = { ...x.identity, agentId: "second" };
  expect((await x.service.get(x.identity)).turnChecklist).toEqual(reviewerChecklist);
  expect((await x.service.get(implementer)).turnChecklist).toEqual(turnChecklist);

  const before = await x.store.read();
  const refused: [Parameters<typeof x.service.write>[1], Record<string, unknown>][] = [
    ["status", { status: "test", note: "Running the checks" }],
    ["progress", { kind: "result", note: "Checks pass", outputs: [] }],
    ["workpad", { workpadRevision: 1, acceptance: [{ text: "Reviewer edit", done: true }], validation: [], confusions: [] }],
    ["tags", { add: ["review"], remove: [] }],
    ["artifact", { role: "output", target: "https://example.com/review" }],
  ];
  for (const [action, fields] of refused)
    await expect(x.service.write(x.identity, action, { ...(await signed(x)), ...fields }), action).rejects.toMatchObject({ code: "REVIEWER_ONLY" });
  const after = await x.store.read();
  expect(after.tasks[0]).toEqual(before.tasks[0]);
  expect(after.workpads).toEqual(before.workpads);
  expect(after.artifacts).toEqual(before.artifacts);

  // Asking a person stays open to the reviewer.
  const question = await x.service.write(x.identity, "progress", { ...(await signed(x)), kind: "question", note: "Is the API change intended?" });
  expect(question.receipt.action).toBe("progress");

  await expect(x.service.review(x.identity, { verdict: "approve", summary: "Checks pass" })).resolves.toMatchObject({ accepted: true });
  const settled = await x.store.read();
  expect(settled.tasks[0].status).toBe("in_review");
  expect(settled.automation[0]).toMatchObject({ verdict: "approved" });
});

test("a supervised implementer's acknowledged first delivery is refused, the retry passes, and a new turn needs a new refusal", async () => {
  const x = await setup({ tags: false });
  await x.store.mutate((board) => {
    board.tasks[0].status = "development";
    board.automation.push(job({ implementerId: "actor" }));
  });
  const deliver = async (note: string) =>
    x.service.write(x.identity, "status", { ...(await signed(x)), status: "in_review", note, outputs: [], acknowledgeOpen: true });
  await expect(deliver("Delivered")).rejects.toMatchObject({ code: "SETUP_INCOMPLETE" });
  expect((await x.store.read()).tasks[0].status).toBe("development");
  expect((await deliver("Delivered; no tags: the card spans no module")).receipt.status).toBe("in_review");

  // The reviewer asked for changes; the next [Flowly automation] turn starts with a cleared gate (index.server.ts turn_started).
  await x.store.mutate((board) => {
    board.tasks[0].status = "development";
    board.tasks[0].revision++;
  });
  x.service.turnStarted(x.identity);
  await expect(deliver("Delivered again")).rejects.toMatchObject({ code: "SETUP_INCOMPLETE" });
  expect((await deliver("Delivered again; no tags: the card spans no module")).receipt.status).toBe("in_review");
});

test("automation messages tell the implementer to retry a refused delivery in the same turn and to commit first", () => {
  for (const text of [startPrompt({ review: true, again: false }), nudgePrompt(1, 2), changesPrompt(1, 3, "Fix it", ["a.ts: wrong"]), changesPrompt(3, 3, "Fix it", ["a.ts: wrong"], 3)]) {
    expect(text).toContain("retry in this same turn with acknowledgeOpen=true");
    expect(text).toContain("do not end the turn on the refusal");
  }
  expect(startPrompt({ review: false, again: true })).toContain("Commit your changes on the card's branch before delivering");
  expect(startPrompt({ review: false, again: false })).toContain("does not end an automated turn");
});
