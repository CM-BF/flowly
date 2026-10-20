import { expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { modelId, sessionModel } from "./agent-model";

const api = (refresh: () => Promise<unknown>) => ({ agents: { ref: () => ({ refresh }) } }) as unknown as PaseoApi;

test("modelId joins provider and model, preferring what the session runs now", () => {
  expect(modelId({ provider: "codex", model: "gpt-6-luna" })).toBe("codex/gpt-6-luna");
  expect(modelId({ provider: "claude", model: "old", runtimeInfo: { model: "claude-sonnet-5" } })).toBe("claude/claude-sonnet-5");
  expect(modelId({ provider: "claude", runtimeInfo: { model: null } })).toBe("");
  expect(modelId({ model: "gpt-6-luna" })).toBe("");
});

test("sessionModel reads the refreshed snapshot, falling back to the hook's provider", async () => {
  expect(await sessionModel(api(async () => ({ agent: { provider: "codex", runtimeInfo: { model: "gpt-6-astra" } } })), { id: "a", provider: "codex" })).toBe("codex/gpt-6-astra");
  expect(await sessionModel(api(async () => ({ agent: { runtimeInfo: { model: "gpt-6-astra" } } })), { id: "a", provider: "codex" })).toBe("codex/gpt-6-astra");
});

test("sessionModel gives an empty model on failure, a missing snapshot or a slow answer, and never throws", async () => {
  expect(await sessionModel(api(async () => Promise.reject(new Error("gone"))), { id: "a", provider: "codex" })).toBe("");
  expect(await sessionModel(api(async () => null), { id: "a", provider: "codex" })).toBe("");
  const started = Date.now();
  expect(await sessionModel(api(() => new Promise(() => undefined)), { id: "a", provider: "codex" }, 30)).toBe("");
  expect(Date.now() - started).toBeLessThan(500);
});
