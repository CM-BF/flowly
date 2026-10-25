import { expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { emptyHandoff, type CardHandoff, type HandoffActor } from "../shared/handoff";
import { emptyBoard, type Board, type Link, type Status, type Task } from "../shared/model";
import { linkedContinuity, type ContinuityKind, type ContinuityReader } from "./handoff-links";
import { cardLocation, handoffBudget, linkExtras } from "./automation-handoff";
import { HandoffService } from "./handoff-service";
import { BoardStore } from "./store";

const at = "2026-10-24T00:00:00.000Z";
const entry = (id: string, kind: HandoffActor["kind"] = "agent") => ({ id, rev: 1, at, by: { kind } });
function record(taskId = "card"): CardHandoff {
  const r = emptyHandoff(taskId, "project"); r.revision = 7;
  r.state = { ...entry("state"), text: "SAFE-STATE" };
  r.pitfalls = [{ ...entry("agent-pitfall"), text: "SAFE-PITFALL\nDo not normalize CRLF" }, { ...entry("human-pitfall", "human"), text: "PRIVATE-HUMAN-PITFALL" }];
  r.problems = [{ ...entry("agent-problem"), text: "SAFE-PROBLEM", status: "open" }, { ...entry("human-problem", "human"), text: "PRIVATE-HUMAN-PROBLEM", status: "open" }];
  r.env = [{ ...entry("agent-env"), text: "SAFE-ENVIRONMENT" }, { ...entry("human-env", "human"), text: "PRIVATE-HUMAN-ENVIRONMENT" }];
  r.notes = [{ ...entry("incident", "flowly"), kind: "incident", text: "SAFE-INCIDENT" }, { ...entry("hazard", "flowly"), kind: "hazard", text: "SAFE-HAZARD" }, { ...entry("private-note", "human"), kind: "direction", text: "PRIVATE-HUMAN-NOTE" }, { ...entry("system-direction", "flowly"), kind: "direction", text: "PRIVATE-DIRECTION" }];
  r.inputs = [{ ...entry("input", "human"), text: "PRIVATE-ORIGINAL-INPUT", characters: 22, atSource: "typed", via: "session", status: "open" }];
  r.questions = [{ ...entry("question"), kind: "question", text: "PRIVATE-QUESTION", askedBy: "impl", status: "open" }];
  r.reviews = [{ ...entry("review"), cycle: 1, round: 1, reviewerId: "reviewer", verdict: "changes", summary: "PRIVATE-REVIEW", findings: [], risks: [], gaps: [], delivery: { text: "PRIVATE-DELIVERY" } }];
  r.ledger = [{ ...entry("session"), agentId: "impl", n: 1, role: "implementer", provider: "codex", startedAt: at, reason: "launch", finalized: false, turns: [], background: [], live: [{ at, text: "PRIVATE-CONVERSATION" }] }];
  r.decisions = [{ ...entry("decision"), text: "PRIVATE-DECISION", why: "PRIVATE-REASON" }];
  return r;
}

test.each<ContinuityKind>(["child", "dependency", "parent"])("%s continuity never includes original inputs, private conversation or human-authored context", (kind) => {
  const r = record(); const before = structuredClone(r), summary = linkedContinuity(r, kind);
  expect(summary).toContain("Handoff r7; card card"); expect(summary).toContain("SAFE-PITFALL Do not normalize CRLF");
  expect(summary).not.toContain("PRIVATE-"); expect(r).toEqual(before);
  if (kind === "parent") { for (const text of ["SAFE-STATE", "SAFE-ENVIRONMENT", "SAFE-INCIDENT", "SAFE-HAZARD", "Problems:"]) expect(summary).not.toContain(text); }
  else { expect(summary).toContain("SAFE-STATE"); expect(summary).toContain("Problems: 1"); expect(summary).toContain("SAFE-INCIDENT"); expect(summary).toContain("SAFE-HAZARD"); }
  if (kind === "dependency") expect(summary).toContain("SAFE-ENVIRONMENT"); else expect(summary).not.toContain("SAFE-ENVIRONMENT");
  r.state!.by = { kind: "human" }; r.state!.text = "PRIVATE-HUMAN-STATE";
  expect(linkedContinuity(r, kind)).not.toContain("PRIVATE-");
});

test.each<ContinuityKind>(["child", "dependency", "parent"])("%s continuity stays within its budget and labels omissions for a long legal card id", (kind) => {
  const r = record("c".repeat(200)); r.state!.text = "State ".repeat(200);
  r.pitfalls = Array.from({ length: 30 }, (_, n) => ({ ...entry(`pitfall-${n}`), text: `Pitfall ${n} ` + "x".repeat(350) }));
  r.overflow.push({ section: "pitfalls", id: "archived-pitfall", rev: 1, at, status: "closed", firstLine: "PRIVATE-ARCHIVED-PREVIEW", contentRef: "a".repeat(64), openIds: [] });
  const summary = linkedContinuity(r, kind), budget = kind === "child" ? 600 : kind === "parent" ? 1000 : 1500;
  expect(summary.length).toBeLessThanOrEqual(budget); expect(summary).toMatch(/Omitted \d+ entries; open this card's Handoff for details\.$/);
  expect(summary).not.toContain("PRIVATE-ARCHIVED-PREVIEW");
});

test("missing and unreadable continuity have different meanings without leaking the filesystem error", async () => {
  const service = new HandoffService(new BoardStore("/unused-flowly-handoff-links-test"));
  vi.spyOn(service.records, "read").mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("PRIVATE-FILESYSTEM-CREDENTIAL"));
  expect(await service.linkSummary("card", "parent")).toBeUndefined();
  const unavailable = await service.linkSummary("card", "parent"); expect(unavailable).toMatch(/unavailable.*do not infer/); expect(unavailable).not.toContain("PRIVATE-");
});

const task = (id: string, status: Status = "in_review"): Task => ({ id, projectId: "project", workspaceId: `w-${id}`, sourcePath: "/fixture", repoPaths: [], title: id, description: "", status, priority: "normal", position: 0, revision: 1, operationId: `create-${id}`, createdAt: at, updatedAt: at, archivedAt: null });
const link = (kind: Link["kind"], from: string, to: string): Link => ({ id: `${from}-${kind}-${to}`, projectId: "project", kind, from, to, createdBy: "human", createdAt: at });
function board(): Board { return { ...emptyBoard(), projects: [{ id: "project", title: "P", description: "", primaryPath: "/fixture", repos: ["/fixture"], paseoProjectId: "native", revision: 1, createdAt: at, updatedAt: at, archivedAt: null }], tasks: [task("current", "development"), task("parent", "development")] }; }
const paseo = { workspaces: { ref: (_id: string) => ({ refresh: async () => ({ workspaceDirectory: undefined }) }) } } as unknown as PaseoApi;

test("a busy parent's location asks only for the bounded parent summary and never refreshes its git index", async () => {
  const b = board(), parent = record("parent"), reader = vi.fn<ContinuityReader>(async (id, kind) => linkedContinuity(parent, kind));
  const api = { workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: "/fixture/parent" }) }) } } as unknown as PaseoApi;
  const git = vi.fn(async (_cwd: string, _args: string[]) => "parent-feature\n");
  const result = await cardLocation(b, "parent", api, git, reader);
  expect(reader).toHaveBeenCalledExactlyOnceWith("parent", "parent");
  expect(git).toHaveBeenCalledExactlyOnceWith("/fixture/parent", ["rev-parse", "--abbrev-ref", "HEAD"]);
  expect(result).toMatchObject({ id: "parent", branch: "parent-feature", continuity: expect.stringContaining("SAFE-PITFALL") });
  expect(JSON.stringify(result)).not.toContain("PRIVATE-"); expect(result).not.toHaveProperty("evidence");
});

