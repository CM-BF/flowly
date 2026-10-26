import { afterEach, expect, test } from "vitest";
import { appendFile, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handoffOpenIds, type HandoffGap } from "../shared/handoff";
import { countLegacyHistory } from "./handoff-gap-migration-history";
import { gapBuckets, planGapMigration } from "./handoff-gap-migration";
import { flowly, legacyGap, legacyPass, migrationFixture, rollout, session } from "./handoff-gap-migration-fixture";

// 684a8fd and 786d9cd kept at most 100 capture gaps per capture pass and only counted the rest in that pass's coverage text
// ("N additional capture gaps omitted"). A session whose pass hit that cap holds fewer legacy entries than calls. The grouped
// gap states the number the session's provider history holds, counted by the older build's own rules over the bytes that
// pass read, or "at least N" with the reason when that history is gone or changed (SESSION-HANDOFF-SPEC §21.17).
// Temporary directories only.
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const codexSession = "019a0000-0000-7000-8000-00000000c0de";
const stamp = "2026-10-23T02:00:00.000Z";
const exec = (n: number, name = "exec") => ({ timestamp: stamp, type: "response_item", payload: { type: n % 2 ? "custom_tool_call" : "function_call", name, call_id: `call-${n}`, ...(n % 2 ? { input: "print(1)" } : { arguments: "{}" }) } });
const usage = { timestamp: stamp, type: "token_usage_record", payload: {} };
const answer = (n: number) => ({ timestamp: stamp, type: "response_item", payload: { type: "agent_message", message: `sub-agent answer ${n}` } });
const command = (n: number) => ({ timestamp: stamp, type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: `cmd-${n}`, arguments: "{\"cmd\":\"ls\"}" } });

/**
 * A session whose one capture pass (an older build) read the whole history: 130 script calls (one a Workflow), 13 sub-agent
 * answers, usage records and plain commands. The pass recorded the first 100 gap-worthy records and omitted the rest.
 */
async function capped() {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: codexSession } }];
  for (let n = 0; n < 130; n++) {
    lines.push(exec(n, n === 7 ? "functions.Workflow" : n === 8 ? "functions.exec" : "exec"));
    if (n % 3 === 0) lines.push(usage);
    if (n % 10 === 0) lines.push(answer(n));
    if (n % 4 === 0) lines.push(command(n));
  }
  const file = await rollout(x.dir, lines), kinds = lines.map((line) => {
    const value = line as { type: string; payload: { type?: string; name?: string } };
    return value.type === "token_usage_record" ? "usage" : value.payload.type === "agent_message" ? "answer" : value.payload.name && /(?:^|\.)(?:exec|Workflow)$/.test(value.payload.name) ? "script" : null;
  });
  const worthy = kinds.flatMap((kind, index) => kind ? [{ kind, offset: file.offsets[index] }] : []);
  const options = { session: codexSession, file: file.identity };
  const entries = worthy.slice(0, 100).map(({ kind, offset }) => kind === "script" ? legacyGap("w1", "opaque", "opaque_tool_background", offset, options)
    : kind === "usage" ? legacyGap("w1", "type", "unknown_record_type", offset, { ...options, hint: "token_usage_record" }) : legacyGap("w1", "response", "unknown_response_type", offset, { ...options, hint: "agent_message" }));
  await legacyPass(x.dir, "card-a", session("w1", 1, "implementer"), entries, { path: file.path, identity: file.identity, offset: file.size, size: file.size }, worthy.length - 100);
  await x.service.records.setSession("card-a", "project", session("w2", 2, "implementer"), { ...flowly, sourceId: "session:w2" });
  const recorded = (kind: string) => entries.filter(({ value }) => value.text.startsWith(`Capture gap (${kind})`));
  const groups = async () => (await x.service.records.read("card-a", "project")).gaps.filter((gap) => gap.sourceId?.startsWith("legacy-gaps:"));
  return { ...x, file, entries, worthy, recorded, groups };
}

