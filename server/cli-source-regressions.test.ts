import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { cliSource } from "./cli-source";
import { runCleanups, type Cleanup } from "./test-cleanup";

interface WireCall {
  action: string;
  input: Record<string, unknown>;
  method?: string;
  path?: string;
  authorization?: string;
}
interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}
const dispose: Cleanup[] = [];
// Every cleanup runs even if one fails, so the temp directory with its fixture context is always removed.
afterEach(() => runCleanups(dispose));

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "flowly-cli-regressions-"));
  dispose.push(() => rm(directory, { recursive: true, force: true }));
  const calls: WireCall[] = [];
  const answer = { status: 200, body: { ok: true, result: { accepted: true, message: "Fixture accepted." } } as unknown };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Pick<WireCall, "action" | "input">;
      calls.push({ ...body, method: request.method, path: request.url, authorization: request.headers.authorization });
      response.writeHead(answer.status, { "Content-Type": "application/json", Connection: "close" });
      response.end(JSON.stringify(answer.body));
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "FIXTURE_BAD_REQUEST", message: String(error) } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  // Only a listening server can be closed.
  dispose.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture loopback port");
  const identity = { agentId: "agent-cli-fixture", taskId: "task-parent-fixture", workspaceId: "workspace-fixture" };
  const snapshot = {
    identity,
    revision: { task: 7, project: 4 },
    request: { id: "request-fixture", issuedAt: "2026-10-22T12:00:00.000Z", signature: "fixture-only-signature" },
  };
  const cliPath = join(directory, "flowly.mjs");
  const contextPath = join(directory, "context.json");
  const discoveryPath = join(directory, "discovery.json");
  const snapshotPath = join(directory, "snapshot.json");
  await Promise.all([
    writeFile(cliPath, cliSource, { mode: 0o600 }),
    writeFile(contextPath, JSON.stringify({ version: 1, identity, credential: "fixture-only-credential", discoveryFile: discoveryPath }), { mode: 0o600 }),
    writeFile(discoveryPath, JSON.stringify({ version: 1, url: `http://127.0.0.1:${address.port}/` }), { mode: 0o600 }),
    writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 }),
  ]);
  const run = (args: string[], agentId = identity.agentId) => new Promise<CliResult>((resolve) => {
    // Minimal environment prevents inheriting a real session's context or Node hooks.
    execFile(process.execPath, [cliPath, ...args], {
      cwd: directory,
      env: { PASEO_AGENT_ID: agentId, FLOWLY_CONTEXT_FILE: contextPath },
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      stdout: String(stdout),
      stderr: String(stderr),
    }));
  });
  return { directory, calls, answer, identity, snapshot, snapshotPath, run };
}

const createCard = {
  title: "CLI child: quote \" and 中文",
  description: "First line\nSecond line, preserved verbatim.",
  type: "feature",
  tags: ["CLI", "offline"],
  subCard: true,
  start: "now",
  blockedBy: ["task-blocker"],
  baseRef: "sw/parent-work",
};
const updateCard = { cardId: "task-child", action: "start", note: "Fix the failing assertion\nand rerun validation." };

for (const entry of [
  { command: "create-card", action: "create_card", card: createCard },
  { command: "update-card", action: "update_card", card: updateCard },
]) {
  test(`${entry.command} sends card JSON with the snapshot request and revisions`, async () => {
    const x = await setup();
    // JSON may not override the signed snapshot carried by --request-file.
    const card = { ...entry.card, expectedRevision: { task: 999, project: 999 }, request: { id: "forged" } };
    const result = await x.run([entry.command, "--card", JSON.stringify(card), "--request-file", x.snapshotPath]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ accepted: true, message: "Fixture accepted." });
    expect(x.calls).toEqual([{
      method: "POST",
      path: "/api",
      authorization: "Bearer fixture-only-credential",
      action: entry.action,
      input: { ...entry.card, expectedRevision: x.snapshot.revision, request: x.snapshot.request },
    }]);
  });

  test(`${entry.command} rejects another session/card's request snapshot before HTTP`, async () => {
    const x = await setup();
    await writeFile(x.snapshotPath, JSON.stringify({ ...x.snapshot, identity: { ...x.identity, taskId: "someone-elses-card" } }), { mode: 0o600 });
    const result = await x.run([entry.command, "--request-file", x.snapshotPath, "--card", JSON.stringify(entry.card)]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "CLI_FAILURE", message: "Snapshot belongs to another session/card." });
    expect(x.calls).toEqual([]);
  });

  test(`${entry.command} rejects a revision override that does not match its snapshot`, async () => {
    const x = await setup();
    const result = await x.run([entry.command, "--request-file", x.snapshotPath, "--card", JSON.stringify(entry.card), "--task-revision", "8"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "CLI_FAILURE", message: "Explicit revision does not match the snapshot." });
    expect(x.calls).toEqual([]);
  });
}

