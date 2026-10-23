import { afterEach, expect, test, vi } from "vitest";
import { rm } from "node:fs/promises";
import { agentFixture } from "./agent-fixture";
import { readHead } from "./workpad";
import type { AutomationJob } from "../shared/automation";
import type { Board, Status, Workpad } from "../shared/model";

// get_task must not run git status per link: readHead is the call that does (HEAD, branch and status).
vi.mock("./workpad", async (importOriginal) => ({ ...(await importOriginal<typeof import("./workpad")>()), readHead: vi.fn(async () => null) }));

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(readHead).mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const stamp = new Date().toISOString();
const job = (taskId: string, state: AutomationJob["state"]): AutomationJob => ({
  taskId, projectId: "p", role: "implementer", state, generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: stamp, updatedAt: stamp,
});
const pad = (taskId: string, extra: Partial<Workpad> = {}, size = 0): Workpad => ({
  taskId, projectId: "p", revision: 1,
  acceptance: Array.from({ length: size }, (_, i) => ({ id: `a${i}`, text: `${"Acceptance ".repeat(14)}${i}`, done: true, by: "agent" as const, at: stamp })),
  validation: Array.from({ length: size }, (_, i) => ({ id: `v${i}`, text: `${"Validation ".repeat(9)}${i}`, command: "npm test", state: "pass" as const, evidence: "e".repeat(200), by: "agent" as const, at: stamp })),
  confusions: [], env: null, head: null, updatedAt: stamp, updatedBy: "agent", ...extra,
});
const head = (branch: string) => ({ sha: "abcdef123456", branch, dirty: false, at: stamp });

type Card = { id: string; status: Status; relation: "sub_card" | "blocked_by" | "sub_card_of"; archived?: boolean; job?: AutomationJob["state"]; delivered?: string; pad?: Workpad };

/** The fixture card t with linked cards; each linked card has its own workspace `<id>-ws`. */
async function setup(cards: Card[]) {
  const x = await agentFixture();
  roots.push(x.root);
  await x.store.mutate((board: Board) => {
    const base = board.tasks[0];
    for (const c of cards) {
      board.tasks.push({ ...base, id: c.id, title: `Card ${c.id}`, workspaceId: `${c.id}-ws`, operationId: `${c.id}-op`, status: c.status, archivedAt: c.archived ? stamp : null, updatedAt: stamp });
      const link = c.relation === "sub_card" ? { kind: "subtask" as const, from: c.id, to: "t" } : c.relation === "sub_card_of" ? { kind: "subtask" as const, from: "t", to: c.id } : { kind: "blocks" as const, from: c.id, to: "t" };
      board.links.push({ id: `${c.id}-link`, projectId: "p", createdBy: "human", createdAt: stamp, ...link });
      if (c.job) board.automation.push(job(c.id, c.job));
      if (c.delivered) board.events.push({ id: `${c.id}-delivery`, taskId: c.id, actor: "agent", agentId: `${c.id}-agent`, action: "status_changed", from: "development", to: "in_review", note: c.delivered, at: stamp });
      if (c.pad) board.workpads.push(c.pad);
    }
  });
  // Workspace reads per id, so a test can see which linked cards get looked up.
  const refreshed: string[] = [];
  const workspace = x.workspace();
  (x.paseo as unknown as { workspaces: { ref: (id: string) => unknown } }).workspaces.ref = (id: string) => ({
    refresh: async () => {
      refreshed.push(id);
      return id === "w" ? workspace : { ...workspace, id, workspaceDirectory: `${x.root}/${id}` };
    },
  });
  const git = vi.fn(async (_cwd: string, args: string[]) => (args.join(" ") === "rev-parse --abbrev-ref HEAD" ? "kanban/live-branch\n" : ""));
  x.service.git = git;
  const request = async () => {
    const context = await x.service.get(x.identity);
    return { expectedRevision: context.revision, request: context.request };
  };
  return { ...x, refreshed, git, request };
}

const linkOf = (context: { links: { taskId: string }[] }, id: string) => context.links.find((l) => l.taskId === id) as Record<string, unknown> & { handoff?: { evidence: string; branch?: string; directory?: string } };

test("handoffs only for linked cards that are delivered or settled, not Done, Cancelled, archived or still moving", async () => {
  const x = await setup([
    { id: "review", status: "in_review", relation: "sub_card", delivered: "Delivered the parser." },
    { id: "parked", status: "backlog", relation: "sub_card" },
    { id: "accepted", status: "done", relation: "sub_card", delivered: "Old delivery." },
    { id: "dropped", status: "cancelled", relation: "sub_card" },
    { id: "shelved", status: "in_review", relation: "sub_card", archived: true },
    { id: "moving", status: "development", relation: "sub_card", job: "working" },
    { id: "blocker", status: "in_review", relation: "blocked_by", delivered: "Sibling delivery." },
    { id: "landed", status: "done", relation: "blocked_by" },
  ]);
  const context = await x.service.get(x.identity);
  expect(context.links.map((l) => l.taskId).sort()).toEqual(["accepted", "blocker", "dropped", "landed", "moving", "parked", "review", "shelved"]);
  const withHandoff = context.links.filter((l) => l.handoff).map((l) => l.taskId).sort();
  expect(withHandoff).toEqual(["blocker", "parked", "review"]);
  expect(linkOf(context, "review").handoff!.evidence).toContain("Delivered the parser.");
  expect(x.refreshed.filter((id) => id !== "w").sort()).toEqual(["blocker-ws", "parked-ws", "review-ws"]);
});