test("a pass that hit the older build's cap: the groups state what the session's history holds, less what a successor settled", async () => {
  const x = await capped(), scripts = x.recorded("opaque_tool_background");
  expect(scripts.length).toBeLessThan(130);
  expect(x.recorded("unknown_response_type").length).toBeLessThan(13);
  // The successor settled two of the recorded script calls and keeps a third open with its own note.
  let record = await x.service.records.read("card-a", "project");
  await x.service.records.update("card-a", "project", { handoffRevision: record.revision, ack: { handoffRevision: record.revision, heads: [], understanding: "Continuing the import.", items: scripts.slice(0, 2).map(({ value }) => ({ id: value.id, disposition: "done" as const, note: "that script returned" })) } }, { by: { kind: "agent", agentId: "w2" } }, { agentId: "w2", actualHeads: [] });
  record = await x.service.records.read("card-a", "project");
  await x.service.records.update("card-a", "project", { handoffRevision: record.revision, gaps: [{ id: scripts[2].value.id, status: "open", note: "pid 4242 of this script may still run" }] }, { by: { kind: "agent", agentId: "w2" } });
  await x.service.migrateGaps({ pauseMs: 0 });
  const groups = await x.groups(), script = groups.find((gap) => gap.text.startsWith("Capture gap (opaque_tool_background)"))!, answers = groups.find((gap) => gap.text.startsWith("Capture gap (unknown_response_type)"))!;
  expect(script).toMatchObject({ count: 127, status: "open" });
  expect(script.text).toBe("Capture gap (opaque_tool_background): 127 script or workflow calls of session #1 (w1) were captured by an older build, before Flowly's background detection. Not checked for work left running: verify running processes or search flowly_session_history before relying on it.");
  expect(answers).toMatchObject({ count: 13 });
  expect(answers.text).toBe("Capture gap (unknown_response_type): agent_message: 13 occurrences in session #1 (w1) that an older build did not preserve. That session's raw history holds them.");
  for (const gap of groups) expect(gap.text.length).toBeLessThanOrEqual(300);
  const after = await x.service.records.read("card-a", "project");
  expect(handoffOpenIds(after).sort()).toEqual([script.id, answers.id, scripts[2].value.id].sort());
  expect(after.notes.find((note) => note.text.startsWith("Capture rules v2"))!.text).toMatch(/counted in the session's provider history/);
});

for (const change of ["missing", "shorter", "replaced"] as const) {
  test(`a pass that hit the cap whose history is ${change}: the groups say "at least" and why`, async () => {
    const x = await capped(), scripts = x.recorded("opaque_tool_background").length, answers = x.recorded("unknown_response_type").length;
    if (change === "missing") await rm(x.file.path);
    if (change === "shorter") await truncate(x.file.path, x.file.size - 10);
    if (change === "replaced") { await writeFile(`${x.file.path}.next`, await readFile(x.file.path)); await rename(`${x.file.path}.next`, x.file.path); }
    await x.service.migrateGaps({ pauseMs: 0 });
    const groups = await x.groups();
    expect(groups.map((gap) => [gap.text.split(":")[0], gap.count]).sort()).toEqual([["Capture gap (opaque_tool_background)", scripts], ["Capture gap (unknown_response_type)", answers]].sort());
    expect(groups.find((gap) => gap.text.startsWith("Capture gap (opaque_tool_background)"))!.text).toBe(`Capture gap (opaque_tool_background): at least ${scripts} script or workflow calls of session #1 (w1) were captured by an older build without background detection; it stopped recording after 100 gaps per pass. Not checked for work left running: verify processes or search flowly_session_history.`);
    expect(groups.find((gap) => gap.text.startsWith("Capture gap (unknown_response_type)"))!.text).toBe(`Capture gap (unknown_response_type): agent_message: at least ${answers} occurrences in session #1 (w1) that an older build did not preserve; it stopped recording after 100 gaps per capture pass. That session's raw history holds them.`);
    for (const gap of groups) expect(gap.text.length).toBeLessThanOrEqual(300);
  });
}

test("the cap is also seen from the pass alone: 100 entries written at one time and no ledger version of that pass", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  await x.service.records.setSession("card-a", "project", session("w1", 1, "implementer"), { ...flowly, sourceId: "session:w1" });
  await x.write("card-a", [...Array.from({ length: 60 }, (_, n) => legacyGap("w1", "opaque", "opaque_tool_background", 1000 + n)), ...Array.from({ length: 40 }, (_, n) => legacyGap("w1", "type", "unknown_record_type", n, { hint: "world_state" }))]);
  await x.service.migrateGaps({ pauseMs: 0 });
  const record = await x.service.records.read("card-a", "project"), group = record.gaps.find((gap) => gap.sourceId?.startsWith("legacy-gaps:")) as HandoffGap;
  expect(group).toMatchObject({ count: 60 });
  expect(group.text).toMatch(/^Capture gap \(opaque_tool_background\): at least 60 script or workflow calls of session #1 \(w1\)/);
});

test("the older build's rules, counted over the bytes its pass read; a file that is not the cursor's is not counted", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const long = JSON.stringify({ timestamp: stamp, type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "long", input: "x".repeat(300_000) } });
  const file = await rollout(x.dir, [
    { type: "session_meta", payload: {} }, exec(1), exec(2, "functions.exec"), exec(3, "Workflow"), exec(4, "functions.Workflow"),
    exec(5, "exec_command"), exec(6, "mcp__paseo__Workflow"), exec(7, "functions.exec_command"), long, "{ not json exec\"", "",
    { type: "response_item", payload: { type: "agent_message" } }, { type: "event_msg", payload: { type: "thread_goal_updated" } }, { type: "world_state", payload: {} },
    exec(8),
  ]);
  const end = file.offsets.at(-1)!, targets = [{ kind: "opaque_tool_background" as const }, { kind: "unknown_response_type" as const, hint: "agent_message" }, { kind: "unknown_event_type" as const, hint: "thread_goal_updated" }, { kind: "unknown_record_type" as const, hint: "world_state" }];
  // exec(8) starts at `end`: past what the pass read. The long line is not parsed: it is listed with where it is and what
  // today's capture would call it (SESSION-HANDOFF-SPEC §21.19).
  expect(await countLegacyHistory({ path: file.path, identity: file.identity, end, provider: "codex", targets })).toEqual({ found: [file.offsets.slice(1, 5), [file.offsets[11]], [file.offsets[12]], [file.offsets[13]]], long: [{ start: file.offsets[8], end: file.offsets[9], hint: "response_item/custom_tool_call", at: stamp }] });
  // No target: only the long lines.
  expect(await countLegacyHistory({ path: file.path, identity: file.identity, end, provider: "codex", targets: [] })).toEqual({ found: [], long: [{ start: file.offsets[8], end: file.offsets[9], hint: "response_item/custom_tool_call", at: stamp }] });
  expect(await countLegacyHistory({ path: file.path, identity: file.identity.replace(/^\d+/, "1"), end, provider: "codex", targets })).toBeNull();
  expect(await countLegacyHistory({ path: file.path, identity: file.identity, end: file.size + 1, provider: "codex", targets })).toBeNull();
  expect(await countLegacyHistory({ path: join(x.dir, "gone.jsonl"), identity: file.identity, end, provider: "codex", targets })).toBeNull();
  // Claude Code: a Workflow tool use in an assistant record, one per record; sidechain records are not the session's.
  const claude = await rollout(x.dir, [
    { type: "assistant", sessionId: "c", message: { content: [{ type: "tool_use", id: "t1", name: "Workflow", input: {} }, { type: "tool_use", id: "t2", name: "Workflow", input: {} }] } },
    { type: "assistant", sessionId: "c", isSidechain: true, message: { content: [{ type: "tool_use", id: "t3", name: "Workflow", input: {} }] } },
    { type: "assistant", sessionId: "c", message: { content: [{ type: "tool_use", id: "t4", name: "Bash", input: {} }] } },
    { type: "cost-state", sessionId: "c" },
    // A long paste whose message id JSON writes after the text: read from the line's end, as today's capture does.
    { type: "user", sessionId: "c", message: { role: "user", content: "p".repeat(300_000) }, uuid: "u-1" },
  ], "claude.jsonl");
  expect(await countLegacyHistory({ path: claude.path, identity: claude.identity, end: claude.size, provider: "claude", targets: [{ kind: "opaque_tool_background" }, { kind: "unknown_record_type", hint: "cost-state" }] })).toEqual({ found: [[0], [claude.offsets[3]]], long: [{ start: claude.offsets[4], end: claude.size, hint: "user", messageId: "u-1" }] });
});

