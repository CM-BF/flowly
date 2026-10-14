import { expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { sendCardInstruction } from "../../../../client/session";

test("sends multiline follow-up byte-for-byte after fresh actor and scope authorization", async () => {
  const order: string[] = [];
  const instruction = "Continue with the requested change.\n\nKeep this second paragraph verbatim.\tNo generated preamble.";
  const send = vi.fn(async (text: string) => { order.push(`send:${text}`); });
  const refresh = vi.fn(async () => {
    order.push("actor-refresh");
    return { agent: { id: "agent-fixture", workspaceId: "workspace-fixture", status: "running" } };
  });
  const paseo = { agents: { ref: () => ({ refresh, send }) } } as unknown as PaseoApi;
  const contextRead = vi.fn(async ({ id }: { id: string }) => {
    order.push(`scope-read:${id}`);
    return { available: true, reason: "", context: "Scope context must authorize only." };
  });

  await sendCardInstruction(paseo, { id: "task-fixture", workspaceId: "workspace-fixture" }, "agent-fixture", contextRead, instruction, "interrupt");

  expect(refresh).toHaveBeenCalledTimes(1);
  expect(contextRead).toHaveBeenCalledWith({ id: "task-fixture" });
  expect(send.mock.calls).toEqual([[instruction, { activeTurnBehavior: "interrupt" }]]);
  expect(send.mock.calls[0][0]).toBe(instruction);
  expect(order).toContain("actor-refresh");
  expect(order).toContain("scope-read:task-fixture");
  expect(order.at(-1)).toBe(`send:${instruction}`);
  expect(send.mock.calls[0][0]).not.toContain("Current scope");
  expect(send.mock.calls[0][0]).not.toContain("User follow-up instruction:");
});
