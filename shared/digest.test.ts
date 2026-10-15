import { expect, test } from "vitest";
import { parseDigest } from "./digest";

const ids = new Set(["t1"]);

test("parses fenced JSON, keeps known task ids, accepts plain strings, cuts long lists", () => {
  const text =
    "Here:\n```json\n" +
    JSON.stringify({
      headline: " Shipped insights ",
      done: [{ text: "Insights page", taskId: "t1" }, { text: "Other", taskId: "nope" }],
      progressed: ["Tabs", ""],
      issues: [],
      next: Array.from({ length: 8 }, (_, i) => ({ text: `n${i}`, taskId: "" })),
    }) +
    "\n```";
  const out = parseDigest(text, ids);
  expect(out.headline).toBe("Shipped insights");
  expect(out.done).toEqual([{ text: "Insights page", taskId: "t1" }, { text: "Other" }]);
  expect(out.progressed).toEqual([{ text: "Tabs" }]);
  expect(out.next.length).toBe(5);
});

test("rejects missing JSON or headline", () => {
  expect(() => parseDigest("no json", ids)).toThrow("no JSON");
  expect(() => parseDigest('{"done": []}', ids)).toThrow("headline");
});
