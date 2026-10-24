import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { ClassifierHelpers, ClassifierHelperStore, CLASSIFIER_OWNER_LABEL } from "./classifier-helpers";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "flowly-classifier-ownership-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const sessions = new Map<string, { id: string; workspaceId: string; labels: Record<string, string> }>();
  const deleted: string[] = [], stores: ClassifierHelpers[] = [];
  let beforeCreate = async (_input: { agentId: string }) => {};
  let beforeRemove = async (_id: string) => {};
  const api = {
    agents: { ref: (id: string) => ({ id, archive: async () => {}, refresh: async () => sessions.has(id) ? { agent: sessions.get(id) } : null }) },
    workspaces: { ref: (workspaceId: string) => ({ agents: { create: async (input: { agentId: string; labels: Record<string, string> }) => {
      await beforeCreate(input); sessions.set(input.agentId, { id: input.agentId, workspaceId, labels: input.labels });
      return { id: input.agentId, archive: async () => {}, waitForFinish: async () => ({ status: "idle" }) };
    } } }) },
  } as unknown as PaseoApi;
  const generation = (options: { graceMs?: number; newId?: () => string; probeMs?: number } = {}) => {
    const helpers = new ClassifierHelpers(directory, async (agent) => { await beforeRemove(agent.id); deleted.push(agent.id); sessions.delete(agent.id); }, { graceMs: 5, probeMs: 10, ...options });
    stores.push(helpers); helpers.attach(api); return helpers;
  };
  cleanups.push(async () => { await Promise.all(stores.map((h) => h.stop())); });
  const record = { id: "previous-helper", workspaceId: "w", owner: "old-owner", confirmed: false };
  const store = new ClassifierHelperStore(directory);
  return { directory, api, store, record, generation, deleted, sessions, creating: (fn: typeof beforeCreate) => { beforeCreate = fn; }, removing: (fn: typeof beforeRemove) => { beforeRemove = fn; } };
}

test("ownership is durably written before native create, and known completed deletion removes it", async () => {
  const x = await fixture(); const helpers = x.generation({ newId: () => "mine" });
  x.creating(async (input) => expect(await x.store.read()).toMatchObject([{ id: input.agentId, workspaceId: "w", confirmed: false }]));
  const agent = await helpers.create("w", { config: { provider: "cheap/model" }, labels: { flowly: "summarizer" } }, new AbortController().signal);
  expect(await x.store.read()).toMatchObject([{ id: "mine", confirmed: true }]);
  await helpers.remove(agent); expect(await x.store.read()).toEqual([]); expect(x.deleted).toEqual(["mine"]);
});

test("restart retains an absent unconfirmed request; a helper appearing on a later bounded probe is removed only by matching id/owner/workspace", async () => {
  const x = await fixture(); await x.store.add(x.record); const helpers = x.generation();
  await helpers.recover(); await helpers.recover(); expect(await x.store.read()).toEqual([x.record]);
  // Simulate the old daemon create finishing after the previous plugin process has exited: no old JS callbacks.
  x.sessions.set(x.record.id, { id: x.record.id, workspaceId: "w", labels: { [CLASSIFIER_OWNER_LABEL]: x.record.owner } });
  await helpers.recover(); expect(x.sessions.has(x.record.id)).toBe(false); expect(x.deleted).toEqual([x.record.id]);
  // Its create response was never acknowledged, so absence alone must not retire its ownership.
  expect(await x.store.read()).toEqual([x.record]);
});

test.each(["wrong-owner", "wrong-workspace"])("restart refuses to delete %s sessions and never scans unrelated sessions", async (mismatch) => {
  const x = await fixture(); await x.store.add(x.record);
  x.sessions.set(x.record.id, { id: x.record.id, workspaceId: mismatch === "wrong-workspace" ? "another-workspace" : "w", labels: { [CLASSIFIER_OWNER_LABEL]: mismatch === "wrong-owner" ? "someone-else" : x.record.owner } });
  x.sessions.set("unrelated", { id: "unrelated", workspaceId: "w", labels: { [CLASSIFIER_OWNER_LABEL]: "other-owner" } });
  await x.generation().recover(); expect(x.deleted).toEqual([]); expect(x.sessions.size).toBe(2); expect(await x.store.read()).toEqual([x.record]);
});

test("an acknowledged create already absent after restart can be retired safely", async () => {
  const x = await fixture(); await x.store.add({ ...x.record, confirmed: true });
  await x.generation().recover(); expect(await x.store.read()).toEqual([]);
});

test("a create stuck before acknowledgement cannot hold stop beyond grace and remains recoverable", async () => {
  const x = await fixture(), create = deferred<void>(); x.creating(() => create.promise);
  const helpers = x.generation({ newId: () => "stuck" }); const controller = new AbortController();
  const creating = helpers.create("w", { config: { provider: "cheap/model" } }, controller.signal);
  await vi.waitFor(async () => expect(await x.store.read()).toHaveLength(1));
  controller.abort(); await helpers.stop([creating]); expect(await x.store.read()).toMatchObject([{ id: "stuck", confirmed: false }]);
  create.resolve(); await creating; expect(x.deleted).toEqual(["stuck"]); expect(await x.store.read()).toEqual([]);
});