test("the handoff evidence of all links together stays within one budget; the rest point to the card instead", async () => {
  const children: Card[] = Array.from({ length: 20 }, (_, i) => ({
    id: `c${String(i).padStart(2, "0")}`, status: "in_review" as const, relation: "sub_card" as const, delivered: "N".repeat(800),
    pad: pad(`c${String(i).padStart(2, "0")}`, {}, 8),
  }));
  const x = await setup(children);
  const context = await x.service.get(x.identity);
  expect(context.links).toHaveLength(20);
  const evidence = context.links.map((l) => l.handoff!.evidence);
  const full = evidence.filter((e) => !e.startsWith("Omitted"));
  expect(full.length).toBeGreaterThan(0);
  expect(full.join("").length).toBeLessThanOrEqual(16_000);
  expect(evidence.filter((e) => e.startsWith("Omitted")).length).toBe(20 - full.length);
  expect(JSON.stringify(context.links).length).toBeLessThan(30_000);
});

test("a write's current context carries links without handoffs and reads no linked workspace", async () => {
  const x = await setup([{ id: "review", status: "in_review", relation: "sub_card", delivered: "Delivered." }]);
  const signed = await x.request();
  // What the get_task above did is not the write's cost.
  x.refreshed.splice(0);
  x.git.mockClear();
  const result = await x.service.write(x.identity, "progress", { ...signed, note: "Small progress", kind: "progress" });
  expect(result.current!.links).toEqual([expect.objectContaining({ taskId: "review", status: "in_review" })]);
  expect(result.current!.links[0].handoff).toBeUndefined();
  expect(x.refreshed.filter((id) => id !== "w")).toEqual([]);
  expect(readHead).not.toHaveBeenCalled();
  expect(x.git).not.toHaveBeenCalled();
});

test("a delivered card's handoff takes its branch from the HEAD stored at delivery, without git status", async () => {
  const x = await setup([{ id: "review", status: "in_review", relation: "sub_card", delivered: "Delivered.", pad: pad("review", { head: head("kanban/review-delivered") }) }]);
  const context = await x.service.get(x.identity);
  expect(linkOf(context, "review").handoff).toMatchObject({ branch: "kanban/review-delivered", directory: `${x.root}/review-ws` });
  expect(readHead).not.toHaveBeenCalled();
  expect(x.git).not.toHaveBeenCalled();
});

test("without a stored HEAD the branch is read with one rev-parse, never git status", async () => {
  const x = await setup([{ id: "review", status: "in_review", relation: "sub_card", delivered: "Delivered." }]);
  const context = await x.service.get(x.identity);
  expect(linkOf(context, "review").handoff).toMatchObject({ branch: "kanban/live-branch" });
  expect(readHead).not.toHaveBeenCalled();
  expect(x.git.mock.calls.map(([, args]) => args.join(" "))).toEqual(["rev-parse --abbrev-ref HEAD"]);
});

test.each([
  { stored: true, branch: "kanban/parent-integration" },
  { stored: false, branch: "kanban/live-branch" },
])("a sub-card's sub_card_of link carries the parent's branch (stored HEAD: $stored)", async ({ stored, branch }) => {
  const x = await setup([{ id: "parent", status: "development", relation: "sub_card_of", job: "waiting", ...(stored ? { pad: pad("parent", { head: head(branch) }) } : {}) }]);
  const context = await x.service.get(x.identity);
  const link = linkOf(context, "parent");
  expect(link).toMatchObject({ relation: "sub_card_of", branch });
  expect(link.handoff).toBeUndefined();
  expect(readHead).not.toHaveBeenCalled();
});

test("a Done blocker carries the branch it was delivered on, without a handoff or git", async () => {
  const x = await setup([{ id: "landed", status: "done", relation: "blocked_by", pad: pad("landed", { head: head("kanban/landed") }) }]);
  const context = await x.service.get(x.identity);
  expect(linkOf(context, "landed")).toMatchObject({ relation: "blocked_by", resolved: true, branch: "kanban/landed" });
  expect(linkOf(context, "landed").handoff).toBeUndefined();
  expect(x.git).not.toHaveBeenCalled();
  expect(x.refreshed.filter((id) => id !== "w")).toEqual([]);
});


test("a card linked as both sub-card and blocker spends and emits its handoff evidence once", async () => {
  const cards: Card[] = Array.from({ length: 3 }, (_, i) => ({
    id: `dual${i}`, status: "in_review", relation: "sub_card", delivered: "N".repeat(1000), pad: pad(`dual${i}`, {}, 4),
  }));
  const x = await setup(cards);
  await x.store.mutate((board) => {
    for (const c of cards) board.links.push({ id: `${c.id}-blocks`, projectId: "p", kind: "blocks", from: c.id, to: "t", createdBy: "human", createdAt: stamp });
  });
  const context = await x.service.get(x.identity);
  expect(context.links).toHaveLength(6);
  for (const c of cards) {
    const links = context.links.filter((l) => l.taskId === c.id);
    expect(links.map((l) => l.relation).sort()).toEqual(["blocked_by", "sub_card"]);
    const evidence = links.flatMap((l) => l.handoff ? [l.handoff.evidence] : []);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).not.toMatch(/^Omitted/);
  }
  expect(context.links.flatMap((l) => l.handoff ? [l.handoff.evidence] : []).join("").length).toBeLessThanOrEqual(16_000);
  expect(x.refreshed.filter((id) => id !== "w").sort()).toEqual(cards.map((c) => `${c.id}-ws`).sort());
  expect(x.git).toHaveBeenCalledTimes(3);
});
