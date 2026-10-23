import { expect, test } from "vitest";
import { taskDraft } from "./task-draft";
import { executionModel, startingAgent, agentModelSchema } from "./agent-defaults";
import { supportedFeatures } from "./agent-features";
test("preview title is bounded but multiline requirements stay intact", () => {
  const brief = `\n${"任务".repeat(150)}\nKeep path /a/b and acceptance criteria exactly.`;
  const draft = taskDraft(brief);
  expect(draft.title.length).toBeLessThanOrEqual(200);
  expect(draft.title).not.toContain("\n");
  expect(draft.description).toBe(brief);
  expect(draft.brief).toBe(brief);
});
test("explicit provider default and Standard override legacy full access and Fast", () => {
  const project = agentModelSchema.parse({ provider: "codex", model: "a", modeId: "full-access", featureValues: { service_tier: "priority" } });
  const explicit = executionModel({ provider: "codex", model: "b", modeId: "", featureValues: { service_tier: "default" } }, project, "full-access");
  expect(explicit).toMatchObject({ modeId: "", featureValues: { service_tier: "default" } });
  expect(startingAgent({ provider: "codex", model: "old", mode: "full-access" }, explicit)?.mode).toBe("");
  expect(executionModel({ provider: "claude", model: "c" }, project)).not.toHaveProperty("modeId");
  expect(executionModel({ provider: "codex", model: "b" }, project)).toMatchObject({ modeId: "full-access", featureValues: { service_tier: "priority" } });
  expect(supportedFeatures({ fast_mode: false, service_tier: "priority" }, [{ type: "toggle", id: "fast_mode", label: "Fast", value: true }])).toEqual({ fast_mode: false });
});
