import { expect, test } from "vitest";
import { emptyHandoff } from "./handoff";
import { handoffView } from "./handoff-view";

const base = { rev: 1, at: "2026-10-24T01:00:00Z", by: { kind: "human" as const } };
test("a bounded preview preserves the full-read identity and leaves the original untouched", () => {
  const record = emptyHandoff("card", "project");
  record.inputs.push({ ...base, id: "original", atSource: "typed", via: "session", text: "指示".repeat(4000), characters: 8000, status: "open" });
  const view = handoffView(record);
  expect(view.complete).toBe(false);
  expect(view.truncatedIds).toContain("original");
  expect(view.record.inputs[0].text).toHaveLength(1600);
  expect(record.inputs[0].text).toHaveLength(8000);
  expect(view.openIds).toEqual(["original"]);
  expect(view.fullRead).toContain("nextCursor");
});

test("all sections share one budget and omitted unresolved entries remain counted", () => {
  const record = emptyHandoff("card", "project");
  for (let n = 0; n < 60; n++) record.inputs.push({ ...base, id: `input-${n}`, atSource: "typed", via: "session", text: "x".repeat(1000), characters: 1000, status: "open" });
  const view = handoffView(record, { max: 6000 });
  expect(JSON.stringify(view).length).toBeLessThanOrEqual(6000);
  expect(view.complete).toBe(false);
  expect(view.openIdsTotal).toBe(60);
  expect(view.omitted).toBeGreaterThan(0);
  expect(view.record.inputs.length).toBeGreaterThan(0);
});
