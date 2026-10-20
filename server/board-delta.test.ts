import { expect, test } from "vitest";
import { BoardDeltas, diffBoard, fingerprint, type View } from "./board-delta";

const task = (id: string, title = id) => ({ id, title });
const board = (over: Partial<Record<string, unknown>> = {}): View =>
  ({
    revision: 1,
    events: [{ id: "e1" }, { id: "e2" }],
    plans: [],
    projects: [{ id: "p" }],
    tasks: [task("a"), task("b"), task("c")],
    ideas: [],
    links: [],
    artifacts: [],
    workpads: [{ taskId: "a", revision: 1 }],
    attentionDismissals: [],
    ...over,
  }) as unknown as View;

const patchOf = (before: View, after: View) => diffBoard(fingerprint(before), fingerprint(after), after)!;

test("only changed items, removed ids and new events travel", () => {
  const patch = patchOf(board(), board({ revision: 2, events: [{ id: "e1" }, { id: "e2" }, { id: "e3" }], tasks: [task("a"), task("b", "renamed"), task("c")] }));
  expect(patch.revision).toBe(2);
  expect(patch.events).toEqual([{ id: "e3" }]);
  expect(patch.tasks).toEqual({ set: [task("b", "renamed")], remove: [] });
  expect(patch.workpads).toBeUndefined();
  expect(patch.projects).toBeUndefined();
  expect(patch.plans).toBeUndefined();
});

test("added items are appended, removed ones listed, and an order is sent only when it differs", () => {
  const added = patchOf(board(), board({ tasks: [task("a"), task("b"), task("c"), task("d")] }));
  expect(added.tasks).toEqual({ set: [task("d")], remove: [] });
  const removed = patchOf(board(), board({ tasks: [task("a"), task("c")] }));
  expect(removed.tasks).toEqual({ set: [], remove: ["b"] });
  const inserted = patchOf(board(), board({ tasks: [task("d"), task("a"), task("b"), task("c")] }));
  expect(inserted.tasks).toEqual({ set: [task("d")], remove: [], order: ["d", "a", "b", "c"] });
  const moved = patchOf(board(), board({ tasks: [task("c"), task("a"), task("b")] }));
  expect(moved.tasks).toEqual({ set: [], remove: [], order: ["c", "a", "b"] });
});

test("plans travel whole when they change; workpads are matched by task", () => {
  const patch = patchOf(board(), board({ plans: [{ taskId: "a" }], workpads: [{ taskId: "a", revision: 2 }, { taskId: "b", revision: 1 }] }));
  expect(patch.plans).toEqual([{ taskId: "a" }]);
  expect(patch.workpads).toEqual({ set: [{ taskId: "a", revision: 2 }, { taskId: "b", revision: 1 }], remove: [] });
});

test("events that no longer continue the caller's are not patched", () => {
  const before = fingerprint(board());
  const rewritten = board({ events: [{ id: "e1" }, { id: "x" }, { id: "e3" }] });
  expect(diffBoard(before, fingerprint(rewritten), rewritten)).toBeNull();
  const shorter = board({ events: [{ id: "e1" }] });
  expect(diffBoard(before, fingerprint(shorter), shorter)).toBeNull();
});

test("the daemon patches a remembered etag and falls back otherwise", () => {
  const deltas = new BoardDeltas(2);
  const first = deltas.read(board(), {});
  expect(first).toHaveProperty("value");
  expect(deltas.read(board(), { etag: first.etag })).toEqual({ etag: first.etag });
  const next = board({ revision: 2, tasks: [task("a"), task("b", "renamed"), task("c")] });
  const patched = deltas.read(next, { etag: first.etag });
  expect(patched).toHaveProperty("patch");
  expect(patched).not.toHaveProperty("value");
  // An etag it never served: the events-only delta when the caller says what it holds, else everything.
  const bigger = board({ revision: 3, events: [{ id: "e1" }, { id: "e2" }, { id: "e3" }] });
  expect(deltas.read(bigger, { etag: "unknown", since: { count: 2, lastId: "e2" } })).toMatchObject({ delta: true });
  expect(deltas.read(bigger, { etag: "unknown" })).toMatchObject({ value: bigger });
  // The first board was forgotten (capacity 2): a full read again.
  expect(deltas.read(bigger, { etag: first.etag })).toHaveProperty("value");
});
