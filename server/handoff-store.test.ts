import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, readdir, writeFile, rm, stat, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HandoffStore, type HandoffContext } from "./handoff-store";
import { handoffLimits, handoffOpenIds, type HandoffPage } from "../shared/handoff";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(fault?: (point: string) => void | Promise<void>) { const dir = await mkdtemp(join(tmpdir(), "flowly-handoff-")); folders.push(dir); return { dir, store: new HandoffStore(dir, { fault }) }; }
const actor: HandoffContext = { by: { kind: "agent", agentId: "worker" } };
const human: HandoffContext = { by: { kind: "human" } };
function session(agentId = "worker") { return { agentId, n: 1, role: "implementer" as const, provider: "codex", reason: "start", startedAt: "2026-10-24T00:00:00Z", finalized: false, turns: [], background: [], live: [] }; }
async function pages(store: HandoffStore, options: Parameters<HandoffStore["page"]>[1] = {}) { const result: HandoffPage[] = []; let cursor: string | undefined; do { const page = await store.page("card", cursor ? { cursor } : options); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(handoffLimits.pageBytes); result.push(page); cursor = page.nextCursor; if (result.length > 2000) throw new Error("page loop"); } while (cursor); return result; }

describe("durable handoff", () => {
  test("missing read is an empty projection without creating a file; corrupt data is preserved", async () => {
    const { dir, store } = await fixture(); expect((await store.read("card", "project")).revision).toBe(0); expect(await readdir(dir)).toEqual([]);
    await store.appendInput("card", "project", { via: "comment", text: "hello" }, human);
    const file = join(dir, "handoffs/card.json"); await writeFile(file, "{broken"); await expect(store.read("card")).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" }); expect(await readFile(file, "utf8")).toBe("{broken");
  });
  test("keeps identical words from distinct sources and source operation retries do not duplicate", async () => {
    const { store } = await fixture(); const draft = { via: "comment" as const, text: "do this" };
    const context = { ...human, sourceId: "comment:a", operationId: "op:a", unconfirmed: true };
    const first = await store.appendInput("card", "project", draft, context);
    expect((await store.appendInput("card", "project", draft, context)).replayed).toBe(true);
    await store.appendInput("card", "project", draft, { ...context, sourceId: "comment:b", operationId: "op:b" });
    const pending = await store.read("card", "project"); expect(pending.inputs).toHaveLength(2); expect(handoffOpenIds(pending)).toEqual([]); expect(pending.pendingOperations).toHaveLength(2);
    await store.confirmSource("card", "project", "comment:a", { ...human, operationId: "confirm:a" });
    expect(handoffOpenIds(await store.read("card", "project"))).toEqual([pending.inputs[0].id]);
    await expect(store.appendInput("card", "project", { ...draft, text: "changed" }, context)).rejects.toMatchObject({ code: "OPERATION_REUSED" });
    expect(first.handoffRevision).toBe(1);
  });
  test("writes independent entries from stale reads but detects same-entry conflicts and preserves reasons", async () => {
    const { store } = await fixture(); await store.update("card", "project", { handoffRevision: 0, set: [{ section: "decisions", id: "decision", text: "small file", why: "bounded current state" }] }, actor);
    await store.update("card", "project", { handoffRevision: 0, set: [{ section: "next", id: "next", text: "verify migration" }] }, actor);
    await expect(store.update("card", "project", { handoffRevision: 0, set: [{ section: "decisions", id: "decision", text: "other", why: "new reason" }] }, actor)).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    const state = await store.read("card", "project"); expect(state.decisions[0].why).toBe("bounded current state"); expect(state.next).toHaveLength(1);
  });
  test.each(["intent-synced", "archive-synced", "current-synced", "sources-synced", "intent-removed"])("recovers one committed source exactly once after %s", async (point) => {
    let armed = true; const { dir, store } = await fixture((at) => { if (armed && at === point) { armed = false; throw new Error("power loss"); } });
    const context = { ...human, sourceId: "comment:a", operationId: "op:a", unconfirmed: true }, draft = { via: "comment" as const, text: "never lose this" };
    await expect(store.appendInput("card", "project", draft, context)).rejects.toThrow("power loss");
    const reopened = new HandoffStore(dir); const replay = await reopened.appendInput("card", "project", draft, context); expect(replay.replayed).toBe(true); expect((await reopened.read("card", "project")).inputs).toHaveLength(1);
    await reopened.confirmSource("card", "project", "comment:a", { ...human, operationId: "confirm:a" }); expect(await reopened.openIds("card")).toHaveLength(1);
  });
  test("long original Unicode input is external, paged losslessly, and never mistaken for a preview", async () => {
    const { store, dir } = await fixture(); const original = '你好🙂\n"\\'.repeat(50000);
    await store.appendInput("card", "project", { via: "session", text: original }, { ...human, sourceId: "message:1" });
    const record = await store.read("card", "project"), input = record.inputs[0]; expect(input.text).toBeUndefined(); expect(input.firstLine).toBe('你好🙂'); expect(input.characters).toBe(original.length); expect((await stat(join(dir, "handoffs/card.json"))).size).toBeLessThan(10000);
    const result = await pages(store, { entryId: input.id }); expect(result.at(-1)?.complete).toBe(true); expect(result.flatMap((p) => p.items).filter((i) => i.field === "text").map((i) => i.text).join("")).toBe(original);
  });
  test("preserves full 10000-character questions and delivery notes", async () => {
    const { store } = await fixture(); const note = "长".repeat(10000);
    await store.appendQuestion("card", "project", { kind: "blocker", askedBy: "worker", text: note }, actor);
    await store.appendReview("card", "project", { cycle: 1, round: 1, reviewerId: "reviewer", verdict: "changes", summary: "s".repeat(4000), findings: ["fix storage"], delivery: { text: note } }, actor);
    const record = await store.read("card", "project"); expect(record.questions[0].text).toBe(note); expect(record.reviews[0].delivery?.text).toBe(note);
    const result = await pages(store, { entryId: record.reviews[0].id }); expect(result[0].items[0].value).toMatchObject({ delivery: { text: note } });
  });
  test("answered questions must link to a confirmed original answer", async () => {
    const { store } = await fixture(); await store.appendQuestion("card", "project", { id: "question", kind: "question", askedBy: "worker", text: "delete?" }, actor);
    await store.appendInput("card", "project", { id: "answer", via: "comment", text: "yes" }, { ...human, sourceId: "comment:answer", unconfirmed: true });
    await expect(store.update("card", "project", { handoffRevision: 2, questions: [{ id: "question", status: "answered", answerInputIds: ["answer"] }] }, actor)).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    await store.confirmSource("card", "project", "comment:answer", human);
    await store.update("card", "project", { handoffRevision: 3, questions: [{ id: "question", status: "answered", answerInputIds: ["answer"] }] }, actor);
    const record = await store.read("card", "project"); expect(record.questions[0].answeredBy).toEqual(["answer"]); expect(record.inputs[0].answers).toEqual(["question"]);
  });
  test("capture persists semantics and the complete resume state before publishing a cursor", async () => {
    let armed = false; const { store, dir } = await fixture((point) => { if (armed && point === "intent-synced") { armed = false; throw new Error("crash"); } });
    await store.setSession("card", "project", session(), actor); armed = true;
    const cursor = { path: "log", identity: "inode", offset: 100, size: 100, at: "2026-10-24T00:00:00Z", lagBytes: 0, gaps: 0, resume: { epoch: 2, pending: [{ id: "call" }] } };
    await expect(store.capture("card", "project", { entries: [{ section: "inputs", value: { id: "captured", sourceId: "log:1", via: "session", atSource: "captured", text: "important", characters: 9, status: "open" } }], cursor: { agentId: "worker", through: cursor } }, { ...actor, operationId: "capture:1" })).rejects.toThrow("crash");
    const reopened = new HandoffStore(dir), record = await reopened.read("card", "project"); expect(record.inputs[0].text).toBe("important"); expect(record.ledger[0].through).toEqual(cursor);
  });
  test("only agent narrative writes refresh checkpoint; independent Git observation and ACK do not", async () => {
    const { store } = await fixture(); await store.setSession("card", "project", session(), actor);
    await store.update("card", "project", { handoffRevision: 1, state: "doing" }, actor, { actualHeads: [{ repo: "repo", sha: "aaa", dirty: true }], dirtyHash: "dirty", turnStartedAt: "start" });
    const checkpoint = (await store.read("card", "project")).checkpoint; expect(checkpoint).toMatchObject({ dirtyHash: "dirty", turnStartedAt: "start" });
    await store.capture("card", "project", { git: [{ repo: "repo", sha: "bbb", dirty: false, at: "later" }] }, { by: { kind: "flowly" } });
    await store.markSeen("card", "project", "worker", 3, actor); expect((await store.read("card", "project")).checkpoint).toEqual(checkpoint);
  });
});

describe("handoff archive and bounds", () => {
  test("an interrupted archive append is completed from the known byte prefix before pruning current", async () => {
    let armed = false; const { dir, store } = await fixture((point) => { if (armed && point === "intent-synced") { armed = false; throw new Error("crash"); } });
    await store.update("card", "project", { handoffRevision: 0, set: [{ section: "decisions", id: "decision", text: "first", why: "original reason" }] }, actor);
    armed = true; const update = { handoffRevision: 1, operationId: "edit", set: [{ section: "decisions" as const, id: "decision", text: "second", why: "new reason" }] };
    await expect(store.update("card", "project", update, actor)).rejects.toThrow("crash");
    const pending = JSON.parse(await readFile(join(dir, "handoffs/card/pending.json"), "utf8")); expect(pending.archiveData.length).toBeGreaterThan(0);
    await appendFile(join(dir, "handoffs/card/archive.jsonl"), Buffer.from(pending.archiveData).subarray(0, 37));
    expect(JSON.parse(await readFile(join(dir, "handoffs/card.json"), "utf8")).decisions[0].text).toBe("first");
    const reopened = new HandoffStore(dir); expect((await reopened.update("card", "project", update, actor)).replayed).toBe(true);
    expect((await reopened.read("card", "project")).decisions[0].text).toBe("second");
    const archived = await pages(reopened, { scope: "archive" }); expect(archived.flatMap((p) => p.items).map((i) => i.value)).toContainEqual(expect.objectContaining({ text: "first", why: "original reason" }));
    expect((await readFile(join(dir, "handoffs/card/archive.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
  });
  test("unexpected archive bytes preserve the intent and original current record", async () => {
    let armed = false; const { dir, store } = await fixture((point) => { if (armed && point === "intent-synced") { armed = false; throw new Error("crash"); } });
    await store.update("card", "project", { handoffRevision: 0, state: "before" }, actor); armed = true;
    await expect(store.appendInput("card", "project", { via: "comment", text: "after" }, human)).rejects.toThrow("crash");
    await appendFile(join(dir, "handoffs/card/archive.jsonl"), "unexpected"); await expect(new HandoffStore(dir).read("card")).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" });
    expect(JSON.parse(await readFile(join(dir, "handoffs/card.json"), "utf8")).state.text).toBe("before"); expect(await stat(join(dir, "handoffs/card/pending.json"))).toBeTruthy();
  });
  test("open overflow entries remain in every complete ACK set even when their bodies leave the current list", async () => {
    const { store } = await fixture(); await store.setSession("card", "project", session(), actor);
    await store.capture("card", "project", { entries: Array.from({ length: 205 }, (_, n) => ({ section: "inputs" as const, value: { id: `input:${n}:${"x".repeat(180)}`, sourceId: `message:${n}`, via: "comment", atSource: "typed", text: `instruction ${n}`, characters: 15, status: "open" } })) }, { by: { kind: "flowly" } });
    let record = await store.read("card", "project"); expect(record.inputs).toHaveLength(200); expect(record.overflow).toHaveLength(5); expect(handoffOpenIds(record)).toHaveLength(205);
    const partial = await store.update("card", "project", { handoffRevision: record.revision, ack: { handoffRevision: record.revision, heads: [{ repo: "repo", sha: "head", dirty: false }], understanding: "continue", items: record.inputs.map((i) => ({ id: i.id, disposition: "doing" as const })) } }, actor, { actualHeads: [{ repo: "repo", sha: "head", dirty: false }] });
    expect(partial.ackMissing).toHaveLength(5); record = await store.read("card", "project"); expect(record.ledger[0].ack?.complete).toBe(false);
    const result = await pages(store, { scope: "current" }); expect(new Set(result.flatMap((p) => p.openIds))).toHaveProperty("size", 205); expect(result.flatMap((p) => p.items).filter((i) => i.section === "inputs")).toHaveLength(205);
    const overflow = record.overflow.find((e) => e.section === "inputs")!;
    const full = await pages(store, { entryId: overflow.id }); expect(full.flatMap((p) => p.items).map((i) => i.value)).toContainEqual(expect.objectContaining({ text: "instruction 0" }));
    await store.update("card", "project", { handoffRevision: record.revision, ack: { handoffRevision: record.revision, heads: [], understanding: "non-git root; all ids addressed", items: handoffOpenIds(record).map((id) => ({ id, disposition: "doing" as const })) } }, actor, { actualHeads: [{ repo: "not-git", sha: null, dirty: false }] });
    expect((await store.read("card", "project")).ledger[0].ack?.complete).toBe(true);
  }, 30000);
  test("pages bind the card and revision, and large review bodies are reconstructable", async () => {
    const { store } = await fixture(); const review = { cycle: 1, round: 1, reviewerId: "reviewer", verdict: "changes" as const, summary: "长".repeat(4000), findings: Array.from({ length: 20 }, (_, n) => ({ id: `finding:${n}`, text: "详".repeat(1000), status: "open" as const })), delivery: { text: "原".repeat(10000) }, risks: Array(10).fill("险".repeat(500)), gaps: Array(5).fill("缺".repeat(300)) };
    await store.appendReview("card", "project", review, actor); const record = await store.read("card", "project"); const full = await pages(store, { entryId: record.reviews[0].id });
    const serialized = full.flatMap((p) => p.items).filter((i) => i.field === "json").map((i) => i.text).join(""); expect(JSON.parse(serialized)).toMatchObject({ summary: review.summary, delivery: review.delivery, findings: review.findings });
    const cursor = full[0].nextCursor!; await expect(store.page("other", { cursor })).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    await store.appendNote("card", "project", { kind: "incident", text: "changed view" }, human); expect(await store.page("card", { cursor })).toMatchObject({ viewChanged: true, complete: false });
  });
  test("sealed rotation snapshots are immutable and backups include long originals and archives", async () => {
    const { store, dir } = await fixture(); const original = "original".repeat(10000); await store.appendInput("card", "project", { via: "launch", text: original }, human);
    const first = await store.seal("card", "rotation", "project"); await store.appendNote("card", "project", { kind: "direction", text: "new" }, human); expect((await store.seal("card", "rotation")).revision).toBe(first.revision);
    const backup = join(dir, "backup"); await store.exportCard("card", backup); const expected = await store.read("card", "project"); await store.removeCard("card"); expect(await store.read("card")).toBeNull(); await store.restoreCard("card", backup);
    expect(await store.read("card", "project")).toEqual(expected); const full = await pages(store, { entryId: expected.inputs[0].id }); expect(full.flatMap((p) => p.items).filter((i) => i.field === "text").map((i) => i.text).join("")).toBe(original);
  });
  test("full unresolved-index budget rejects the new operation while preserving every existing index", async () => {
    const { store, dir } = await fixture(); await store.appendInput("card", "project", { via: "comment", text: "base" }, human); const record = await store.read("card", "project"); record.inputs = [];
    const item = { section: "inputs" as const, id: "x", rev: 1, at: "2026-10-24", status: "open", firstLine: "未".repeat(160), contentRef: "a".repeat(64), openIds: ["x"] };
    let n = 0; while (Buffer.byteLength(JSON.stringify(record)) + Buffer.byteLength(JSON.stringify(item)) + 100 < handoffLimits.currentBytes) { const id = `pending:${n++}`; record.overflow.push({ ...item, id, openIds: [id] }); }
    const file = join(dir, "handoffs/card.json"); await writeFile(file, JSON.stringify(record)); const before = await readFile(file, "utf8");
    await expect(store.appendInput("card", "project", { via: "comment", text: "new".repeat(1000) }, { ...human, sourceId: "new", unconfirmed: true })).rejects.toMatchObject({ code: "HANDOFF_TOO_LARGE" });
    expect(await readFile(file, "utf8")).toBe(before); expect((await store.read("card", "project")).overflow).toHaveLength(n);
  });
});

test("markSeen is a bounded read cache and cannot make its own revision appear perpetually new", async () => {
  const { store, dir } = await fixture(); await store.update("card", "project", { handoffRevision: 0, state: "active" }, actor);
  const first = await store.read("card", "project"); await store.markSeen("card", "project", "worker", first.revision, actor); const file = join(dir, "handoffs/card.json"), before = await readFile(file, "utf8");
  const result = await store.markSeen("card", "project", "worker", first.revision, actor); expect(result.handoffRevision).toBe(first.revision); expect(await readFile(file, "utf8")).toBe(before); expect((await store.read("card", "project")).updatedAt).toBe(first.updatedAt);
});

test.each(["restore-intent", "restore-staged", "restore-data", "restore-current"])("restores the card record and its original text after %s", async (point) => {
  let armed = false; const { store, dir } = await fixture((at) => { if (armed && point === at) { armed = false; throw new Error("restore crash"); } });
  await store.appendInput("card", "project", { via: "launch", text: "original".repeat(1000) }, human); const expected = await store.read("card", "project"), backup = join(dir, "backup"); await store.exportCard("card", backup); await store.removeCard("card"); armed = true;
  await expect(store.restoreCard("card", backup)).rejects.toThrow("restore crash"); const reopened = new HandoffStore(dir); expect(await reopened.read("card", "project")).toEqual(expected); expect(await reopened.restoreCard("card", backup)).toEqual(expected);
  expect((await pages(reopened, { entryId: expected.inputs[0].id })).flatMap((p) => p.items).filter((i) => i.field === "text").map((i) => i.text).join("")).toBe("original".repeat(1000));
});

test("an unconfirmed source remains recoverable after its operation leaves the short dedup ring", async () => {
  const { store, dir } = await fixture(); const context = { ...human, sourceId: "board:event", operationId: "original-operation", unconfirmed: true }, draft = { via: "comment" as const, text: "original direction" };
  await store.appendInput("card", "project", draft, context);
  for (let n = 0; n < 51; n++) await store.appendNote("card", "project", { kind: "checkpoint", text: `note ${n}` }, { ...actor, operationId: `note:${n}` });
  const reopened = new HandoffStore(dir), before = await reopened.read("card", "project"); expect(before.ops).not.toContain(context.operationId); expect(before.pendingOperations).toEqual([expect.objectContaining({ id: context.operationId, sourceId: context.sourceId })]);
  expect((await reopened.appendInput("card", "project", draft, context)).replayed).toBe(true); await reopened.confirmSource("card", "project", context.sourceId, human); expect(await reopened.openIds("card")).toEqual([before.inputs[0].id]);
}, 15000);

test("typed and captured envelopes deduplicate by stable source and unchanged original words", async () => {
  const { store } = await fixture(); await store.appendInput("card", "project", { via: "comment", atSource: "typed", text: "same words", commentId: "comment", messageId: "message" }, { ...human, sourceId: "message:1", operationId: "typed" });
  await store.appendInput("card", "project", { via: "session", atSource: "captured", text: "same words", messageId: "message" }, { ...human, sourceId: "message:1", operationId: "captured" });
  expect((await store.read("card", "project")).inputs).toHaveLength(1);
  await store.appendInput("card", "project", { via: "session", text: "different words" }, { ...human, sourceId: "message:1", operationId: "different" });
  const record = await store.read("card", "project"); expect(record.inputs[0].text).toBe("same words"); expect(record.inputs.find((entry) => entry.text === "different words")).toMatchObject({ status: "open" }); expect(record.gaps).toHaveLength(1);
});

test("removal archives retain the reason and actor as well as the removed content", async () => {
  const { store } = await fixture(); await store.update("card", "project", { handoffRevision: 0, set: [{ section: "ruledOut", id: "old", text: "legacy option", why: "too much complexity" }] }, actor);
  await store.update("card", "project", { handoffRevision: 1, remove: [{ section: "ruledOut", id: "old", reason: "superseded by verified simpler design" }] }, actor);
  expect((await store.read("card", "project")).ruledOut).toHaveLength(0);
  const archive = await pages(store, { scope: "archive" }); expect(archive.flatMap((p) => p.items).map((i) => i.value)).toContainEqual(expect.objectContaining({ text: "legacy option", why: "too much complexity", removal: expect.objectContaining({ reason: "superseded by verified simpler design", by: actor.by }) }));
});

test("a direct partial ACK continuation keeps earlier explicit dispositions, while an intervening update requires a fresh set", async () => {
  const { store } = await fixture(); await store.setSession("card", "project", session(), actor);
  await store.appendInput("card", "project", { id: "one", via: "comment", text: "first" }, human); await store.appendInput("card", "project", { id: "two", via: "comment", text: "second" }, human);
  const heads = [{ repo: "repo", sha: "head", dirty: false }];
  await store.update("card", "project", { handoffRevision: 3, ack: { handoffRevision: 3, heads, understanding: "first page", items: [{ id: "one", disposition: "doing" }] } }, actor, { actualHeads: heads });
  await store.markSeen("card", "project", "worker", 4, actor);
  const complete = await store.update("card", "project", { handoffRevision: 4, ack: { handoffRevision: 4, heads, understanding: "next page", items: [{ id: "two", disposition: "doing" }] } }, actor, { actualHeads: heads }); expect(complete.ackMissing).toBeUndefined(); expect((await store.read("card", "project")).ledger[0].ack?.items).toHaveLength(2);
  await store.appendNote("card", "project", { kind: "direction", text: "changed since ack" }, human);
  const fresh = await store.update("card", "project", { handoffRevision: 6, ack: { handoffRevision: 6, heads, understanding: "reread changed record", items: [{ id: "two", disposition: "doing" }] } }, actor, { actualHeads: heads }); expect(fresh.ackMissing).toEqual(["one"]);
});

test("capture receipt upgrades never reopen handled input and typed original replaces its captured variant without erasing it", async () => {
  const { store } = await fixture(); const context = { ...human, sourceId: "message:1" };
  await store.appendInput("card", "project", { via: "session", atSource: "captured", messageId: "m", text: "captured" }, context);
  await store.appendInput("card", "project", { via: "session", atSource: "captured", messageId: "m", text: "captured", status: "received" }, context);
  let record = await store.read("card", "project"); expect(record.inputs[0].status).toBe("received");
  await store.appendInput("card", "project", { via: "comment", atSource: "typed", messageId: "m", text: "typed original", status: "open" }, context);
  record = await store.read("card", "project"); expect(record.inputs[0]).toMatchObject({ text: "typed original", atSource: "typed", via: "comment", status: "received" }); expect(record.gaps).toHaveLength(1);
  await store.update("card", "project", { handoffRevision: record.revision, inputs: [{ id: record.inputs[0].id, status: "done" }] }, actor);
  await store.appendInput("card", "project", { via: "session", atSource: "captured", messageId: "m", text: "typed original", status: "received" }, context);
  expect((await store.read("card", "project")).inputs[0].status).toBe("done");
  expect((await pages(store, { scope: "archive" })).flatMap((page) => page.items).map((item) => item.value)).toContainEqual(expect.objectContaining({ text: "captured" }));
});

test("sessionRecord retrieves a closed archived session without scanning pending original inputs", async () => {
  const { store, dir } = await fixture(); await store.setSession("card", "project", { ...session("old"), endedAt: "2026-10-24T01:00:00Z", endReason: "history" }, actor);
  const record = await store.read("card", "project"), old = record.ledger[0]; record.ledger = [];
  await writeFile(join(dir, "handoffs/card.json"), JSON.stringify(record));
  expect(await store.sessionRecord("card", "old")).toMatchObject({ agentId: "old", endReason: "history" }); expect(await store.sessionRecord("card", "unknown")).toBeNull();
  await writeFile(join(dir, `handoffs/card/entries/${old.contentRef}.json`), "corrupt"); await expect(store.sessionRecord("card", "old")).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" });
});

test("external original-text corruption and changes between pages are reported, never returned as saved original words", async () => {
  const { store, dir } = await fixture(); const original = "a".repeat(50000); await store.appendInput("card", "project", { via: "comment", text: original }, { ...human, sourceId: "original" });
  const record = await store.read("card", "project"), entry = record.inputs[0], metadata = await store.page("card", { entryId: entry.id }), firstBody = await store.page("card", { cursor: metadata.nextCursor }); expect(firstBody.items[0].field).toBe("text");
  const file = join(dir, `handoffs/card/inputs/${entry.textRef}.txt`); await writeFile(file, "b".repeat(50000));
  await expect(store.page("card", { cursor: firstBody.nextCursor })).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" });
  const reopened = new HandoffStore(dir), freshMetadata = await reopened.page("card", { entryId: entry.id }); await expect(reopened.page("card", { cursor: freshMetadata.nextCursor })).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" }); expect(await readFile(file, "utf8")).toBe("b".repeat(50000));
});

describe("global handoff identities", () => {
  test("an original input id cannot be reused by another section or overwrite its page lookup", async () => {
    const { store, dir } = await fixture(); await store.appendInput("card", "project", { id: "shared", via: "comment", text: "Original requirement" }, human);
    const revision = (await store.read("card", "project")).revision, before = await readFile(join(dir, "handoffs/card.json"), "utf8");
    await expect(store.update("card", "project", { handoffRevision: revision, set: [{ section: "running", id: "shared", what: "Independent process", how: "poll", check: "output", owner: "worker", startedAt: "now", status: "running" }] }, actor)).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    expect(await readFile(join(dir, "handoffs/card.json"), "utf8")).toBe(before); expect((await store.page("card", { entryId: "shared" })).items[0].value).toMatchObject({ text: "Original requirement" });
  });
  test.each(["input", "running", "finding", "background"])("the state identity is reserved against %s aliases before a state is written", async (kind) => {
    const { store } = await fixture();
    const call = kind === "input" ? store.appendInput("card", "project", { id: "state", via: "comment", text: "not the state" }, human)
      : kind === "running" ? store.update("card", "project", { handoffRevision: 0, set: [{ section: "env", id: "state", text: "not the state" }] }, actor)
      : kind === "finding" ? store.appendReview("card", "project", { cycle: 1, round: 1, reviewerId: "r", verdict: "changes", summary: "review", findings: [{ id: "state", text: "not the state", status: "open" }] }, actor)
      : store.setSession("card", "project", { ...session(), background: [{ id: "state", kind: "async_shell", ref: "owned", label: "not the state", startedAt: "now", status: "open", source: "hook" }] }, actor);
    await expect(call).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" }); expect((await store.read("card", "project")).revision).toBe(0);
  });
  test("finding and background obligations cannot alias a current top-level item or each other", async () => {
    const { store } = await fixture(); await store.appendReview("card", "project", { id: "review", cycle: 1, round: 1, reviewerId: "r", verdict: "changes", summary: "review", findings: [{ id: "obligation", text: "fix this", status: "open" }] }, actor);
    await expect(store.appendInput("card", "project", { id: "obligation", via: "comment", text: "separate input" }, human)).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    await expect(store.setSession("card", "project", { ...session(), background: [{ id: "obligation", kind: "async_shell", ref: "owned", label: "separate work", startedAt: "now", status: "open", source: "hook" }] }, actor)).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    await expect(store.appendReview("card", "project", { id: "other-review", cycle: 1, round: 1, reviewerId: "other", verdict: "changes", summary: "another review", findings: [{ id: "obligation", text: "independent finding", status: "open" }] }, actor)).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    await expect(store.appendReview("card", "project", { id: "self-alias", cycle: 1, round: 1, reviewerId: "r", verdict: "changes", summary: "bad ids", findings: [{ id: "self-alias", text: "separate finding", status: "open" }] }, actor)).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    expect(await store.openIds("card")).toEqual(["obligation"]);
  });
  test("duplicate background ids within one session cannot collapse independent live handles", async () => {
    const { store } = await fixture(); await expect(store.setSession("card", "project", { ...session(), background: ["one", "two"].map((ref) => ({ id: "duplicate", kind: "async_shell" as const, ref, label: ref, startedAt: "now", status: "open" as const, source: "hook" as const })) }, actor)).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
  });
  test("closed archived top-level ids retain their section, while same-source rehydration remains valid", async () => {
    const { store } = await fixture(); await store.capture("card", "project", { entries: Array.from({ length: 101 }, (_, n) => ({ section: "notes" as const, value: { id: `note:${n}`, sourceId: `note-source:${n}`, kind: "other", text: `note ${n}` } })) }, { by: { kind: "flowly" } });
    const record = await store.read("card", "project"); expect(record.notes.some((entry) => entry.id === "note:0")).toBe(false); expect(record.overflow.some((entry) => entry.id === "note:0")).toBe(false);
    await expect(store.update("card", "project", { handoffRevision: record.revision, set: [{ section: "next", id: "note:0", text: "new unrelated step" }] }, actor)).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    await store.confirmSource("card", "project", "note-source:0", human); expect((await store.page("card", { entryId: "note:0" })).items[0].value).toMatchObject({ text: "note 0" });
  }, 15000);
  test("unconfirmed overflow keeps finding identities reserved without exposing them as accepted requirements", async () => {
    const { store } = await fixture(); await store.capture("card", "project", { entries: Array.from({ length: 31 }, (_, n) => ({ section: "reviews" as const, value: { id: `review:${n}`, sourceId: `review-source:${n}`, unconfirmed: true, cycle: 1, round: 1, reviewerId: "r", verdict: "changes", summary: "unconfirmed review", findings: [{ id: `finding:${n}`, text: `finding ${n}`, status: "open" }], risks: [], gaps: [] } })) }, { by: { kind: "flowly" } });
    expect((await store.read("card", "project")).overflow[0].id).toBe("review:0"); expect(await store.openIds("card")).toEqual([]);
    await expect(store.appendInput("card", "project", { id: "finding:0", via: "comment", text: "an unrelated instruction" }, human)).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
  }, 15000);
});

test("a persisted duplicate identity is unavailable and never silently projected as one entity", async () => {
  const { store, dir } = await fixture(); await store.appendInput("card", "project", { id: "original", via: "comment", text: "requirement" }, human); const record = await store.read("card", "project");
  record.env.push({ id: "original", rev: 1, at: "now", by: actor.by, text: "conflicting entity" }); const file = join(dir, "handoffs/card.json"), raw = JSON.stringify(record); await writeFile(file, raw);
  await expect(store.read("card")).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" }); expect(await readFile(file, "utf8")).toBe(raw);
});

test("a corrupted pending identity set cannot replace a valid current record during recovery", async () => {
  let armed = false; const { store, dir } = await fixture((point) => { if (armed && point === "intent-synced") { armed = false; throw new Error("crash"); } });
  await store.appendInput("card", "project", { id: "original", via: "comment", text: "requirement" }, human); const currentFile = join(dir, "handoffs/card.json"), before = await readFile(currentFile, "utf8"); armed = true;
  await expect(store.update("card", "project", { handoffRevision: 1, state: "next state" }, actor)).rejects.toThrow("crash"); const intentFile = join(dir, "handoffs/card/pending.json"), pending = JSON.parse(await readFile(intentFile, "utf8")); pending.after.env.push({ id: "original", rev: 2, at: "now", by: actor.by, text: "corrupt alias" }); await writeFile(intentFile, JSON.stringify(pending));
  await expect(new HandoffStore(dir).read("card")).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" }); expect(await readFile(currentFile, "utf8")).toBe(before);
});
