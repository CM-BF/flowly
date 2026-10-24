import { afterEach, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { ReviewClassifier, classifierPrompt } from "./review-classifier";
import { automationFixture, cleanupAutomationFixtures } from "./automation-fixture";
import { classificationHash } from "../shared/review-levels";
import { resolveReviewLevel } from "./review-levels";
import { summarySettingsValues, SUMMARIZER_LABELS } from "../shared/summary";
import type { Board, Task } from "../shared/model";

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(stops.splice(0).map((stop) => stop())); await cleanupAutomationFixtures(); });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
type Result = { status: string; error?: string | null; lastMessage?: string | null };
const good = (level = "standard", reason = "The card builds a UI without changing persisted data."): Result => ({ status: "idle", lastMessage: JSON.stringify({ level, reason }) });
async function fixture(options: { waitMs?: number; modelMs?: number; runMs?: number; debounceMs?: number } = {}) {
  const x = await automationFixture({ enabled: true, reviewer: { provider: "codex", model: "expensive-reviewer" } });
  await x.store.mutate((b) => { b.tasks.find((t) => t.id === "b")!.reviewLevel = "standard"; });
  const removed: string[] = [], created: { model: string; prompt: string; labels: Record<string, string>; id: string }[] = [];
  let output = (_model: string): Promise<Result> => Promise.resolve(good());
  let creating = async () => {};
  const api = {
    providers: { listAvailable: async () => ({ providers: [{ provider: "one", available: true }, { provider: "two", available: true }] }), listModels: async (provider: string) => ({ models: [{ id: provider === "one" ? "a" : "b" }] }) },
    workspaces: { ref: (_id: string) => ({ agents: { create: async (input: { config: { provider: string }; prompt: string; labels: Record<string, string> }) => {
      await creating(); const id = `helper-${created.length}`;
      created.push({ model: input.config.provider, prompt: input.prompt, labels: input.labels, id });
      return { id, archive: async () => { throw new Error("cleanup must use injected remover"); }, waitForFinish: () => output(input.config.provider) };
    } } }) },
  } as unknown as PaseoApi;
  const settings = vi.fn(async () => summarySettingsValues({ summaryModels: ["one/a", "two/b"] }));
  const service = new ReviewClassifier(x.store, settings, { debounceMs: 5, modelMs: 100, runMs: 500, waitMs: 200, ...options, remove: async (agent) => { removed.push(agent.id); } });
  stops.push(() => service.stop());
  const card = async () => (await x.store.read()).tasks.find((t) => t.id === "a")!;
  const edit = (change: (task: Task, board: Board) => void) => x.store.mutate((b) => { change(b.tasks.find((t) => t.id === "a")!, b); });
  return { ...x, service, api, settings, created, removed, card, edit, output: (fn: typeof output) => { output = fn; }, creating: (fn: typeof creating) => { creating = fn; } };
}

test("summary models classify once; cache records actual model, reason and full input hash without changing card revision", async () => {
  const x = await fixture(); await x.edit((t) => { t.description = "UI shows database permissions"; });
  const revision = (await x.card()).revision;
  await x.service.forReview("a", x.api);
  const task = await x.card();
  expect(task.reviewClassification).toMatchObject({ status: "ready", inputHash: classificationHash(await x.store.read(), task), verdict: { level: "standard", model: "one/a" } });
  expect(task.revision).toBe(revision);
  expect(resolveReviewLevel(await x.store.read(), task)).toMatchObject({ level: "standard", reason: { kind: "classifier", model: "one/a" } });
  expect(x.created[0].labels).toMatchObject(SUMMARIZER_LABELS);
  expect(x.created[0].model).not.toContain("expensive-reviewer");
  expect(x.removed).toEqual(["helper-0"]);
  await x.service.forReview("a", x.api); await x.service.scan();
  expect(x.created).toHaveLength(1);
});

test("cache invalidates independently for title, description, acceptance, tags and parent title; unrelated metadata does not", async () => {
  const x = await fixture();
  await x.edit((t, b) => { b.links.push({ id: "parent", projectId: "p", kind: "subtask", from: "a", to: "b", createdBy: "human", createdAt: t.updatedAt }); });
  await x.service.forReview("a", x.api);
  const changes: ((t: Task, b: Board) => void)[] = [
    (t) => { t.title += " changed"; }, (t) => { t.description += " description"; },
    (t, b) => { b.workpads.push({ taskId: "a", projectId: "p", revision: 1, acceptance: [{ id: "ac", text: "Verify storage", done: false, by: "agent", at: t.updatedAt }], validation: [], confusions: [], env: null, head: null, updatedAt: t.updatedAt, updatedBy: "agent" }); },
    (t) => { t.tags = [{ tag: "ui", by: "human", at: t.updatedAt }]; },
    (_t, b) => { b.tasks.find((t) => t.id === "b")!.title += " parent"; },
  ];
  for (const change of changes) { const before = (await x.card()).reviewClassification!.inputHash; await x.edit(change); await x.service.forReview("a", x.api); expect((await x.card()).reviewClassification!.inputHash).not.toBe(before); }
  expect(x.created).toHaveLength(6);
  await x.edit((t, b) => { t.priority = "high"; b.workpads[0].acceptance[0].done = true; });
  await x.service.forReview("a", x.api); expect(x.created).toHaveLength(6);
});

