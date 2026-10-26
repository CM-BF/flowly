import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionHistoryPage } from "../shared/session-history";
import { SessionHistory } from "./session-history";
import { forgetHistory } from "./provider-history";

// Claude Code run through the SDK (Paseo's entrypoint) writes what arrives during a turn only as an `attachment` record
// of type queued_command, and a task notice absorbed into a running turn only as queue-operation records; the routine
// attachments and bookkeeping records are host metadata (SESSION-HANDOFF-SPEC §8.1, §21.15). Synthetic records with the
// shapes of this machine's sdk-cli transcripts, the same ones the capture tests use.
const roots: string[] = [], readers: SessionHistory[] = [];
afterEach(async () => { await Promise.all(readers.splice(0).map((reader) => reader.stop())); forgetHistory(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const id = "c1a17565-6df7-4f20-b755-0000000000d5", cwd = "/tmp/plugin-test-history-claude";
const base = { sessionId: id, entrypoint: "sdk-cli", isSidechain: false, timestamp: "2026-10-25T10:00:00.000Z", userType: "external", cwd, version: "2.9.0" };

async function indexed(records: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "flowly-history-claude-")); roots.push(root);
  const folder = join(root, "claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${id}.jsonl`), records.map((record) => JSON.stringify(record) + "\n").join(""));
  const reader = new SessionHistory(join(root, "derived"), { claudeHome: join(root, "claude") }); readers.push(reader);
  const agent = { id: "claude-history", provider: "claude", cwd, persistence: { provider: "claude", nativeHandle: id, sessionId: id } } as never;
  await reader.read(agent, { session: "#1" });
  let page!: SessionHistoryPage;
  await vi.waitFor(async () => { page = await reader.read(agent, { session: "#1" }); expect(page.status).toBe("ready"); }, { timeout: 10_000, interval: 10 });
  return { page, find: async (query: string) => (await reader.read(agent, { session: "#1", query, limit: 20 })).entries };
}
const notice = (summary: string) => `<task-notification>\n<task-id>bk7p2q9x1</task-id>\n<status>failed</status>\n<summary>${summary}</summary>\n</task-notification>`;
const queued = (uuid: string, commandMode: string, prompt: unknown) => ({ ...base, type: "attachment", uuid, parentUuid: null, attachment: { type: "queued_command", commandMode, prompt, delivery_id: `d-${uuid}`, source_uuid: `q-${uuid}`, timestamp: base.timestamp } });
const routine = ["date", "environment", "task_reminder", "edited_text_file", "skill_listing", "nested_memory"].map((type, k) => ({ ...base, type: "attachment", uuid: `r-${k}`, attachment: { type, text: "synthetic" } }));
const bookkeeping = [{ ...base, type: "cost-state", totalCostUSD: 1 }, { ...base, type: "mode", mode: "default" }, { ...base, type: "permission-mode", permissionMode: "bypassPermissions" }, { ...base, type: "last-prompt", lastPrompt: "x" }, { ...base, type: "file-history-delta" }, { ...base, type: "agent-name", name: "x" }];
const continuing = { ...base, type: "assistant", uuid: "a2", message: { id: "r2", role: "assistant", content: [{ type: "text", text: "Continuing with the docs." }] } };

test("a person's words and a task notice delivered mid-turn are indexed, and routine records are metadata", async () => {
  const x = await indexed([
    { ...base, type: "user", uuid: "u0", message: { role: "user", content: "Run the staging migration, then update the docs." } },
    queued("att-1", "prompt", "Clarification: do NOT touch migrations/0042; the codeword is GARNET-4410."),
    queued("att-2", "task-notification", notice('Background command "npm run migrate:staging" failed with exit code 1 TASKFAIL-31')),
    queued("att-3", "prompt", [{ type: "text", text: "Also keep the changelog entry short (BLOCKWORD-12)." }]),
    ...routine, ...bookkeeping, continuing,
  ]);
  expect(await x.find("GARNET-4410")).toEqual([expect.objectContaining({ role: "user", text: expect.stringContaining("do NOT touch migrations/0042"), evidence: expect.objectContaining({ type: "claude/attachment/queued_command" }) })]);
  expect(await x.find("TASKFAIL-31")).toHaveLength(1);
  expect(await x.find("BLOCKWORD-12")).toHaveLength(1);
  expect(x.page.gaps).toEqual([]); expect(x.page.coverage).toMatchObject({ complete: true });
});

test("a task notice absorbed into a running turn (queue-operation records only) is indexed once, also when it is delivered again later", async () => {
  const text = notice('Background command "npm run migrate:staging" failed with exit code 1 ABSORBED-77');
  const x = await indexed([
    { ...base, type: "user", uuid: "u0", message: { role: "user", content: "Run the staging migration." } },
    { type: "queue-operation", operation: "enqueue", timestamp: base.timestamp, sessionId: id, content: text },
    { type: "queue-operation", operation: "remove", timestamp: base.timestamp, sessionId: id, commandUuid: "cmd-1", deliveryId: "del-1", reason: "absorbed_mid_turn", content: text },
    { type: "queue-operation", operation: "dequeue", timestamp: base.timestamp, sessionId: id },
    // A person's queued words are recorded where they are delivered, not in the queue's bookkeeping.
    { type: "queue-operation", operation: "enqueue", timestamp: base.timestamp, sessionId: id, content: "QUEUED-ONLY-5 a queued prompt" },
    queued("att-9", "task-notification", text),
    { ...base, type: "user", uuid: "u9", message: { role: "user", content: text } },
    continuing,
  ]);
  expect(await x.find("ABSORBED-77")).toEqual([expect.objectContaining({ role: "user", evidence: expect.objectContaining({ type: "claude/queue-operation" }) })]);
  expect(await x.find("QUEUED-ONLY-5")).toEqual([]);
  expect(x.page.gaps).toEqual([]);
});

test("an unknown record type or attachment subtype is a named gap, so a real loss is not hidden among metadata", async () => {
  const x = await indexed([
    { ...base, type: "user", uuid: "u0", message: { role: "user", content: "Start." } },
    { ...base, type: "attachment", uuid: "z1", attachment: { type: "hook_feedback", text: "synthetic" } },
    { ...base, type: "attachment", uuid: "z2", attachment: { type: "hook_feedback", text: "synthetic" } },
    { ...base, type: "telepathy", payload: "synthetic" },
    continuing,
  ]);
  expect(x.page.gaps).toEqual(expect.arrayContaining([{ kind: "unsupported_record/attachment/hook_feedback", count: 2 }, { kind: "unsupported_record/telepathy", count: 1 }]));
  expect(x.page.coverage).toMatchObject({ complete: false });
});
