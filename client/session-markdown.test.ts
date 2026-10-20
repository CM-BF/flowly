import { expect, test } from "vitest";
import { parseSessionMarkdown } from "./session-markdown";

test("tables accept short delimiters, alignment and missing outer pipes", () => {
  const [table] = parseSessionMarkdown(
    "a | b | c\n:-|:-:|-:\n1 | 2 | 3\nx | y\\|z | `p|q`",
  );
  expect(table).toEqual({
    kind: "table",
    headers: ["a", "b", "c"],
    align: ["left", "center", "right"],
    rows: [
      ["1", "2", "3"],
      ["x", "y|z", "`p|q`"],
    ],
  });
});

test("a pipe line with a mismatched delimiter stays a paragraph", () => {
  expect(parseSessionMarkdown("a | b\n--- | --- | ---")[0].kind).toBe("paragraph");
});