test("shutdown paused during creation confirmation preserves ownership until confirmation and cleanup finish", async () => {
  const x = await fixture(), confirmation = deferred<void>(); const helpers = x.generation({ newId: () => "confirming" });
  const confirm = helpers.store.confirm.bind(helpers.store);
  vi.spyOn(helpers.store, "confirm").mockImplementation(async (id) => { await confirmation.promise; await confirm(id); });
  const creating = helpers.create("w", { config: { provider: "cheap/model" } }, new AbortController().signal);
  await vi.waitFor(() => expect(x.sessions.has("confirming")).toBe(true));
  await helpers.stop([creating]); expect(await x.store.read()).toMatchObject([{ id: "confirming", confirmed: false }]);
  confirmation.resolve(); await creating; expect(await x.store.read()).toEqual([]);
});

test("shutdown paused during deletion keeps the record, and another generation recovers only that owned helper", async () => {
  const x = await fixture(), deletion = deferred<void>(); const helpers = x.generation({ newId: () => "deleting" });
  const agent = await helpers.create("w", { config: { provider: "cheap/model" } }, new AbortController().signal);
  x.removing(() => deletion.promise); const removing = helpers.remove(agent);
  await helpers.stop(); expect(await x.store.read()).toMatchObject([{ id: "deleting", confirmed: true }]);
  x.removing(async () => {}); await x.generation().recover(); expect(await x.store.read()).toEqual([]);
  deletion.resolve(); await removing;
});


test("stop owns a returned helper even before its caller enters wait/finally", async () => {
  const x = await fixture(); const helpers = x.generation({ graceMs: 200, newId: () => "between-awaits" });
  await helpers.create("w", { config: { provider: "cheap/model" } }, new AbortController().signal);
  await helpers.stop(); expect(x.sessions.has("between-awaits")).toBe(false); expect(await x.store.read()).toEqual([]);
});

test("cancellation while ownership is being written never issues a native request after stop", async () => {
  const x = await fixture(), written = deferred<void>(); const helpers = x.generation({ newId: () => "not-requested" });
  const add = helpers.store.add.bind(helpers.store); let requested = false;
  vi.spyOn(helpers.store, "add").mockImplementation(async (record) => { await written.promise; await add(record); });
  x.creating(async () => { requested = true; }); const controller = new AbortController();
  const creating = helpers.create("w", { config: { provider: "cheap/model" } }, controller.signal);
  const rejected = expect(creating).rejects.toThrow("Cancelled");
  controller.abort(); await helpers.stop(); written.resolve(); await rejected;
  expect(requested).toBe(false); expect(await x.store.read()).toEqual([]);
});

test("a failed ownership write prevents native create", async () => {
  const x = await fixture(); const helpers = x.generation(); let requested = false;
  vi.spyOn(helpers.store, "add").mockRejectedValue(new Error("disk full")); x.creating(async () => { requested = true; });
  await expect(helpers.create("w", { config: { provider: "cheap/model" } }, new AbortController().signal)).rejects.toThrow("disk full");
  expect(requested).toBe(false);
});

test("shutdown during absence verification keeps confirmed ownership for a later generation", async () => {
  const x = await fixture(), verified = deferred<null>(); const helpers = x.generation({ newId: () => "verifying" });
  const agent = await helpers.create("w", { config: { provider: "cheap/model" } }, new AbortController().signal);
  const ref = x.api.agents.ref.bind(x.api.agents);
  x.api.agents.ref = ((id: string) => ({ ...ref(id), refresh: () => verified.promise })) as typeof x.api.agents.ref;
  const removing = helpers.remove(agent); await helpers.stop();
  expect(await x.store.read()).toMatchObject([{ id: "verifying", confirmed: true }]);
  x.api.agents.ref = ref; await x.generation().recover(); expect(await x.store.read()).toEqual([]);
  verified.resolve(null); await removing;
});

test("one unresponsive recovery probe does not stop another owned helper from being cleaned", async () => {
  const x = await fixture();
  await x.store.add({ ...x.record, id: "unresponsive" });
  await x.store.add({ ...x.record, id: "recoverable", confirmed: true });
  x.sessions.set("recoverable", { id: "recoverable", workspaceId: "w", labels: { [CLASSIFIER_OWNER_LABEL]: x.record.owner } });
  const ref = x.api.agents.ref.bind(x.api.agents);
  x.api.agents.ref = ((id: string) => id === "unresponsive" ? { ...ref(id), refresh: () => new Promise(() => {}) } : ref(id)) as typeof x.api.agents.ref;
  await x.generation().recover(); expect(x.deleted).toEqual(["recoverable"]);
  expect((await x.store.read()).map((e) => e.id)).toEqual(["unresponsive"]);
});