test("a group's text ends whole within the 300 characters a gap holds, at the largest counts and session labels", () => {
  const agentId = "7c089b5c-83a7-40bd-ab45-e184c9ca67e4", sessions = new Map([[agentId, { n: 99, provider: "codex" }]]);
  const gaps = [1, 2].map((n) => ({ ...legacyGap(agentId, "opaque", "opaque_tool_background", n).value, rev: 1, by: { kind: "flowly" as const } }) as HandoffGap);
  const [bucket] = gapBuckets(gaps, sessions);
  for (const basis of ["recorded", "history", "atLeast"] as const) {
    const text = planGapMigration(gaps, sessions, { measures: new Map([[bucket.key, { count: 99_999, basis }]]), capped: [] }).groups[0].text;
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toMatch(/flowly_session_history(?: before relying on it)?\.$/);
  }
});

test("a cursor a later build moved in place past that pass is not the pass's end: the groups say \"at least\"", async () => {
  const x = await capped(), scripts = x.recorded("opaque_tool_background").length;
  // The session went on under today's build: more script calls, read with background detection; the cursor moved in place.
  await appendFile(x.file.path, Array.from({ length: 20 }, (_, n) => `${JSON.stringify(exec(500 + n))}\n`).join(""));
  const { size } = await stat(x.file.path);
  await x.service.records.capture("card-a", "project", { cursor: { agentId: "w1", through: { path: x.file.path, identity: x.file.identity, offset: size, size, at: "2026-10-25T12:00:00.000Z", lagBytes: 0, gaps: 0 } } }, flowly);
  const ledger = (await x.service.records.read("card-a", "project")).ledger.find((entry) => entry.agentId === "w1")!;
  expect([ledger.at, ledger.through?.offset]).toEqual([x.entries[0].value.at, size]);
  await x.service.migrateGaps({ pauseMs: 0 });
  const script = (await x.groups()).find((gap) => gap.text.startsWith("Capture gap (opaque_tool_background)"))!;
  expect(script).toMatchObject({ count: scripts });
  expect(script.text).toMatch(new RegExp(`^Capture gap \\(opaque_tool_background\\): at least ${scripts} script or workflow calls`));
});
