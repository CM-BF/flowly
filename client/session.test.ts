import { expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import {
  createPreparedSession,
  sendCardInstruction,
  workspaceSession,
} from "./session";
function fixture() {
  let found: unknown = null;
  const create = vi.fn(async () => ({ id: "allocated" }));
  const refresh = vi.fn(async () => found);
  const paseo = {
    agents: { ref: () => ({ refresh }) },
    workspaces: { ref: () => ({ agents: { create } }) },
  } as unknown as PaseoApi;
  return {
    paseo,
    create,
    refresh,
    found: (value: unknown) => {
      found = value;
    },
  };
}
const options = {
  agentId: "allocated",
  config: { provider: "codex/gpt-6-luna", modeId: "full-access" },
  prompt: "Start",
};
test("uncertain creation response reuses actual session without replaying first prompt", async () => {
  const x = fixture();
  x.create.mockImplementationOnce(async () => {
    x.found({ agent: { id: "allocated", workspaceId: "w" } });
    throw new Error("lost response");
  });
  expect(await createPreparedSession(x.paseo, "w", options)).toEqual({
    id: "allocated",
    recovered: true,
  });
  expect(await createPreparedSession(x.paseo, "w", options)).toEqual({
    id: "allocated",
    recovered: true,
  });
  expect(x.create).toHaveBeenCalledTimes(1);
});
test("creation failure stays a failure; wrong workspace/archived ID and uncertain lookup block provision", async () => {
  const x = fixture();
  x.create.mockRejectedValue(new Error("provider unavailable"));
  await expect(createPreparedSession(x.paseo, "w", options)).rejects.toThrow(
    "provider unavailable",
  );
  for (const agent of [
    { id: "allocated", workspaceId: "other" },
    { id: "allocated", workspaceId: "w", archivedAt: "now" },
  ]) {
    x.found({ agent });
    await expect(createPreparedSession(x.paseo, "w", options)).rejects.toThrow(
      "Prepared session",
    );
  }
  x.found(null);
  x.refresh.mockRejectedValue(new Error("cannot confirm"));
  await expect(createPreparedSession(x.paseo, "w", options)).rejects.toThrow(
    "cannot confirm",
  );
  expect(x.create).toHaveBeenCalledTimes(1);
});

test("follow-up verifies workspace/scope and uses the freshly read execution state", async () => {
  const send = vi.fn(),
    refresh = vi.fn(async () => ({
      agent: { id: "a", workspaceId: "w", status: "running" },
    }));
  const paseo = {
    agents: { ref: () => ({ refresh, send }) },
  } as unknown as PaseoApi;
  const contextRead = vi.fn(async () => ({
    available: true,
    reason: "",
    context: "Current scope",
  }));
  await sendCardInstruction(
    paseo,
    { id: "t", workspaceId: "w" },
    "a",
    contextRead,
    "Continue",
    "interrupt",
  );
  expect(send).toHaveBeenCalledWith(
    "Continue",
    { activeTurnBehavior: "interrupt" },
  );
  refresh.mockResolvedValueOnce({
    agent: { id: "a", workspaceId: "other", status: "running" },
  });
  await expect(
    sendCardInstruction(
      paseo,
      { id: "t", workspaceId: "w" },
      "a",
      contextRead,
      "Wrong",
      "steer",
    ),
  ).rejects.toThrow("different workspace");
  contextRead.mockResolvedValueOnce({
    available: false,
    reason: "Task archived",
    context: "",
  });
  await expect(
    sendCardInstruction(
      paseo,
      { id: "t", workspaceId: "w" },
      "a",
      contextRead,
      "Wrong",
      "steer",
    ),
  ).rejects.toThrow("Task archived");
  expect(send).toHaveBeenCalledTimes(1);
  await expect(
    workspaceSession(
      {
        agents: {
          ref: () => ({
            refresh: async () => ({
              agent: { workspaceId: "w", archivedAt: "now" },
            }),
          }),
        },
      } as unknown as PaseoApi,
      "a",
      "w",
      true,
    ),
  ).rejects.toThrow("archived");
});
