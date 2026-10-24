import { afterEach, expect, test, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { BoardService } from "./service";
import { ToolServer } from "./tool-server";

// AUTOMATION-SPEC §5.2.1, §5.2.7: agents give cards a review level, reviewers report risks; people set the level in the editor.
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});

/** The agent fixture plus a real BoardService whose workspaces are created by a fake SDK (as in sub-cards.test.ts). */
async function setup() {
  const f = await agentFixture();
  cleanups.push(() => rm(f.root, { recursive: true, force: true }));
  let workspaces = 0;
  (f.paseo as unknown as { workspaces: Record<string, unknown> }).workspaces.create = vi.fn(async () => ({ id: `new-ws-${++workspaces}` }));
  const board = new BoardService(f.store);
  f.service.createTask = (input, api, agent) => board.createTask(input, api, agent);
  const request = async () => {
    const ctx = await f.service.get(f.identity);
    return { expectedRevision: ctx.revision, request: ctx.request };
  };
  const card = async (id: string) => (await f.store.read()).tasks.find((t) => t.id === id)!;
  return { ...f, request, card };
}

test("flowly_create_card records a review level; auto and none leave the card on Auto", async () => {
  const x = await setup();
  const deep = await x.service.createCard(x.identity, { ...(await x.request()), title: "Storage layer", review_level: "deep" });
  const auto = await x.service.createCard(x.identity, { ...(await x.request()), title: "Settings page", review_level: "auto" });
  const plain = await x.service.createCard(x.identity, { ...(await x.request()), title: "Copy edits" });
  expect((await x.card(deep.cardId)).reviewLevel).toBe("deep");
  expect(await x.card(auto.cardId)).not.toHaveProperty("reviewLevel");
  expect(await x.card(plain.cardId)).not.toHaveProperty("reviewLevel");
  await expect(x.service.createCard(x.identity, { ...(await x.request()), title: "Bad", review_level: "huge" as "deep" })).rejects.toThrow();
});

test("flowly_update_card sets a direct sub-card's level alone or with start, and refuses it with accept or cancel", async () => {
  const x = await setup();
  const child = await x.service.createCard(x.identity, { ...(await x.request()), title: "Child", start: "later" });
  const separate = await x.service.createCard(x.identity, { ...(await x.request()), title: "Separate", subCard: false });
  const before = await x.card(child.cardId);
  const signed = await x.request();
  const set = await x.service.updateCard(x.identity, { ...signed, cardId: child.cardId, review_level: "deep" });
  expect(set).toMatchObject({ cardId: child.cardId, status: "backlog", queued: false, message: expect.stringContaining("next review round") });
  const after = await x.card(child.cardId);
  expect(after).toMatchObject({ reviewLevel: "deep", status: "backlog", revision: before.revision + 1 });
  const events = (await x.store.read()).events.filter((e) => e.taskId === child.cardId && e.action === "review_level_set");
  expect(events).toEqual([expect.objectContaining({ actor: "agent", agentId: "actor", note: "Review level: Deep (set by the parent card's agent)" })]);
  // The same request again returns its recorded result.
  expect(await x.service.updateCard(x.identity, { ...signed, cardId: child.cardId, review_level: "deep" })).toMatchObject({ replayed: true });
  // Refused combinations record nothing.
  for (const input of [{ action: "accept" as const, review_level: "light" as const }, { action: "cancel" as const, review_level: "light" as const }, {}])
    await expect(x.service.updateCard(x.identity, { ...(await x.request()), cardId: child.cardId, ...input })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(x.service.updateCard(x.identity, { ...(await x.request()), cardId: separate.cardId, review_level: "light" })).rejects.toMatchObject({ code: "NOT_PARENT" });
  expect((await x.card(child.cardId)).revision).toBe(after.revision);
  // With start: the level is set and the card leaves Backlog.
  expect(await x.service.updateCard(x.identity, { ...(await x.request()), cardId: child.cardId, action: "start", review_level: "light" })).toMatchObject({ status: "todo" });
  expect((await x.card(child.cardId)).reviewLevel).toBe("light");
  // auto removes it again.
  await x.service.updateCard(x.identity, { ...(await x.request()), cardId: child.cardId, review_level: "auto" });
  expect(await x.card(child.cardId)).not.toHaveProperty("reviewLevel");
  await x.store.mutate((board) => void (board.tasks.find((t) => t.id === child.cardId)!.status = "done"));
  await expect(x.service.updateCard(x.identity, { ...(await x.request()), cardId: child.cardId, review_level: "deep" })).rejects.toMatchObject({ code: "TASK_FINISHED" });
});

test("a person sets and clears the level in the editor, and the activity says so", async () => {
  const x = await setup();
  const set = await x.store.editTask({ id: "t", revision: (await x.card("t")).revision, reviewLevel: "light", actor: "human" });
  expect(set.reviewLevel).toBe("light");
  const cleared = await x.store.editTask({ id: "t", revision: set.revision, reviewLevel: null, actor: "human" });
  expect(cleared).not.toHaveProperty("reviewLevel");
  // Saving the form without touching the level records nothing about it.
  await x.store.editTask({ id: "t", revision: cleared.revision, title: "Renamed", actor: "human" });
  expect((await x.store.read()).events.filter((e) => e.action === "review_level_set").map((e) => e.note)).toEqual(["Review level: Light", "Review level: Auto"]);
});

test("risks are part of flowly_submit_review over MCP and over the CLI's endpoint, with the same bounds", async () => {
  const x = await agentFixture();
  cleanups.push(() => rm(x.root, { recursive: true, force: true }));
  const server = new ToolServer(x.store);
  cleanups.push(() => server.stop());
  await server.start();
  server.attach(x.paseo);
  const { url } = JSON.parse(await readFile(x.store.directory + "/tool-endpoint.json", "utf8"));
  const authorization = "Bearer " + server.secrets.credential(x.identity);
  const mcp = async (method: string, params: unknown) => {
    const response = await fetch(url + "mcp", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.text();
    return JSON.parse(response.headers.get("content-type")?.includes("text/event-stream") ? body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).at(-1)! : body);
  };
  await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const tools = (await mcp("tools/list", {})).result.tools as { name: string; description: string; inputSchema: { properties: Record<string, { maxItems?: number; items?: { maxLength?: number }; enum?: string[] }> } }[];
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  expect(tool("flowly_submit_review").inputSchema.properties.risks).toMatchObject({ maxItems: 10, items: { maxLength: 500 } });
  expect(tool("flowly_submit_review").description).toContain("risks never block approval");
  for (const name of ["flowly_create_card", "flowly_update_card"]) expect(tool(name).inputSchema.properties.review_level.enum).toEqual(["light", "standard", "deep", "auto"]);
  const tooMany = { verdict: "approve", summary: "Fine", risks: Array.from({ length: 11 }, (_, i) => `Risk ${i}`) };
  const refused = await mcp("tools/call", { name: "flowly_submit_review", arguments: tooMany });
  expect(refused.result?.isError ?? !!refused.error).toBe(true);
  const api = async (input: unknown) => {
    const response = await fetch(url + "api", { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify({ action: "review", input }) });
    return response.json() as Promise<{ ok: boolean; error?: { code: string } }>;
  };
  expect(await api(tooMany)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(await api({ ...tooMany, risks: ["x".repeat(501)] })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  // Valid risks pass validation and reach the service, which only takes verdicts from an automation reviewer.
  expect(await api({ ...tooMany, risks: ["One plain sentence."] })).toMatchObject({ ok: false, error: { code: "NOT_REVIEWER" } });
});