test.each(["create", "bad-json", "permission", "idle-error", "timeout"])("%s failure tries the next configured summary model and cleans each created helper", async (mode) => {
  const x = await fixture({ modelMs: 10 });
  if (mode === "create") { let calls = 0; x.creating(async () => { if (!calls++) throw new Error("create failed"); }); }
  x.output(async (model) => {
    if (model === "two/b" || mode === "create") return good("deep", "This card designs the persisted board format.");
    if (mode === "bad-json") return { status: "idle", lastMessage: "not JSON" };
    if (mode === "permission") return { status: "permission" };
    if (mode === "idle-error") return { status: "idle", error: "quota" };
    return new Promise<Result>(() => {});
  });
  await x.service.forReview("a", x.api);
  expect((await x.card()).reviewClassification).toMatchObject({ status: "ready", verdict: { level: "deep", model: "two/b" } });
  expect(x.removed).toEqual(x.created.map((c) => c.id));
});

test("all models failing retains a keyword fallback; a light tag wins even if the card mentions a database", async () => {
  const x = await fixture(); await x.edit((t) => { t.title = "Database storage"; }); x.output(async () => ({ status: "failed" }));
  await x.service.forReview("a", x.api);
  expect((await x.card()).reviewClassification?.status).toBe("failed");
  expect(resolveReviewLevel(await x.store.read(), await x.card())).toMatchObject({ level: "deep", reason: { kind: "keyword" } });
  const before = x.created.length;
  await x.edit((t) => { t.tags = [{ tag: "light-review", by: "human", at: t.updatedAt }]; });
  await x.service.forReview("a", x.api); await x.service.scan();
  expect(x.created).toHaveLength(before);
  expect(resolveReviewLevel(await x.store.read(), await x.card()).level).toBe("light");
});

test("an unavailable inventory falls back without creating helpers", async () => {
  const x = await fixture(); x.api.providers.listAvailable = async () => ({ providers: [], fetchedAt: "", requestId: "test" });
  await x.service.forReview("a", x.api);
  expect((await x.card()).reviewClassification?.status).toBe("failed"); expect(x.created).toHaveLength(0);
});

test("concurrent review/background requests share a helper; the review wait is bounded and a late verdict is cached for next round", async () => {
  const x = await fixture({ waitMs: 10 }); const result = deferred<Result>(); x.output(() => result.promise);
  await Promise.all([x.service.forReview("a", x.api), x.service.forReview("a", x.api)]);
  expect(x.created).toHaveLength(1); expect((await x.card()).reviewClassification?.status).toBe("pending");
  result.resolve(good("light", "This card changes a local label."));
  await vi.waitFor(async () => expect((await x.card()).reviewClassification?.status).toBe("ready"));
  await x.service.forReview("a", x.api); expect(x.created).toHaveLength(1); expect(x.removed).toHaveLength(1);
});

test("background debounce reads the newest saved content once; cache writes do not cause a helper loop", async () => {
  const x = await fixture(); x.store.onCommit = () => x.service.schedule(); x.service.attach(x.api);
  for (let i = 0; i < 5; i++) { await x.edit((t) => { t.description = `draft ${i}`; }); x.service.schedule(); }
  await vi.waitFor(async () => expect((await x.card()).reviewClassification?.status).toBe("ready"));
  expect(x.created).toHaveLength(1); expect(x.created[0].prompt).toContain("draft 4");
  await x.service.scan(); expect(x.created).toHaveLength(1);
});

test("stale results and explicit overrides cannot overwrite changed cards; deleted cards are safe", async () => {
  const x = await fixture({ waitMs: 10 }); const result = deferred<Result>(); x.output(() => result.promise);
  await x.service.forReview("a", x.api);
  await x.edit((t) => { t.reviewLevel = "light"; t.title = "new content"; });
  result.resolve(good("deep", "Old content."));
  await x.service.stop();
  expect((await x.card()).reviewClassification?.verdict).toBeUndefined(); expect(x.removed).toEqual(["helper-0"]);
});