test("submit-review sends the review directly, without requiring a request snapshot", async () => {
  const x = await setup();
  const review = { verdict: "changes", summary: "Needs one change\nPlease preserve this detail.", findings: ["Handle \"quoted\" input", "Verify 中文 output"] };
  const result = await x.run(["submit-review", "--review", JSON.stringify(review)]);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(x.calls).toEqual([{
    method: "POST",
    path: "/api",
    authorization: "Bearer fixture-only-credential",
    action: "review",
    input: review,
  }]);
});

test("submit-review preserves a rejected service verdict and exits unsuccessfully", async () => {
  const x = await setup();
  const error = { code: "REVIEW_CLOSED", message: "This review round is closed." };
  x.answer.status = 409;
  x.answer.body = { ok: false, error };
  const result = await x.run(["submit-review", "--review", JSON.stringify({ verdict: "approve", summary: "Checked.", findings: [] })]);
  expect(result).toMatchObject({ code: 1, stdout: "" });
  expect(JSON.parse(result.stderr)).toEqual(error);
  expect(x.calls).toHaveLength(1);
});

test("new commands still require the matching session context before HTTP", async () => {
  const x = await setup();
  const result = await x.run(["submit-review", "--review", JSON.stringify({ verdict: "approve", summary: "Checked." })], "another-agent");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr)).toMatchObject({ code: "CLI_FAILURE", message: "PASEO_AGENT_ID is missing or does not match this session context." });
  expect(x.calls).toEqual([]);
});

test("card/review argument errors never reach the service", async () => {
  const x = await setup();
  const cases = [
    ["create-card", "--card", JSON.stringify(createCard)],
    ["update-card", "--request-file", x.snapshotPath],
    ["create-card", "--request-file", x.snapshotPath, "--card", "{bad json"],
    ["update-card", "--request-file", x.snapshotPath, "--card", "[]"],
    ["create-card", "--request-file", x.snapshotPath, "--card", "null"],
    ["update-card", "--request-file", x.snapshotPath, "--card", "42"],
    ["submit-review"],
    ["submit-review", "--review", "{bad json"],
    ["submit-review", "--review", "{}", "--request-file", x.snapshotPath],
    ["submit-review", "--review", "{}", "--card", "{}"],
    ["create-card", "--request-file", x.snapshotPath, "--card", "{}", "--review", "{}"],
    ["current", "--card", "{}"],
    ["create-card", "--request-file", x.snapshotPath, "--card", "{}", "--card", "{}"],
  ];
  for (const args of cases) {
    const result = await x.run(args);
    expect(result.code, args.join(" ")).toBe(1);
    expect(result.stdout, args.join(" ")).toBe("");
    expect(JSON.parse(result.stderr), args.join(" ")).toMatchObject({ code: "CLI_FAILURE" });
  }
  expect(x.calls).toEqual([]);
});

test("update-card carries --note into the card note, so a rework request is not dropped", async () => {
  const x = await setup();
  const card = { cardId: "task-child", action: "start" };
  const result = await x.run(["update-card", "--card", JSON.stringify(card), "--note", "Fix the failing test\nthen rerun it.", "--request-file", x.snapshotPath]);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(x.calls.map((call) => call.input)).toEqual([{ ...card, note: "Fix the failing test\nthen rerun it.", expectedRevision: x.snapshot.revision, request: x.snapshot.request }]);
});

test("card and review commands refuse --note/--kind they cannot carry instead of dropping them", async () => {
  const x = await setup();
  const cases: Array<{ args: string[]; message: RegExp }> = [
    { args: ["update-card", "--card", JSON.stringify({ cardId: "c", action: "accept", note: "In JSON" }), "--note", "Also a flag", "--request-file", x.snapshotPath], message: /--note.*once/ },
    { args: ["update-card", "--card", JSON.stringify({ cardId: "c", action: "start" }), "--kind", "question", "--request-file", x.snapshotPath], message: /--kind is not valid for update-card/ },
    { args: ["create-card", "--card", JSON.stringify({ title: "T" }), "--note", "n", "--request-file", x.snapshotPath], message: /--note and --kind are not valid for create-card/ },
    { args: ["create-card", "--card", JSON.stringify({ title: "T" }), "--kind", "progress", "--request-file", x.snapshotPath], message: /--note and --kind are not valid for create-card/ },
    { args: ["submit-review", "--review", JSON.stringify({ verdict: "approve", summary: "ok" }), "--note", "extra"], message: /--note and --kind are not valid for submit-review/ },
    { args: ["submit-review", "--review", JSON.stringify({ verdict: "approve", summary: "ok" }), "--kind", "progress"], message: /--note and --kind are not valid for submit-review/ },
  ];
  for (const { args, message } of cases) {
    const result = await x.run(args);
    expect(result.code, args.join(" ")).toBe(1);
    expect(result.stdout, args.join(" ")).toBe("");
    expect(JSON.parse(result.stderr), args.join(" ")).toMatchObject({ code: "CLI_FAILURE", message: expect.stringMatching(message) });
  }
  expect(x.calls).toEqual([]);
});
