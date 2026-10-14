import { expect, test } from "vitest";
import { filterOptions, modelOptions, providerOptions } from "./options";

test("filter matches label, detail and id case-insensitively", () => {
  const options = [
    { value: "claude-opus-5-5", label: "Opus 5.5", detail: "Latest release" },
    { value: "claude-haiku-5-5", label: "Haiku 5.5", detail: "Fastest" },
  ];
  expect(filterOptions(options, "opus").map((o) => o.value)).toEqual(["claude-opus-5-5"]);
  expect(filterOptions(options, "FAST").map((o) => o.value)).toEqual(["claude-haiku-5-5"]);
  expect(filterOptions(options, "haiku-5").map((o) => o.value)).toEqual(["claude-haiku-5-5"]);
  expect(filterOptions(options, "  ")).toHaveLength(2);
});

test("models drop unselectable entries and mark the default", () => {
  expect(modelOptions([
    { id: "a", label: "A", description: "A · Latest", isDefault: true },
    { id: "b", label: "B", isSelectable: false },
    { id: "c-1", label: "C" },
  ])).toEqual([
    { value: "a", label: "A", detail: "Latest", badge: "Default" },
    { value: "c-1", label: "C", detail: "c-1", badge: undefined },
  ]);
});

test("providers keep only available ones and use snapshot labels", () => {
  expect(providerOptions(
    [{ provider: "claude", available: true }, { provider: "x", available: false }, { provider: "codex", available: true }],
    [{ provider: "claude", label: "Claude Code", description: "Anthropic" }],
  )).toEqual([
    { value: "claude", label: "Claude Code", detail: "Anthropic" },
    { value: "codex", label: "codex", detail: undefined },
  ]);
});
