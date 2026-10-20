import { describe, expect, test } from "vitest";
import type { BoardEvent, Workpad } from "./model";
import {
  currentDelivery,
  mergeWorkpad,
  openItems,
  planFromTimeline,
  validationFreshness,
  workpadNote,
  workpadSignal,
  type WorkpadDraft,
} from "./workpad";

const t0 = "2026-10-19T00:00:00.000Z",
  t1 = "2026-10-19T01:00:00.000Z";
const head = (sha: string, dirty = false) => ({ sha, dirty, at: t0 });

function pad(over: Partial<Workpad> = {}): Workpad {
  return {
    taskId: "t",
    projectId: "p",
    revision: 1,
    acceptance: [],
    validation: [],
    confusions: [],
    env: null,
    head: head("aaaaaaaaaaaa"),
    updatedAt: t0,
    updatedBy: "agent",
    ...over,
  };
}
const check = (id: string, state: "pass" | "fail" | "unrun", sha?: string) => ({ id, text: id, state, ...(sha ? { sha } : {}), by: "agent" as const, at: t0 });

describe("validation freshness (WORKPAD-SPEC §5.2)", () => {
  test("fresh on the same commit, stale after HEAD moves, unknown without git, null when unrun", () => {
    expect(validationFreshness({ state: "pass", sha: "aaaaaaaaaaaa" }, head("aaaaaaaaaaaa"))).toBe("fresh");
    expect(validationFreshness({ state: "pass", sha: "aaaaaaa" }, head("aaaaaaaaaaaa"))).toBe("fresh");
    expect(validationFreshness({ state: "fail", sha: "aaaaaaaaaaaa" }, head("bbbbbbbbbbbb"))).toBe("stale");
    expect(validationFreshness({ state: "pass", sha: "aaaaaaaaaaaa" }, null)).toBe("unknown");
    expect(validationFreshness({ state: "pass" }, head("aaaaaaaaaaaa"))).toBe("unknown");
    expect(validationFreshness({ state: "unrun" }, head("aaaaaaaaaaaa"))).toBeNull();
  });
});

describe("open items (§5.3)", () => {
  test("unchecked criteria, failed, unrun and out-of-date passing checks count; confusions do not", () => {
    const w = pad({
      head: head("bbbbbbbbbbbb"),
      acceptance: [
        { id: "a", text: "a", done: true, by: "agent", at: t0 },
        { id: "b", text: "b", done: false, by: "agent", at: t0 },
      ],
      validation: [check("p", "pass", "bbbbbbbbbbbb"), check("s", "pass", "aaaaaaaaaaaa"), check("f", "fail", "bbbbbbbbbbbb"), check("u", "unrun")],
      confusions: [{ id: "c", text: "c", at: t0 }],
    });
    expect(openItems(w)).toEqual({ unchecked: 1, failed: 1, unrun: 1, stale: 1, total: 4 });
    expect(openItems(null).total).toBe(0);
  });
});

