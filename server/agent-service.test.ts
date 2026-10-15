import { afterEach, expect, test } from "vitest";
import { readFile, rm, writeFile, stat } from "node:fs/promises";
import { AgentService } from "./agent-service";
import { BoardStore } from "./store";
import { ToolSecrets, digest } from "./tool-context";
import { toolFailure } from "./tool-error";
import { agentFixture } from "./agent-fixture";

const roots: string[] = [];
async function setup() {
  const f = await agentFixture();
  roots.push(f.root);
  return f;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const input = (
  ctx: Awaited<ReturnType<AgentService["get"]>>,
  note = "checkpoint",
) => ({ expectedRevision: ctx.revision, request: ctx.request, note });

test("reads live scope and foreign native owner; read telemetry does not write board", async () => {
  const x = await setup(),
    before = await readFile(x.store.path, "utf8"),
    ctx = await x.service.get(x.identity);
  expect(ctx.scope.repoPaths).toEqual([x.a, x.b]);
  expect(ctx.workspace.nativeOwner).toBe("Foreign owner");
  expect(ctx.sessions.entries).toHaveLength(2);
  expect(await readFile(x.store.path, "utf8")).toBe(before);
  await x.store.editTask({
    id: "t",
    revision: 1,
    title: "Human title edit",
    actor: "human",
  });
  expect((await x.service.get(x.identity)).scope.directories).toEqual([
    { repo: x.a, directory: x.a },
    { repo: x.b, directory: x.b },
  ]);
});
test("two concurrent state changes have one winner; stale report cannot overwrite human edits", async () => {
  const x = await setup(),
    other = { ...x.identity, agentId: "second" };
  const [a, b] = await Promise.all([
    x.service.get(x.identity),
    x.service.get(other),
  ]);
  const results = await Promise.allSettled([
    x.service.write(x.identity, "status", {
      ...input(a),
      status: "in_progress",
    }),
    x.service.write(other, "status", { ...input(b), status: "blocked" }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(
    toolFailure(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason,
    ).code,
  ).toBe("REVISION_CONFLICT");
  const c = await x.service.get(x.identity);
  await x.store.editTask({
    id: "t",
    revision: c.revision.task,
    priority: "high",
    actor: "human",
  });
  await expect(
    x.service.write(x.identity, "progress", input(c)),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
});
test("concurrent progress and same-state reports preserve every task field", async () => {
  const x = await setup(),
    other = { ...x.identity, agentId: "second" };
  const [a, b] = await Promise.all([
    x.service.get(x.identity),
    x.service.get(other),
  ]);
  const before = (await x.store.read()).tasks[0];
  await Promise.all([
    x.service.write(x.identity, "progress", input(a)),
    x.service.write(other, "progress", {
      ...input(b, "blocker"),
      kind: "blocker",
    }),
  ]);
  expect((await x.store.read()).tasks[0]).toEqual(before);
  const c = await x.service.get(x.identity);
  await x.store.editTask({
    id: "t",
    revision: 1,
    status: "in_progress",
    actor: "human",
  });
  const d = await x.service.get(x.identity),
    sameBefore = (await x.store.read()).tasks[0];
  await x.service.write(x.identity, "status", {
    ...input(d),
    status: "in_progress",
  });
  expect((await x.store.read()).tasks[0]).toEqual(sameBefore);
  expect(
    (await x.store.read()).events.filter((e) => e.reportKind === "blocker"),
  ).toHaveLength(1);
  await expect(
    x.service.write(x.identity, "progress", input(c)),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
});
test("exact replay survives reload, expiry, archive and human completion without another file write", async () => {
  const x = await setup(),
    ctx = await x.service.get(x.identity),
    request = { ...input(ctx), status: "in_review" };
  const first = await x.service.write(x.identity, "status", request);
  await x.store.editTask({
    id: "t",
    revision: 2,
    status: "done",
    archived: true,
    actor: "human",
  });
  x.advance(16 * 60 * 1000);
  const secrets = new ToolSecrets(x.store.directory);
  await secrets.initialize();
  const restored = new AgentService(new BoardStore(x.store.directory), secrets);
  restored.attach(x.paseo);
  const before = await readFile(x.store.path, "utf8"),
    beforeStat = await stat(x.store.path);
  const replay = await restored.write(x.identity, "status", request);
  expect(replay).toMatchObject({
    receipt: first.receipt,
    replayed: true,
    current: { task: { status: "done" }, writable: false },
  });
  expect(await readFile(x.store.path, "utf8")).toBe(before);
  expect((await stat(x.store.path)).mtimeMs).toBe(beforeStat.mtimeMs);
  await expect(
    restored.write(x.identity, "status", { ...request, note: "different" }),
  ).rejects.toMatchObject({ code: "REQUEST_REUSED" });
});
test("signed identity/revisions/time, status policy and unknown arguments are enforced", async () => {
  const x = await setup(),
    ctx = await x.service.get(x.identity);
  await expect(
    x.service.write(
      { ...x.identity, agentId: "second" },
      "progress",
      input(ctx),
    ),
  ).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
  await expect(
    x.service.write(x.identity, "progress", {
      ...input(ctx),
      expectedRevision: { task: 2, project: 1 },
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    x.service.write(x.identity, "progress", {
      ...input(ctx),
      request: { ...ctx.request, issuedAt: new Date(0).toISOString() },
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(
    x.service.write(x.identity, "progress", {
      ...input(ctx),
      taskId: "another",
    }),
  ).rejects.toThrow();
  for (const status of ["done", "cancelled", "todo", "backlog"])
    await expect(
      x.service.write(x.identity, "status", { ...input(ctx), status }),
    ).rejects.toThrow();
  x.advance(15 * 60 * 1000 + 1);
  await expect(
    x.service.write(x.identity, "progress", input(ctx)),
  ).rejects.toMatchObject({ code: "REQUEST_EXPIRED" });
  expect((await x.store.read()).agentReceipts).toHaveLength(0);
});
test("project metadata revision invalidates a legacy card snapshot", async () => {
  const x = await setup(),
    ctx = await x.service.get(x.identity);
  await x.store.mutate((b) => {
    b.projects[0].title = "Human project edit";
    b.projects[0].revision++;
  });
  await expect(
    x.service.write(x.identity, "progress", input(ctx)),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect((await x.service.get(x.identity)).scope.repoPaths).toEqual([x.a, x.b]);
});
test("wrong, missing, archived actors and missing/incompatible/archiving workspaces are rejected", async () => {
  const x = await setup();
  for (const agentId of ["wrong", "missing"])
    await expect(
      x.service.get({ ...x.identity, agentId }),
    ).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
  x.actors.actor.archivedAt = new Date().toISOString();
  await expect(x.service.get(x.identity)).rejects.toMatchObject({
    code: "SESSION_MISMATCH",
  });
  x.actors.actor.archivedAt = null;
  x.setWorkspace({ ...x.workspace(), workspaceDirectory: x.store.directory });
  await expect(x.service.get(x.identity)).rejects.toMatchObject({
    code: "WORKSPACE_INCOMPATIBLE",
  });
  x.setWorkspace(null);
  await expect(x.service.get(x.identity)).rejects.toMatchObject({
    code: "RESOURCE_UNAVAILABLE",
  });
  x.setWorkspace({
    id: "w",
    projectId: "foreign",
    projectDisplayName: "Foreign",
    workspaceDirectory: x.a,
    workspaceKind: "directory",
    status: "done",
    archivingAt: new Date().toISOString(),
  });
  await expect(x.service.get(x.identity)).rejects.toMatchObject({
    code: "RESOURCE_UNAVAILABLE",
  });
});
test("archive and human done/cancelled reject new writes, read stays explicit", async () => {
  const x = await setup();
  for (const status of ["done", "cancelled"] as const) {
    await x.store.mutate((b) => {
      b.tasks[0].status = status;
      b.tasks[0].revision++;
    });
    const ctx = await x.service.get(x.identity);
    expect(ctx.writable).toBe(false);
    await expect(
      x.service.write(x.identity, "progress", input(ctx)),
    ).rejects.toMatchObject({ code: "TASK_FINISHED" });
  }
  await x.store.mutate((b) => {
    b.tasks[0].status = "todo";
    b.projects[0].archivedAt = new Date().toISOString();
  });
  const ctx = await x.service.get(x.identity);
  await expect(
    x.service.write(x.identity, "progress", input(ctx)),
  ).rejects.toMatchObject({ code: "ARCHIVED" });
});
test("capacity refuses fresh writes, allows replay, prunes only expired receipts", async () => {
  const x = await setup(),
    ctx = await x.service.get(x.identity);
  const first = await x.service.write(x.identity, "progress", input(ctx));
  await x.store.mutate((b) => {
    const seed = b.agentReceipts[0];
    for (let i = 1; i < 5000; i++)
      b.agentReceipts.push({
        ...seed,
        key: "fixture-" + i,
        eventId: "fixture-" + i,
      });
  });
  const fresh = await x.service.get(x.identity);
  await expect(
    x.service.write(x.identity, "progress", input(fresh)),
  ).rejects.toMatchObject({ code: "RECEIPTS_FULL" });
  expect(
    (await x.service.write(x.identity, "progress", input(ctx))).receipt,
  ).toEqual(first.receipt);
  await x.store.mutate((b) => {
    b.agentReceipts[1].expiresAt = new Date(0).toISOString();
  });
  await x.service.write(x.identity, "progress", input(fresh));
  expect((await x.store.read()).agentReceipts).toHaveLength(5000);
});
test("storage errors have a code and preserve data; public board strips private receipts", async () => {
  const x = await setup(),
    ctx = await x.service.get(x.identity);
  await x.service.write(x.identity, "progress", input(ctx));
  expect("agentReceipts" in (await x.store.view())).toBe(false);
  expect(JSON.stringify(await x.store.read())).not.toContain(ctx.request.id);
  await writeFile(x.store.path, "{invalid");
  try {
    await x.service.get(x.identity);
    throw new Error("expected failure");
  } catch (error) {
    expect(toolFailure(error).code).toBe("STORE_INVALID");
  }
  expect(await readFile(x.store.path, "utf8")).toBe("{invalid");
});
test("session context signatures survive reload, reject rebinding and credential tampering", async () => {
  const x = await setup(),
    token = x.secrets.credential(x.identity),
    path = await x.secrets.writeContext(x.identity, "mcp");
  await x.secrets.writeContext(x.identity, "cli");
  expect(JSON.parse(await readFile(path, "utf8")).methods).toEqual([
    "mcp",
    "cli",
  ]);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const restored = new ToolSecrets(x.store.directory);
  await restored.initialize();
  expect(restored.authenticate(token)).toEqual(x.identity);
  expect(() => restored.authenticate(token.slice(0, -3) + "abc")).toThrow();
  expect(() => restored.authenticate(digest(token))).toThrow();
  await expect(
    restored.writeContext({ ...x.identity, taskId: "wrong" }),
  ).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
  await writeFile(x.store.directory + "/tool-key.json", "invalid");
  await expect(
    new ToolSecrets(x.store.directory).initialize(),
  ).rejects.toMatchObject({ code: "TOOLS_UNAVAILABLE" });
  expect(await readFile(x.store.directory + "/tool-key.json", "utf8")).toBe(
    "invalid",
  );
});
test("agents only see and use the project's enabled lanes", async () => {
  const x = await setup();
  const board = await x.store.read();
  const project = board.projects[0];
  await x.store.updateProject({
    id: project.id,
    revision: project.revision,
    lanes: (["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"] as const).map((status) => ({
      status,
      enabled: status !== "blocked",
      ...(status === "in_review" ? { name: "QA" } : {}),
    })),
  });
  const ctx = await x.service.get(x.identity);
  expect(ctx.allowedStatuses).toEqual(["in_progress", "in_review"]);
  expect(ctx.lanes.find((l) => l.status === "in_review")?.name).toBe("QA");
  expect(ctx.lanes.some((l) => l.status === "blocked")).toBe(false);
  await expect(
    x.service.write(x.identity, "status", { ...input(ctx), status: "blocked" }),
  ).rejects.toMatchObject({ code: "STATUS_UNAVAILABLE" });
  await x.service.write(x.identity, "status", { ...input(ctx), status: "in_review" });
  expect((await x.store.read()).tasks[0].status).toBe("in_review");
});
