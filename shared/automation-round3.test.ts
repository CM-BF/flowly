import { expect, test } from "vitest";
import type { Board, Link, Project, Status, Task } from "./model";
import { childrenOf, parentOf } from "./links";
import { automationSettingsSchema, isLive, jobOf, liveStates, parentShouldWake, readiness, subCardActive, subCardSignature, type AutomationJob } from "./automation";

// SUB-CARDS-SPEC §5: whether sub-cards move is decided once per board snapshot, in time linear in cards and links.
const at = "2026-10-22T00:00:00.000Z";
const project = (id: string): Project => ({
  id, title: id, description: "", paseoProjectId: `n-${id}`, primaryPath: "/p", repos: ["/p"], revision: 1, createdAt: at, updatedAt: at, archivedAt: null,
  automation: automationSettingsSchema.parse({ enabled: true, maxRunning: 2 }),
});
const task = (id: string, status: Status = "todo", extra: Partial<Task> = {}): Task => ({
  id, projectId: "p", workspaceId: `w-${id}`, sourcePath: "/p", repoPaths: [], title: id, description: "", status, priority: "normal", position: 0, revision: 1,
  operationId: `op-${id}`, createdAt: at, updatedAt: at, archivedAt: null, ...extra,
});
const job = (taskId: string, extra: Partial<AutomationJob> = {}): AutomationJob => ({
  taskId, projectId: "p", state: "queued", role: "implementer", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: at, updatedAt: at, ...extra,
});
const board = (over: Partial<Board> = {}) => ({ projects: [project("p")], tasks: [], links: [], events: [], automation: [], ...over }) as unknown as Board;
const blocks = (from: string, to: string): Link => ({ id: `${from}-blocks-${to}`, projectId: "p", kind: "blocks", from, to, createdBy: "human", createdAt: at });
const sub = (from: string, to: string): Link => ({ id: `${from}-sub-${to}`, projectId: "p", kind: "subtask", from, to, createdBy: "human", createdAt: at });

/** Sub-cards c1..cn of a waiting parent P; c1 is delivered, each later one is blocked by the two before it. */
function ladder(n: number) {
  const ids = Array.from({ length: n }, (_, i) => `c${i + 1}`);
  const b = board({
    tasks: [task("P", "development"), ...ids.map((id, i) => task(id, i === 0 ? "in_review" : "todo"))],
    links: [...ids.map((id) => sub(id, "P")), ...ids.flatMap((id, i) => [i >= 1 ? blocks(ids[i - 1], id) : null, i >= 2 ? blocks(ids[i - 2], id) : null].filter((l): l is Link => !!l))],
    automation: [job("P", { state: "waiting", implementerId: "pa" }), ...ids.map((id, i) => job(id, i === 0 ? { state: "delivered" } : {}))],
  });
  return { b, ids };
}

/** Counts every read of the board's card, link and job lists. */
function counted(b: Board) {
  let reads = 0;
  for (const key of ["tasks", "links", "automation"] as const) {
    const value = b[key];
    Object.defineProperty(b, key, { get: () => (reads++, value), configurable: true });
  }
  return () => reads;
}

test("deciding whether a waiting parent wakes reads the board a number of times linear in its sub-cards, not once per blocker path", () => {
  const { b } = ladder(22);
  const parent = b.automation.find((j) => j.taskId === "P")!;
  parent.subSeen = subCardSignature(b, "P");
  const reads = counted(b);
  expect(parentShouldWake(b, parent)).toBe(false);
  expect(reads()).toBeLessThan(10 * 22);
});

test("a dependency cycle ends the walk and never moves; motion still flows past it from a working blocker", () => {
  const b = board({
    tasks: ["x", "y", "z", "w", "v"].map((id) => task(id)),
    links: [blocks("x", "y"), blocks("y", "x"), blocks("x", "z"), blocks("w", "v")],
    automation: [job("x"), job("y"), job("z"), job("w", { state: "working" }), job("v")],
  });
  expect(["x", "y", "z", "w", "v"].map((id) => subCardActive(b, id))).toEqual([false, false, false, true, true]);
});

/** The walk as it was before memoizing: every blocker and sub-card path, `seen` only against cycles. */
function reference(b: Board, id: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const t = b.tasks.find((x) => x.id === id);
  if (!t || t.archivedAt || t.status === "done" || t.status === "cancelled") return false;
  if (childrenOf(b.links, id).some((child) => reference(b, child, new Set(seen)))) return true;
  const j = jobOf(b, id);
  if (!j || !isLive(j)) return false;
  if (j.state !== "queued") return true;
  const ready = readiness(b, id);
  if (ready.ready) return true;
  if (ready.reason !== "blockers" || ready.cancelled.length) return false;
  const parent = parentOf(b.links, id);
  return ready.waiting.some((blocker) => !(!!parent && parentOf(b.links, blocker.id) === parent && blocker.status === "in_review") && reference(b, blocker.id, new Set(seen)));
}

test("memoized motion answers exactly what the full walk answered, on many random boards", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const statuses: Status[] = ["todo", "development", "in_review", "done", "cancelled", "blocked"];
  for (let round = 0; round < 300; round++) {
    const ids = Array.from({ length: 9 }, (_, i) => `k${i}`);
    const links: Link[] = [];
    for (const id of ids.slice(1)) if (random() < 0.6) links.push(sub(id, pick(ids.slice(0, 3))));
    for (let i = 0; i < 14; i++) {
      const from = pick(ids), to = pick(ids);
      links.push({ ...blocks(from, to), id: `l${i}` });
    }
    const b = board({
      tasks: ids.map((id) => task(id, pick(statuses), random() < 0.1 ? { archivedAt: at } : {})),
      links,
      automation: ids.filter(() => random() < 0.85).map((id) => job(id, { state: random() < 0.6 ? "queued" : pick([...liveStates, "delivered", "failed", "stopped"]) })),
    });
    for (const id of ids) expect(subCardActive(b, id), `round ${round}, card ${id}`).toBe(reference(b, id));
  }
});