describe("merging an agent's full replacement (§3.1, §5.1)", () => {
  const ctx = { now: t1, head: head("cccccccccccc"), resolved: new Map([["abc1234", "abc123400000"]]) };
  const draft = (over: Partial<WorkpadDraft> = {}): WorkpadDraft => ({ acceptance: [], validation: [], confusions: [], ...over });

  test("new items get slug ids; unchanged items keep who changed them and when", () => {
    const first = mergeWorkpad(undefined, draft({ acceptance: [{ text: "Shows Checks 3/5", done: false }, { text: "Shows Checks 3/5 too", done: false }] }), ctx);
    expect(first.acceptance.map((a) => a.id)).toEqual(["shows-checks-3-5", "shows-checks-3-5-too"]);
    // A person ticked the first one; the agent sends it back unchanged, matched by text.
    const ticked = { ...first, acceptance: [{ ...first.acceptance[0]!, done: true, by: "human" as const, at: t0 }, first.acceptance[1]!] };
    const next = mergeWorkpad(ticked, draft({ acceptance: [{ text: "shows checks 3/5", done: true }, { id: "shows-checks-3-5-too", text: "Shows Checks 3/5 too", done: true }] }), { ...ctx, now: "2026-10-19T02:00:00.000Z" });
    expect(next.acceptance[0]).toMatchObject({ id: "shows-checks-3-5", by: "agent" }); // text changed (case)
    expect(next.acceptance[1]).toMatchObject({ id: "shows-checks-3-5-too", done: true, by: "agent" });
    const same = mergeWorkpad(ticked, draft({ acceptance: [{ text: "Shows Checks 3/5", done: true }] }), ctx);
    expect(same.acceptance[0]).toMatchObject({ by: "human", at: t0 });
  });

  test("CJK text without ids still gets distinct ids and keeps them by text", () => {
    const first = mergeWorkpad(undefined, draft({ confusions: [{ text: "不清楚范围" }, { text: "不清楚优先级" }] }), ctx);
    expect(first.confusions.map((c) => c.id)).toEqual(["item", "item-2"]);
    const again = mergeWorkpad(first, draft({ confusions: [{ text: "不清楚优先级" }] }), ctx);
    expect(again.confusions).toEqual([first.confusions[1]]);
  });

  test("duplicate explicit ids are refused", () => {
    expect(() => mergeWorkpad(undefined, draft({ acceptance: [{ id: "x", text: "a", done: false }, { id: "x", text: "b", done: false }] }), ctx)).toThrow(/Duplicate/);
  });

  test("a check's commit: the verified sha given, else the previous one when unchanged, else HEAD", () => {
    const given = mergeWorkpad(undefined, draft({ validation: [{ id: "t", text: "tests", state: "pass", sha: "abc1234", dirty: true }] }), ctx);
    expect(given.validation[0]).toMatchObject({ sha: "abc123400000", dirty: true, ranAt: t1 });
    const kept = mergeWorkpad(given, draft({ validation: [{ id: "t", text: "tests", state: "pass" }] }), { ...ctx, now: "2026-10-19T03:00:00.000Z" });
    expect(kept.validation[0]).toMatchObject({ sha: "abc123400000", dirty: true, ranAt: t1, at: t1 });
    const failed = mergeWorkpad(given, draft({ validation: [{ id: "t", text: "tests", state: "fail" }] }), ctx);
    expect(failed.validation[0]).toMatchObject({ sha: "cccccccccccc", state: "fail" });
    expect(failed.validation[0]!.dirty).toBeUndefined();
    const unrun = mergeWorkpad(given, draft({ validation: [{ id: "t", text: "tests", state: "unrun" }] }), ctx);
    expect(unrun.validation[0]).not.toHaveProperty("sha");
    expect(unrun.validation[0]).not.toHaveProperty("ranAt");
    expect(() => mergeWorkpad(undefined, draft({ validation: [{ text: "x", state: "pass", sha: "dead" }] }), ctx)).toThrow(/Unknown commit/);
    const noGit = mergeWorkpad(undefined, draft({ validation: [{ text: "x", state: "pass" }] }), { ...ctx, head: null });
    expect(noGit.validation[0]).not.toHaveProperty("sha");
  });

  test("limits", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ text: `c${i}`, done: false }));
    expect(() => mergeWorkpad(undefined, draft({ acceptance: many }), ctx)).toThrow(/At most 20/);
  });
});

