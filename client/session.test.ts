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

test("archived sessions accept a restoring send but not live-only writes", async () => {
  const { workspaceSession } = await import("./session");
  const paseo = {
    agents: { ref: () => ({ refresh: async () => ({ agent: { id: "a", workspaceId: "w", archivedAt: "2026-10-15T00:00:00Z" } }) }) },
  } as never;
  await expect(workspaceSession(paseo, "a", "w", true)).rejects.toThrow(/archived/);
  await expect(workspaceSession(paseo, "a", "w", "restore")).resolves.toMatchObject({ id: "a" });
  await expect(workspaceSession(paseo, "a", "other", "restore")).rejects.toThrow(/different workspace/);
});

test("the original instruction is durably captured before send; capture failure cannot wake the agent", async () => {
  const order: string[] = [], text = "  原文\n", send = vi.fn(async () => { order.push("send"); });
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { id: "a", workspaceId: "w", status: "idle" } }), send }) } } as unknown as PaseoApi;
  const scope = async () => ({ available: true, reason: "", context: "card" });
  const record = vi.fn(async () => { order.push("record"); throw new Error("disk full"); });
  await expect(sendCardInstruction(paseo, { id: "t", workspaceId: "w" }, "a", scope, text, "steer", [], "stable", { record })).rejects.toThrow("disk full");
  expect(send).not.toHaveBeenCalled();
  record.mockImplementationOnce(async () => { order.push("record"); return undefined as never; });
  await sendCardInstruction(paseo, { id: "t", workspaceId: "w" }, "a", scope, text, "steer", [], "stable", { record });
  expect(order).toEqual(["record", "record", "send"]);
  expect(record).toHaveBeenLastCalledWith({ taskId: "t", workspaceId: "w", agentId: "a", messageId: "stable", text, via: "session" });
  expect(send).toHaveBeenCalledWith(text, { messageId: "stable" });
});

test("managed follow-ups use the daemon's serialized send instead of a client send after authorization", async () => {
  const send = vi.fn(), forward = vi.fn(), record = vi.fn();
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { id: "a", workspaceId: "w", status: "idle" } }), send }) } } as unknown as PaseoApi;
  await sendCardInstruction(paseo, { id: "t", workspaceId: "w" }, "a", async () => ({ available: true, reason: "", context: "card" }), "  exact\n", "steer", [], "same-id", { send: forward, record });
  expect(send).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
  expect(forward).toHaveBeenCalledWith({ taskId: "t", workspaceId: "w", agentId: "a", text: "  exact\n", messageId: "same-id", mode: "steer", via: "session" });
});

test("a no-image launch shares the same stable identity in its saved original and native first message", async () => {
  const { launchKanbanSession } = await import("./session");
  const create = vi.fn(async (_options: unknown) => ({ id: "allocated" }));
  const paseo = { agents: { ref: () => ({ refresh: async () => null }) }, workspaces: { ref: () => ({ agents: { create } }) } } as unknown as PaseoApi;
  const prepare = vi.fn(async (_input: Parameters<Parameters<typeof launchKanbanSession>[0]["prepare"]>[0]) => ({ agentId: "allocated", instructions: "card", contextFile: "ctx", cliPath: "cli", skillPath: "skill", mcp: { type: "http" as const, url: "http://fixture", headers: {} } }));
  await launchKanbanSession({ paseo, prepare, contextRead: async () => ({ available: true, reason: "", context: "card" }) }, { id: "t", workspaceId: "w", title: "card" }, { provider: "codex", model: "gpt-6-luna", mode: "full-access", prompt: "  first\n", operationId: "launch-one" });
  const saved = prepare.mock.calls[0][0] as unknown as { launch: { messageId: string; text: string } };
  expect(create.mock.calls[0][0]).toMatchObject({ prompt: saved.launch.text, clientMessageId: saved.launch.messageId });
});
