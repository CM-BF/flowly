import { expect, test } from "vitest";
import { boardIfChanged, ifChanged } from "./etag";

test("the value is sent only when the caller's etag is stale", () => {
  const first = ifChanged({ a: 1 });
  expect(first.value).toEqual({ a: 1 });
  expect(ifChanged({ a: 1 }, first.etag)).toEqual({ etag: first.etag });
  const changed = ifChanged({ a: 2 }, first.etag);
  expect(changed.value).toEqual({ a: 2 });
  expect(changed.etag).not.toBe(first.etag);
});

const ev = (...ids: string[]) => ids.map((id) => ({ id }));

test("a board read sends only the events after what the caller holds", () => {
  const board = { revision: 3, events: ev("a", "b", "c", "d") };
  const full = boardIfChanged(board, {});
  expect(full.value).toBe(board);
  expect(full.delta).toBeUndefined();
  const delta = boardIfChanged(board, { etag: "stale", since: { count: 2, lastId: "b" } });
  expect(delta.delta).toBe(true);
  expect(delta.value).toEqual({ revision: 3, events: ev("c", "d") });
  expect(boardIfChanged(board, { etag: full.etag, since: { count: 2, lastId: "b" } })).toEqual({ etag: full.etag });
});

test("a held prefix that no longer matches falls back to the full board", () => {
  const board = { revision: 3, events: ev("a", "c", "d") };
  // "b" was deleted: the caller's two events no longer end where it thinks.
  expect(boardIfChanged(board, { since: { count: 2, lastId: "b" } }).delta).toBeUndefined();
  // Same last event, but events before it were removed.
  expect(boardIfChanged(board, { since: { count: 3, lastId: "c" } }).delta).toBeUndefined();
  expect(boardIfChanged(board, { since: { count: 3, lastId: "c" } }).value).toBe(board);
  // Nothing new but the board changed elsewhere: an empty delta.
  expect(boardIfChanged(board, { etag: "stale", since: { count: 3, lastId: "d" } }).value?.events).toEqual([]);
});
