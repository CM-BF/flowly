import { expect, test } from "vitest";
import { automationExecution } from "./automation";

// AUTOMATION-SPEC §2: with Full access on, every automation session runs in the provider's
// no-approval mode, whatever Permissions the role or the project default model chose.
const project = { provider: "codex", model: "p", modeId: "auto", featureValues: { service_tier: "priority" } };

test("Full access overrides the project default's and the role's Permissions, keeping other settings", () => {
  expect(automationExecution({ provider: "codex", model: "b" }, project, true)).toMatchObject({ modeId: "full-access", featureValues: { service_tier: "priority" } });
  expect(automationExecution({ provider: "codex", model: "b", modeId: "auto" }, project, true).modeId).toBe("full-access");
  expect(automationExecution({ provider: "codex", model: "b", modeId: "" }, project, true).modeId).toBe("full-access");
  expect(automationExecution({ provider: "claude", model: "c", modeId: "default" }, project, true).modeId).toBe("bypassPermissions");
});

test("with Full access off, the role's Permissions win, then the same-provider project default, then the provider default", () => {
  expect(automationExecution({ provider: "codex", model: "b", modeId: "auto-review" }, project, false).modeId).toBe("auto-review");
  expect(automationExecution({ provider: "codex", model: "b" }, project, false).modeId).toBe("auto");
  expect(automationExecution({ provider: "claude", model: "c" }, project, false)).not.toHaveProperty("modeId");
});

test("a provider without a known no-approval mode keeps the Permissions it was given", () => {
  expect(automationExecution({ provider: "opencode", model: "o", modeId: "build" }, null, true).modeId).toBe("build");
});