test("link extras attach only a parent's pitfall summary, preserve its known branch, and expose no parent delivery or blockers", async () => {
  const b = board(); b.links.push(link("subtask", "current", "parent"));
  b.events.push({ id: "private-delivery", taskId: "parent", actor: "agent", action: "status_changed", to: "in_review", note: "PRIVATE-PARENT-DELIVERY", at });
  b.workpads.push({ taskId: "parent", projectId: "project", revision: 1, acceptance: [], validation: [], confusions: [], head: { branch: "integration-parent", sha: "a".repeat(40), dirty: false, at }, env: null, updatedAt: at, updatedBy: "human" });
  const reader = vi.fn<ContinuityReader>(async (_id, kind) => linkedContinuity(record("parent"), kind)), git = vi.fn(async () => "");
  const result = await linkExtras(b, "current", paseo, git, reader), parent = result.handoffs.get("parent");
  expect(reader).toHaveBeenCalledExactlyOnceWith("parent", "parent"); expect(result.branches.get("parent")).toBe("integration-parent"); expect(git).not.toHaveBeenCalled();
  expect(parent).toMatchObject({ branch: "integration-parent", evidence: "", blockers: [], continuity: expect.stringContaining("SAFE-PITFALL") });
  expect(JSON.stringify(parent)).not.toContain("PRIVATE-"); expect(parent).not.toHaveProperty("risks");
});

test("parent continuity shares the total evidence and risk budget with child and dependency handoffs", async () => {
  const b = board(); b.links.push(link("subtask", "current", "parent"));
  for (let n = 0; n < 20; n++) {
    const id = `child-${n}`; b.tasks.push(task(id)); b.links.push(link("subtask", id, "current"));
    b.events.push({ id: `delivery-${n}`, taskId: id, actor: "agent", action: "status_changed", to: "in_review", note: "e".repeat(1500), at });
  }
  b.tasks.push(task("dependency")); b.links.push(link("blocks", "dependency", "current"));
  const reader = vi.fn<ContinuityReader>(async (id, kind) => `${id}:${kind}:` + "s".repeat(kind === "parent" ? 970 : kind === "child" ? 560 : 1460));
  const { handoffs } = await linkExtras(b, "current", paseo, async () => "", reader);
  expect(reader).toHaveBeenCalledWith("parent", "parent"); expect(reader).toHaveBeenCalledWith("dependency", "dependency");
  expect(reader).toHaveBeenCalledWith("child-0", "child");
  const used = [...handoffs.values()].reduce((sum, h) => sum + (h.evidence.startsWith("Omitted") ? 0 : h.evidence.length) + (h.risks ? JSON.stringify(h.risks).length : 0) + (h.continuity?.startsWith("Continuity summary omitted") ? 0 : h.continuity?.length ?? 0), 0);
  expect(used).toBeLessThanOrEqual(handoffBudget.total);
  expect(handoffs.get("parent")).toMatchObject({ evidence: "", blockers: [], continuity: expect.stringMatching(/omitted by the total budget/) });
  expect([...handoffs.values()].some(h => h.evidence.startsWith("Omitted"))).toBe(true);
});
