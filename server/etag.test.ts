import { expect, test } from "vitest";
import { ifChanged } from "./etag";

test("the value is sent only when the caller's etag is stale", () => {
  const first = ifChanged({ a: 1 });
  expect(first.value).toEqual({ a: 1 });
  expect(ifChanged({ a: 1 }, first.etag)).toEqual({ etag: first.etag });
  const changed = ifChanged({ a: 2 }, first.etag);
  expect(changed.value).toEqual({ a: 2 });
  expect(changed.etag).not.toBe(first.etag);
});