test("stop cancels a running wait, and also removes a helper whose create finishes after cancellation", async () => {
  const x = await fixture({ waitMs: 10 }); const created = deferred<void>(); x.creating(() => created.promise);
  await x.service.forReview("a", x.api);
  await x.service.stop(); created.resolve();
  await vi.waitFor(() => expect(x.removed).toEqual(["helper-0"]));
  expect((await x.card()).reviewClassification?.verdict).toBeUndefined();
});

test("explicit and ancestor-tag decisions never invoke a classifier; ancestor explicit and light do not inherit", async () => {
  const x = await fixture(); await x.edit((t) => { t.reviewLevel = "light"; });
  await x.service.forReview("a", x.api); expect(x.created).toHaveLength(0);
  await x.edit((t, b) => { delete t.reviewLevel; b.links.push({ id: "parent", projectId: "p", kind: "subtask", from: "a", to: "b", createdBy: "human", createdAt: t.updatedAt }); b.tasks[1].reviewLevel = "deep"; b.tasks[1].tags = [{ tag: "foundation", by: "human", at: t.updatedAt }]; });
  await x.service.forReview("a", x.api); expect(x.created).toHaveLength(0);
  await x.edit((_t, b) => { b.tasks[1].tags = [{ tag: "light-review", by: "human", at: b.tasks[1].updatedAt }]; });
  await x.service.forReview("a", x.api); expect(x.created).toHaveLength(1);
});

test("prompt judges work instead of mentioned topics, has both motivating storage phrasings, and treats content as data", async () => {
  const x = await fixture(); const text = classifierPrompt(await x.store.read(), await x.card());
  for (const required of ["THIS card", "hard-to-undo", "Save the board to disk on every change", "Persist workspace state across restarts", "每次修改把看板存盘", "Keyword hits below are weak hints", "untrusted text", "coordinator"]) expect(text).toContain(required);
});


test("automation waits for the classifier before choosing its round and records reason/model in both job and activity", async () => {
  const x = await fixture(); x.hooks.classifyReview = (id) => x.service.forReview(id, x.api);
  await x.edit((t) => { t.description = "A UI card mentions database storage and permissions in passing."; });
  await x.automation.queue("a"); await x.automation.kick();
  const impl = x.agents.keys().next().value!;
  await x.deliver(impl, "a"); await x.turn(impl, "a");
  const board = await x.store.read(), job = await x.job("a");
  expect(job.review).toMatchObject({ level: "standard", reason: { kind: "classifier", model: "one/a" }, size: 1 });
  expect(board.events.find((e) => e.action === "automation_review_started")?.note).toContain("classifier one/a: The card builds a UI");
});

test("a stuck provider inventory obeys the total deadline without creating a helper", async () => {
  const x = await fixture({ runMs: 15, waitMs: 100 });
  x.api.providers.listAvailable = () => new Promise(() => {});
  await x.service.forReview("a", x.api);
  expect((await x.card()).reviewClassification?.status).toBe("failed"); expect(x.created).toHaveLength(0);
});

test("a stuck create times out to the next model and its late session is removed", async () => {
  const x = await fixture({ modelMs: 10, waitMs: 100 }); const first = deferred<void>(); let attempts = 0;
  x.creating(() => attempts++ === 0 ? first.promise : Promise.resolve());
  await x.service.forReview("a", x.api);
  expect((await x.card()).reviewClassification?.verdict?.model).toBe("two/b");
  first.resolve(); await vi.waitFor(() => expect(x.removed).toHaveLength(2));
  expect(new Set(x.removed)).toEqual(new Set(x.created.map((a) => a.id)));
});

test("background helper concurrency stays at two while the third card queues", async () => {
  const x = await fixture({ waitMs: 10 }); const finished = deferred<Result>(); x.output(() => finished.promise);
  await x.edit((_t, b) => { delete b.tasks[1].reviewLevel; b.tasks.push({ ...b.tasks[1], id: "c", workspaceId: "w-c", operationId: "create-c" }); });
  x.service.attach(x.api); await x.service.scan();
  await vi.waitFor(() => expect(x.created).toHaveLength(2));
  await x.service.forReview("c", x.api); expect(x.created).toHaveLength(2);
  finished.resolve(good());
  await vi.waitFor(async () => expect((await x.store.read()).tasks.every((t) => t.reviewClassification?.status === "ready")).toBe(true));
  expect(x.created).toHaveLength(3); expect(x.removed).toHaveLength(3);
});
