import { afterEach, expect, test, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { HandoffService } from "./handoff-service";
import type { SessionHistory } from "./session-history";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const x = await agentFixture(); roots.push(x.root);
  const handoffs = new HandoffService(x.store); handoffs.attach(x.paseo); x.service.handoffs = handoffs;
  const read = vi.fn(async () => ({ session: "#1", status: "building" as const, message: "Building bounded excerpts", entries: [], omitted: 0, gaps: [] }));
  x.service.sessionHistory = { read } as unknown as SessionHistory;
  await handoffs.records.setSession("t", "p", { agentId: "second", n: 1, role: "implementer", provider: "codex", startedAt: new Date().toISOString(), reason: "launch", finalized: true, turns: [], background: [], live: [] }, { by: { kind: "flowly" } });
  return { ...x, read };
}

test("a current reader can inspect its archived predecessor by ledger number without restoring it", async () => {
  const x = await fixture(); x.actors.second.archivedAt = new Date().toISOString();
  expect((await x.service.readSessionHistory(x.identity, { session: "#1", query: "handoff" })).status).toBe("building");
  expect(x.read).toHaveBeenCalledWith(expect.objectContaining({ id: "second", archivedAt: expect.any(String) }), { session: "#1", query: "handoff" });
});

test("history cannot select another native session outside this card's ledger or a moved predecessor", async () => {
  const x = await fixture();
  await expect(x.service.readSessionHistory(x.identity, { session: "wrong" })).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
  x.actors.second.workspaceId = "different-workspace";
  await expect(x.service.readSessionHistory(x.identity, { session: "#1" })).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
  expect(x.read).not.toHaveBeenCalled();
});

test("only a current role's tool clears the silence signal, without rewriting on later calls", async () => {
  const x = await fixture(), at = new Date().toISOString();
  await x.store.mutate(board => { board.automation.push({ taskId: "t", projectId: "p", role: "implementer", state: "working", implementerId: "actor", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: at, updatedAt: at, silentSince: at }); });
  const before = await readFile(x.store.path, "utf8");
  await x.service.toolCalled({ ...x.identity, agentId: "second" });
  expect(await readFile(x.store.path, "utf8")).toBe(before);
  await x.service.toolCalled(x.identity);
  expect((await x.store.read()).automation[0].silentSince).toBeUndefined();
  expect(x.service.accesses.get("actor")).toMatchObject({ action: "tool" });
  const cleared = await readFile(x.store.path, "utf8");
  await x.service.toolCalled(x.identity);
  expect(await readFile(x.store.path, "utf8")).toBe(cleared);
});
