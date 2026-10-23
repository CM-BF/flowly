import { expect, test } from "vitest";
import { limitNotice, modelLimited, providerCooling, providerLimited, type AutomationJob } from "./automation";
import type { Project } from "./model";

// AUTOMATION-SPEC §4.5: what counts as a provider limit, and when a role starts on its fallback.

test("Claude's rejected-quota notices and HTTP 429 wording count as provider limits; warnings and prose do not", () => {
  for (const message of [
    "You've hit your session limit · resets 2pm (America/Los_Angeles)",
    "You've reached your Opus weekly limit.",
    "You're out of extra usage",
    "429 Too Many Requests",
    "rate_limit_error: Number of request tokens has exceeded your per-minute rate limit",
  ])
    expect(providerLimited(message), message).toBe(true);
  for (const message of ["You're close to your session limit", "The parser crashed", "I limited the rate of retries in the loop"])
    expect(providerLimited(message), message).toBe(false);
});

test("a completed turn's limit notice is read from its last rows only", () => {
  const user = { type: "user_message", text: "Go on" };
  expect(limitNotice([user, { type: "assistant_message", text: "You've hit your session limit · resets 2pm (America/Los_Angeles)" }])).toMatch(/session limit/);
  expect(limitNotice([user, { type: "assistant_message", text: "API Error: 429 rate_limit_error" }])).toMatch(/429/);
  expect(limitNotice([user, { type: "error", message: "Request failed: 429 Too Many Requests" }])).toMatch(/429/);
  // An older turn's notice, an ordinary answer, a quoted notice, or tool work after it are no evidence.
  expect(limitNotice([{ type: "assistant_message", text: "You've hit your session limit." }, user, { type: "assistant_message", text: "Done." }])).toBeNull();
  expect(limitNotice([user, { type: "assistant_message", text: "You've hit your session limit, so I stopped early; I will continue." }])).toBeNull();
  expect(limitNotice([user, { type: "assistant_message", text: "You've hit your session limit." }, { type: "tool_call", name: "bash" }])).toBeNull();
  expect(limitNotice([])).toBeNull();
});

const now = Date.parse("2026-10-23T10:00:00Z");
const job = (extra: Partial<AutomationJob>): AutomationJob => ({
  taskId: "x", projectId: "p", state: "retry_wait", role: "implementer", generation: 1, nudges: 0, failures: 0, reviewRounds: 0,
  queuedAt: "2026-10-23T09:00:00Z", updatedAt: "2026-10-23T09:00:00Z", ...extra,
});

test("a recorded limit steers that model, or its provider when the model was not known, until it expires", () => {
  const until = new Date(now + 60_000).toISOString();
  const board = { automation: [job({ providerLimit: { provider: "claude", model: "claude/claude-opus-5-5", until } })] };
  expect(modelLimited(board, { provider: "claude", model: "claude-opus-5-5" }, now)).toBe(true);
  expect(modelLimited(board, { provider: "claude", model: "claude-sonnet-5-5" }, now)).toBe(false);
  expect(modelLimited(board, { provider: "claude", model: "claude-opus-5-5" }, now + 120_000)).toBe(false);
  expect(modelLimited({ automation: [job({ providerLimit: { provider: "claude", until } })] }, { provider: "claude", model: "claude-sonnet-5-5" }, now)).toBe(true);
});

test("a cooling provider holds back new cards only when the role has no fallback on another, uncooled provider", () => {
  const cooling = job({ taskId: "other", code: "cooldown", provider: "claude", retryAt: new Date(now + 600_000).toISOString() });
  const project = (automation: Partial<NonNullable<Project["automation"]>>) =>
    ({ id: "p", automation: { enabled: true, maxRunning: 2, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2, implementer: { provider: "claude", model: "claude-opus-5-5" }, ...automation } }) as Project;
  const board = { automation: [cooling], projects: [] };
  expect(providerCooling(board, project({}), now)).toBe(true);
  expect(providerCooling(board, project({ implementerFallback: { provider: "codex", model: "gpt-6.1-sol" } }), now)).toBe(false);
  expect(providerCooling(board, project({ implementerFallback: { provider: "claude", model: "claude-sonnet-5-5" } }), now)).toBe(true);
});