describe("card signal and delivery (§5.3, §6.1)", () => {
  const delivered = (eventId: string, total: number): Workpad["delivery"] => ({ unchecked: total, failed: 0, unrun: 0, stale: 0, total, revision: 1, eventId, at: t0 });
  const toReview = (id: string): BoardEvent => ({ id, taskId: "t", actor: "agent", action: "status_changed", from: "test", to: "in_review", at: t0 });

  test("priority: delivered with open items, failed, out of date, checks, acceptance", () => {
    const base = pad({
      head: head("bbbbbbbbbbbb"),
      acceptance: [{ id: "a", text: "a", done: false, by: "agent", at: t0 }],
      validation: [check("p", "pass", "bbbbbbbbbbbb"), check("s", "pass", "aaaaaaaaaaaa"), check("f", "fail", "bbbbbbbbbbbb")],
    });
    expect(workpadSignal({ status: "in_review" }, { ...base, delivery: delivered("e", 3) }, [toReview("e")])).toEqual({ kind: "delivered", done: 1, total: 3, count: 3 });
    expect(workpadSignal({ status: "test" }, base, [])).toEqual({ kind: "failed", done: 1, total: 3, count: 1 });
    expect(workpadSignal({ status: "test" }, { ...base, validation: base.validation.slice(0, 2) }, [])).toEqual({ kind: "stale", done: 1, total: 2, count: 1 });
    expect(workpadSignal({ status: "test" }, { ...base, validation: base.validation.slice(0, 1) }, [])).toEqual({ kind: "checks", done: 1, total: 1, count: 0 });
    expect(workpadSignal({ status: "test" }, { ...base, validation: [] }, [])).toEqual({ kind: "acceptance", done: 0, total: 1, count: 0 });
    expect(workpadSignal({ status: "test" }, pad(), [])).toBeNull();
    expect(workpadSignal({ status: "test" }, null, [])).toBeNull();
    // Finished cards: a pass on an old commit still counts, and "out of date" never shows.
    const stalePad = { ...base, validation: base.validation.slice(0, 2) };
    expect(workpadSignal({ status: "done" }, stalePad, [])).toEqual({ kind: "checks", done: 2, total: 2, count: 0 });
    expect(workpadSignal({ status: "cancelled" }, stalePad, [])?.kind).toBe("checks");
    expect(workpadSignal({ status: "test", archivedAt: "2026-10-20T00:00:00Z" }, stalePad, [])?.kind).toBe("checks");
    expect(workpadSignal({ status: "done" }, base, [])?.kind).toBe("failed");
  });

  test("the delivery marker belongs to the move into In review that recorded it", () => {
    const w = pad({ delivery: delivered("e1", 2) });
    expect(currentDelivery({ status: "in_review" }, w, [toReview("e1")])).not.toBeNull();
    // Left and came back (a person dragged it): another move, no marker.
    expect(currentDelivery({ status: "in_review" }, w, [toReview("e1"), toReview("e2")])).toBeNull();
    expect(currentDelivery({ status: "development" }, w, [toReview("e1")])).toBeNull();
    // History trimmed past the move: keep it.
    expect(currentDelivery({ status: "in_review" }, w, [])).not.toBeNull();
  });

  test("event note", () => {
    expect(workpadNote(pad({ acceptance: [{ id: "a", text: "a", done: true, by: "agent", at: t0 }], validation: [check("f", "fail"), check("p", "pass")] }))).toBe(
      "Acceptance 1/1 · Checks 1/2, 1 failed",
    );
    expect(workpadNote(pad())).toBe("Workpad cleared");
  });
});

describe("plan from the native todo list (§2.2)", () => {
  test("the last todo of the turn; none keeps the previous plan; empty clears it", () => {
    const timeline = [
      { type: "todo", items: [{ text: "old", completed: false }] },
      { type: "assistant_message" },
      {
        type: "todo",
        items: [
          { text: "Write spec", completed: true },
          { text: "Implement", completed: false, status: "in_progress" },
          { text: "  ", completed: false },
          { text: "Test", completed: false },
        ],
      },
    ];
    expect(planFromTimeline(timeline)).toEqual([
      { text: "Write spec", status: "completed" },
      { text: "Implement", status: "in_progress" },
      { text: "Test", status: "pending" },
    ]);
    expect(planFromTimeline([{ type: "assistant_message" }])).toBeUndefined();
    expect(planFromTimeline(undefined)).toBeUndefined();
    expect(planFromTimeline([{ type: "todo", items: [] }])).toEqual([]);
  });
});
