import { afterEach, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { agentFixture } from "./agent-fixture";
import { HandoffService } from "./handoff-service";

const execute = promisify(execFile);
const roots: string[] = [];
const flowly = { by: { kind: "flowly" as const } };
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const x = await agentFixture(); roots.push(x.root);
  const handoffs = new HandoffService(x.store); handoffs.attach(x.paseo); x.service.handoffs = handoffs;
  for (const path of [x.a, x.b]) {
    await execute("git", ["init", "-q", path]);
    await execute("git", ["-C", path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "seed"]);
  }
  await x.store.mutate(board => { board.projects[0].automation = { enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 }; });
  await x.service.updateHandoff(x.identity, {
    handoffRevision: 0, operationId: "initial-checkpoint", state: "Preparation complete; earlier external evidence is unavailable",
    set: [{ section: "next", text: "Ask the owner to supply the missing evidence" }],
  });
  await handoffs.records.appendGap("t", "p", {
    id: "known-gap", kind: "flowly", text: "Earlier external evidence is unavailable; this gap cannot honestly be closed", status: "open",
  }, { ...flowly, sourceId: "known-gap" });
  return { ...x, handoffs };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const context = (x: Fixture) => x.handoffs.context("t", "actor", { recordAccess: false });
async function question(x: Fixture) {
  const current = await x.service.get(x.identity);
  return { expectedRevision: current.revision, request: current.request, kind: "question" as const, note: "Preparation is complete, but earlier evidence remains unavailable. Please supply it.", acknowledgeOpen: true };
}
async function input(x: Fixture, id: string) {
  await x.handoffs.records.appendInput("t", "p", { atSource: "typed", via: "comment", text: `New human requirement ${id}`, status: "open", messageId: id }, { by: { kind: "human" }, sourceId: id });
}
async function review(x: Fixture, id: string) {
  const checkpoint = (await x.handoffs.records.read("t", "p")).checkpoint!;
  await x.handoffs.records.appendReview("t", "p", {
    id, at: new Date(Date.parse(checkpoint.at) + 1000).toISOString(), cycle: 1, round: 1, reviewerId: "reviewer", verdict: "changes",
    summary: `New confirmed requirement ${id}`, findings: [`Retain the original evidence ${id}`],
  }, { ...flowly, sourceId: id });
}

test("same-turn explicit acknowledgement survives a checkpoint update with the same unresolved evidence", async () => {
  const x = await fixture(); await input(x, "preserve-for-successor"); const request = await question(x);
  await expect(x.service.write(x.identity, "progress", request)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
  const before = await context(x);
  const original = (await x.handoffs.records.read("t", "p")).inputs[0];
  await x.service.updateHandoff(x.identity, {
    handoffRevision: before.revision, operationId: "refresh-checkpoint", state: "Preparation complete; earlier external evidence is unavailable",
    inputs: [{ id: original.id, status: "open", note: "Preserve this exact original for the successor" }],
  });
  const after = await context(x);
  expect(after.due).toEqual(before.due); expect(after.revision).toBeGreaterThan(before.revision);
  await expect(x.service.write(x.identity, "progress", request)).resolves.toMatchObject({ replayed: false });
});

test("same-turn explicit acknowledgement survives passive cursor and measurement updates", async () => {
  const x = await fixture();
  await x.handoffs.records.setSession("t", "p", { agentId: "actor", n: 1, role: "implementer", provider: "codex", reason: "launch", startedAt: new Date().toISOString(), finalized: false, turns: [], background: [], live: [] }, flowly);
  const request = await question(x);
  await expect(x.service.write(x.identity, "progress", request)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
  const before = await context(x);
  const written = await x.handoffs.records.capture("t", "p", {
    cursor: { agentId: "actor", through: { path: "fixture.jsonl", identity: "fixture-inode", offset: 80, size: 80, at: new Date().toISOString(), lagBytes: 0, gaps: 0 } },
    session: { ...(await x.handoffs.records.sessionRecord("t", "actor"))!, measured: { C: 12000, B: 800, turns: 1 }, live: [{ at: new Date().toISOString(), text: "The same work is in progress" }] },
  }, flowly);
  await x.handoffs.records.markSeen("t", "p", "actor", (await context(x)).revision, flowly);
  const after = await context(x);
  // Passive observation is written in place: stored, but under the same revision (SESSION-HANDOFF-SPEC §5.1).
  expect(written.stored).toBe("observation"); expect(after.due).toEqual(before.due); expect(after.revision).toBe(before.revision);
  await expect(x.service.write(x.identity, "progress", request)).resolves.toMatchObject({ replayed: false });
});

for (const change of [input, review]) test(`a new ${change.name} requires another refusal even when the generic due list is unchanged`, async () => {
  const x = await fixture(); await change(x, "first"); const request = await question(x);
  await expect(x.service.write(x.identity, "progress", request)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
  const before = await context(x); await change(x, "second"); expect((await context(x)).due).toEqual(before.due);
  await expect(x.service.write(x.identity, "progress", request)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
  await expect(x.service.write(x.identity, "progress", request)).resolves.toMatchObject({ replayed: false });
});

test("a new critical gap requires another refusal without changing the generic due list", async () => {
  const x = await fixture(), request = await question(x);
  await expect(x.service.write(x.identity, "progress", request)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
  const before = await context(x);
  await x.handoffs.records.appendGap("t", "p", { id: "new-gap", kind: "flowly", text: "A different required source was lost", status: "open" }, { ...flowly, sourceId: "new-gap" });
  expect((await context(x)).due).toEqual(before.due);
  await expect(x.service.write(x.identity, "progress", request)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
  await expect(x.service.write(x.identity, "progress", request)).resolves.toMatchObject({ replayed: false });
});

test("a human note is new information even when it does not change a generic due reason", async () => {
  const x = await fixture(), request = await question(x);
  await expect(x.service.write(x.identity, "progress", request)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
  const before = await context(x);
  await x.handoffs.records.appendNote("t", "p", { kind: "other", text: "The missing evidence must be verified against a separate source" }, { by: { kind: "human" }, sourceId: "human-note" });
  expect((await context(x)).due).toEqual(before.due);
  await expect(x.service.write(x.identity, "progress", request)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
  await expect(x.service.write(x.identity, "progress", request)).resolves.toMatchObject({ replayed: false });
});

test("an unchanged handoff allows the existing same-turn retry", async () => {
  const x = await fixture(), request = await question(x);
  await expect(x.service.write(x.identity, "progress", request)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
  await expect(x.service.write(x.identity, "progress", request)).resolves.toMatchObject({ replayed: false });
});

test("moving pending originals into overflow for observation data does not reset acknowledgement", async () => {
  const x = await fixture(); await input(x, "retained");
  await x.handoffs.records.capture("t", "p", { entries: Array.from({ length: 25 }, (_, index) => ({
    section: "questions" as const, value: { id: `earlier-question-${index}`, text: "q".repeat(10000), askedBy: "actor", kind: "question", status: "open" },
  })) }, flowly);
  const request = await question(x);
  await expect(x.service.write(x.identity, "progress", request)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
  await x.handoffs.records.setSession("t", "p", {
    agentId: "actor", n: 1, role: "implementer", provider: "codex", reason: "launch", startedAt: new Date().toISOString(),
    finalized: false, skeleton: "x".repeat(800 * 1024), turns: [], background: [], live: [],
  }, flowly);
  const record = await x.handoffs.records.read("t", "p");
  expect(record.overflow.some(entry => entry.section === "inputs" && entry.requirementsHash)).toBe(true);
  await expect(x.service.write(x.identity, "progress", request)).resolves.toMatchObject({ replayed: false });
});
