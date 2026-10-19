import { afterEach, expect, test } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, request } from "node:http";
import { ToolServer } from "./tool-server";
import { agentFixture } from "./agent-fixture";
import { skillText } from "./skill-source";

const run = promisify(execFile),
  cleanups: (() => Promise<unknown>)[] = [];
async function setup() {
  const fixture = await agentFixture(),
    server = new ToolServer(fixture.store);
  cleanups.push(async () => {
    await server.stop();
    await rm(fixture.root, { recursive: true, force: true });
  });
  await server.start();
  const { url } = JSON.parse(
    await readFile(fixture.store.directory + "/tool-endpoint.json", "utf8"),
  );
  const authorization = "Bearer " + server.secrets.credential(fixture.identity);
  const api = async (action: string, input: unknown = {}) => {
    const response = await fetch(url + "api", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, input }),
    });
    return { status: response.status, ...(await response.json()) };
  };
  return { ...fixture, server, url, authorization, api };
}
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});
test("MCP initialize/list can precede actor creation; live calls require SDK context", async () => {
  const x = await setup();
  const mcp = async (method: string, params: unknown, id = 1) => {
    const response = await fetch(x.url + "mcp", {
      method: "POST",
      headers: {
        Authorization: x.authorization,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    return JSON.parse(
      response.headers.get("content-type")?.includes("text/event-stream")
        ? body
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .at(-1)!
        : body,
    );
  };
  expect(
    (
      await mcp("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      })
    ).result.protocolVersion,
  ).toBe("2025-06-18");
  expect(
    (await mcp("tools/list", {})).result.tools.map(
      (t: { name: string }) => t.name,
    ),
  ).toEqual([
    "kanban_get_task",
    "kanban_update_status",
    "kanban_report_progress",
    "kanban_propose_idea",
    "kanban_add_artifact",
    "kanban_remove_artifact",
    "kanban_set_tags",
    "kanban_set_type",
    "kanban_suggest_next_moves",
    "kanban_update_workpad",
  ]);
  // The soft delivery gate and the workpad's own revision are part of the tool schemas (WORKPAD-SPEC §3, §5.3).
  const listed = (await mcp("tools/list", {})).result.tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[];
  expect(listed.find((t) => t.name === "kanban_update_status")!.inputSchema.properties).toHaveProperty("acknowledgeOpen");
  expect(Object.keys(listed.find((t) => t.name === "kanban_update_workpad")!.inputSchema.properties)).toEqual(
    expect.arrayContaining(["workpadRevision", "acceptance", "validation", "confusions"]),
  );
  const cold = await mcp("tools/call", {
    name: "kanban_get_task",
    arguments: {},
  });
  expect(cold.result.isError).toBe(true);
  expect(JSON.parse(cold.result.content[0].text).code).toBe(
    "PASEO_UNAVAILABLE",
  );
  x.server.attach(x.paseo);
  const read = await mcp("tools/call", {
    name: "kanban_get_task",
    arguments: {},
  });
  expect(read.result.structuredContent.identity).toEqual(x.identity);
  const ctx = read.result.structuredContent;
  const updated = await mcp("tools/call", {
    name: "kanban_update_status",
    arguments: {
      expectedRevision: ctx.revision,
      request: ctx.request,
      status: "development",
      note: "MCP actual call",
    },
  });
  expect(updated.result.structuredContent.receipt.status).toBe("development");
  const proposed = await mcp("tools/call", {
    name: "kanban_propose_idea",
    arguments: {
      expectedRevision: updated.result.structuredContent.current.revision,
      request: updated.result.structuredContent.current.request,
      title: "Follow-up",
      detail: "Do the next thing.",
      rationale: "Found while working.",
    },
  });
  expect(proposed.result.structuredContent.receipt.action).toBe("idea");
  expect(proposed.result.structuredContent.current.ideas).toEqual([
    { id: proposed.result.structuredContent.ideaId, title: "Follow-up", status: "open", scope: "new" },
  ]);
});
test("loopback host/origin/credential guards and scoped request validation", async () => {
  const x = await setup();
  x.server.attach(x.paseo);
  const rejectedHeaders: Record<string, string>[] = [
    { Host: "evil.example" },
    { Origin: "https://evil.example" },
    { Authorization: "Bearer invalid" },
  ];
  for (const extra of rejectedHeaders) {
    // Node fetch normalizes Host back to the URL. Use raw HTTP to test rebinding.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        x.url + "api",
        {
          method: "POST",
          headers: {
            Authorization: x.authorization,
            ...extra,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ action: "get", input: {} }));
    });
    expect(status, JSON.stringify(extra)).toBeGreaterThanOrEqual(400);
  }
  const ctx = (await x.api("get")).result;
  expect(
    (
      await x.api("progress", {
        expectedRevision: ctx.revision,
        request: ctx.request,
        note: "x",
        taskId: "other",
      })
    ).error.code,
  ).toBe("INVALID_INPUT");
  expect(
    (
      await x.api("status", {
        expectedRevision: ctx.revision,
        request: ctx.request,
        note: "x",
        status: "done",
      })
    ).error.code,
  ).toBe("INVALID_STATUS");
  const oversized = await fetch(x.url + "api", {
    method: "POST",
    headers: { Authorization: x.authorization },
    body: "x".repeat(70000),
  });
  expect(oversized.status).toBeGreaterThanOrEqual(400);
});
test("prepared ID and scoped files are stable, selected existing actor verified", async () => {
  const x = await setup();
  const [a, b] = await Promise.all([
    x.server.prepareSession("t", "operation", x.paseo),
    x.server.prepareSession("t", "operation", x.paseo),
  ]);
  expect(a.agentId).toBe(b.agentId);
  expect(a.mcp.url).toBe(x.url + "mcp");
  await expect(
    x.server.prepareExisting("t", "wrong", x.paseo),
  ).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
  const existing = await x.server.prepareExisting("t", "actor", x.paseo);
  expect(existing.agentId).toBe("actor");
  expect(existing.instructions).toContain("kanban_get_task");
  expect(await readFile(existing.skillPath, "utf8")).toBe(skillText);
  expect(await readFile("skills/paseo-ultra-kanban/SKILL.md", "utf8")).toBe(
    skillText,
  );
  expect((await x.server.accessState("t", "actor", x.paseo)).methods).toContain(
    "cli",
  );
  expect(
    (await x.server.accessState("t", "actor", x.paseo)).lastSuccessAt,
  ).toBeNull();
});
test("CLI runs a complete scoped flow; replay, wrong env, snapshots and flags", async () => {
  const x = await setup(),
    prepared = await x.server.prepareExisting("t", "actor", x.paseo),
    snapshot = x.root + "/snapshot.json";
  const cli = async (...args: string[]) => {
    const result = await run(
      process.execPath,
      [prepared.cliPath, "--context-file", prepared.contextFile, ...args],
      { env: { ...process.env, PASEO_AGENT_ID: "actor" } },
    );
    expect(result.stdout.endsWith("\n")).toBe(true);
    return JSON.parse(result.stdout);
  };
  const current = await cli("current", "--save-request", snapshot);
  expect(current.identity).toEqual(x.identity);
  const started = await cli(
    "status",
    "development",
    "--request-file",
    snapshot,
    "--note",
    "CLI starts",
  );
  const replay = await cli(
    "status",
    "development",
    "--request-file",
    snapshot,
    "--note",
    "CLI starts",
  );
  expect(replay).toMatchObject({ receipt: started.receipt, replayed: true });
  await cli("current", "--save-request", snapshot);
  await cli(
    "note",
    "--request-file",
    snapshot,
    "--kind",
    "result",
    "--note",
    "CLI contribution",
  );
  await cli("current", "--save-request", snapshot);
  const finished = await cli(
    "status",
    "in_review",
    "--request-file",
    snapshot,
    "--note",
    "Ready for human review",
  );
  expect(finished.receipt.status).toBe("in_review");
  await cli("current", "--save-request", snapshot);
  const tagged = await cli("tags", "--request-file", snapshot, "--add", "Drawer, perf");
  expect(tagged.current.task.tags.map((t: { tag: string }) => t.tag)).toEqual(["drawer", "perf"]);
  await cli("current", "--save-request", snapshot);
  const untagged = await cli("tags", "--request-file", snapshot, "--remove", "perf");
  expect(untagged.current.task.tags.map((t: { tag: string }) => t.tag)).toEqual(["drawer"]);
  await cli("current", "--save-request", snapshot);
  const suggested = await cli("next-moves", "--request-file", snapshot, "--moves", JSON.stringify([{ label: "Commit", prompt: "Commit and push." }]));
  expect(suggested.receipt.action).toBe("next_moves");
  expect(suggested.current.activity.at(-1)).toMatchObject({ action: "next_moves_suggested", moves: [{ label: "Commit", prompt: "Commit and push." }] });
  await cli("current", "--save-request", snapshot);
  const proposed = await cli(
    "idea",
    "--request-file",
    snapshot,
    "--title",
    "CLI idea",
    "--detail",
    "Do it.",
    "--rationale",
    "Seen while testing.",
    "--type",
    "chore",
    "--scope",
    "here",
  );
  expect(proposed.current.ideas).toEqual([{ id: proposed.ideaId, title: "CLI idea", status: "open", scope: "here" }]);
  for (const args of [
    ["idea", "--request-file", snapshot, "--title", "No detail", "--rationale", "r"],
    ["note", "--request-file", snapshot, "--note", "n", "--title", "misplaced"],
    ["next-moves", "--request-file", snapshot, "--moves", "not json"],
    ["note", "--request-file", snapshot, "--note", "n", "--moves", "[]"],
    ["current", "--unknown", "x"],
    [
      "current",
      "--context-file",
      prepared.contextFile,
      "--context-file",
      prepared.contextFile,
    ],
    ["status", "done", "--request-file", snapshot, "--note", "unauthorized"],
    ["note", "--request-file", snapshot, "--note", " "],
  ]) {
    await expect(cli(...args)).rejects.toMatchObject({ code: 1 });
  }
  await expect(
    run(
      process.execPath,
      [prepared.cliPath, "--context-file", prepared.contextFile, "current"],
      { env: { ...process.env, PASEO_AGENT_ID: "different" } },
    ),
  ).rejects.toMatchObject({ code: 1 });
  await writeFile(
    snapshot,
    JSON.stringify({
      ...current,
      identity: { ...x.identity, taskId: "wrong" },
    }),
  );
  await expect(
    cli("note", "--request-file", snapshot, "--note", "wrong"),
  ).rejects.toMatchObject({ code: 1 });
});
test("same port and credentials survive cleanup/reload; cold error recovers with SDK callback", async () => {
  const x = await setup();
  x.server.attach(x.paseo);
  const ctx = (await x.api("get")).result,
    input = {
      expectedRevision: ctx.revision,
      request: ctx.request,
      note: "persisted",
    };
  const first = (await x.api("progress", input)).result;
  await x.server.stop();
  const restored = new ToolServer(x.store);
  cleanups.push(() => restored.stop());
  await restored.start();
  expect(
    JSON.parse(
      await readFile(x.store.directory + "/tool-endpoint.json", "utf8"),
    ).url,
  ).toBe(x.url);
  expect((await x.api("get")).error.code).toBe("PASEO_UNAVAILABLE");
  restored.attach(x.paseo);
  const replay = (await x.api("progress", input)).result;
  expect(replay).toMatchObject({ receipt: first.receipt, replayed: true });
});
test("port collision preserves discovery/key/board; after conflict removal listener recovers", async () => {
  const x = await setup(),
    before = await readFile(x.store.path, "utf8"),
    endpoint = await readFile(
      x.store.directory + "/tool-endpoint.json",
      "utf8",
    );
  const { port } = JSON.parse(endpoint);
  await x.server.stop();
  const blocker = createServer();
  await new Promise<void>((resolve) =>
    blocker.listen(port, "127.0.0.1", resolve),
  );
  cleanups.push(
    () => new Promise<void>((resolve) => blocker.close(() => resolve())),
  );
  const restored = new ToolServer(x.store);
  cleanups.push(() => restored.stop());
  await expect(restored.start()).rejects.toMatchObject({
    code: "TOOLS_UNAVAILABLE",
  });
  expect(restored.health().listening).toBe(false);
  expect(await readFile(x.store.path, "utf8")).toBe(before);
  expect(
    await readFile(x.store.directory + "/tool-endpoint.json", "utf8"),
  ).toBe(endpoint);
  await x.store.editTask({
    id: "t",
    revision: 1,
    title: "Human board still works",
    actor: "human",
  });
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  await restored.start();
  expect(restored.health().listening).toBe(true);
});
test("session_open injection is limited to Kanban-managed sessions", async () => {
  const x = await setup();
  // A session in the card workspace that the plugin never prepared gets nothing.
  expect(await x.server.sessionContext("unmanaged-agent", x.identity.workspaceId, x.paseo)).toBeNull();
  expect(await x.server.secrets.hasContext("unmanaged-agent")).toBe(false);
  expect(await x.server.secrets.hasContext("../escape")).toBe(false);
  // Once prepared (card launch or explicit opt-in), reopening refreshes its context.
  await x.server.secrets.writeContext(x.identity, "mcp");
  const path = await x.server.sessionContext(x.identity.agentId, x.identity.workspaceId, x.paseo);
  expect(path).toBe(x.server.secrets.contextFile(x.identity.agentId));
  expect(JSON.parse(await readFile(path!, "utf8")).methods).toEqual(["mcp", "cli"]);
});
