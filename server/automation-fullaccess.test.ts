import { afterEach, expect, test } from "vitest";
import { automationFixture as setup, cleanupAutomationFixtures } from "./automation-fixture";

afterEach(cleanupAutomationFixtures);

const implementer = { provider: "codex", model: "gpt-6-luna" };

async function start(fullAccess: boolean) {
  const x = await setup({ enabled: true, fullAccess, implementer });
  // The project default model asks for approvals: a mode a person picked for ordinary sessions.
  await x.store.mutate((board) => { board.projects[0].agentModel = { provider: "codex", model: "gpt-6-luna", modeId: "auto" }; });
  await x.automation.queue("a");
  await x.automation.kick();
  return x;
}

test("Full access on: the automation session runs without approvals although the project default asks for them", async () => {
  const x = await start(true);
  expect(x.created.map((c) => c.modeId)).toEqual(["full-access"]);
});

test("Full access off: the project default's Permissions apply", async () => {
  const x = await start(false);
  expect(x.created.map((c) => c.modeId)).toEqual(["auto"]);
});
