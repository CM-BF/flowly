import { expect, test } from "vitest";
import type { AutomationJob } from "../shared/automation";
import { automationSignal } from "./automation-view";
import { setLocale } from "../shared/i18n";

const job = (state: AutomationJob["state"]): AutomationJob => ({
  taskId: "a", projectId: "p", state, role: "implementer", generation: 1, nudges: 0, failures: 0, reviewRounds: 0, queuedAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
});

test("the queue chip says what a queued card waits for (CARD-TREE-SPEC §2.5)", () => {
  setLocale("en");
  const todo = { status: "todo" as const };
  expect(automationSignal(job("queued"), todo)?.text).toBe("Queued for agent");
  expect(automationSignal(job("queued"), todo, { open: 0, held: false })?.text).toBe("Queued for agent");
  expect(automationSignal(job("queued"), todo, { open: 2, held: false })).toMatchObject({ text: "Queued after blockers", icon: "Hourglass" });
  // Held: the card's own Held signal says it, so no chip.
  expect(automationSignal(job("queued"), todo, { open: 1, held: true })).toBeNull();
  // Blockers only change the queued chip.
  expect(automationSignal(job("working"), todo, { open: 1, held: false })?.text).toBe("Agent working");
});
