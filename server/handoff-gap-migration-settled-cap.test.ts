import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { handoffOpenIds, type HandoffGap } from "../shared/handoff";
import { bodyReferences, tree } from "./handoff-collect-fixture";
import { flowly, legacyGap, legacyPass, migrationFixture, rollout, session } from "./handoff-gap-migration-fixture";
import { gapMigration, planGapMigration } from "./handoff-gap-migration";
import { countLegacyHistory } from "./handoff-gap-migration-history";

// The older builds' 100-gaps-per-pass cap dropped occurrences that no entry stands for. When a successor already settled the
// recorded entries of a kind, or the cap dropped a kind completely, no open entry is left to group: the migration still counts
// that kind in a capped session's history and states the occurrences past the cap that nobody saw, in a group of the same
// identity, without counting again what the successor settled; it detects the cap from the pass's ledger version and the
// settled entries' archived versions; and its note no longer says unknown types no recorded gap names were counted
// (SESSION-HANDOFF-SPEC §21.20). Temporary directories only.
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const sid = "019a0000-0000-7000-8000-00000000c0de", stamp = "2026-10-23T02:00:00.000Z";
const exec = (n: number) => ({ timestamp: stamp, type: "response_item", payload: { type: "function_call", name: "exec", call_id: `call-${n}`, arguments: "{}" } });
const answer = (n: number) => ({ timestamp: stamp, type: "response_item", payload: { type: "agent_message", message: `sub-agent answer ${n}` } });
const usage = (n: number) => ({ timestamp: stamp, type: "token_usage_record", payload: { n } });
const output = (id: string) => JSON.stringify({ timestamp: stamp, type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: "x".repeat(300_000) } });
type Fixture = Awaited<ReturnType<typeof migrationFixture>>;
const note = (record: { notes: { text: string }[] }) => record.notes.find((entry) => entry.text.startsWith("Capture rules v2"))?.text ?? "";
const scriptText = (count: number) => `Capture gap (opaque_tool_background): ${count} script or workflow calls of session #1 (w1) past an older build's cap of 100 gaps per pass were never listed and predate Flowly's background detection. Not checked for work left running: verify processes or search flowly_session_history.`;

/** Every gap of the card, current list and overflow index. */
async function all(x: Fixture) {
  const record = await x.service.records.read("card-a", "project"), gaps: HandoffGap[] = [...record.gaps];
  for (const entry of record.overflow.filter((e) => e.section === "gaps")) gaps.push((await x.service.records.page("card-a", { entryId: entry.id })).items[0].value as HandoffGap);
  return { record, gaps, open: gaps.filter((gap) => gap.status === "open") };
}
/** One pass of an older build over `lines` that recorded the first 100 gaps the lines raised and only counted the rest. */
async function cappedPass(x: Fixture, lines: unknown[]) {
  const file = await rollout(x.dir, lines);
  const raised = lines.flatMap((line, index) => {
    const value = typeof line === "string" ? {} : line as { type?: string; payload?: { type?: string; name?: string } }, offset = file.offsets[index], options = { session: sid, file: file.identity };
    if (value.payload?.name === "exec") return [legacyGap("w1", "opaque", "opaque_tool_background", offset, options)];
    if (value.payload?.type === "agent_message") return [legacyGap("w1", "response", "unknown_response_type", offset, { ...options, hint: "agent_message" })];
    if (value.type === "token_usage_record") return [legacyGap("w1", "type", "unknown_record_type", offset, { ...options, hint: "token_usage_record" })];
    return [];
  });
  const entries = raised.slice(0, 100), longs = lines.filter((line) => typeof line === "string").length;
  await legacyPass(x.dir, "card-a", session("w1", 1, "implementer"), entries, { path: file.path, identity: file.identity, offset: file.size, size: file.size }, Math.max(0, raised.length - 100 + longs));
  return { file, entries };
}
/** The successor w2 acknowledges `ids` as done. */
async function settle(x: Fixture, ids: string[]) {
  await x.service.records.setSession("card-a", "project", session("w2", 2, "implementer"), { ...flowly, sourceId: "session:w2" });
  const record = await x.service.records.read("card-a", "project");
  await x.service.records.update("card-a", "project", { handoffRevision: record.revision, ack: { handoffRevision: record.revision, heads: [], understanding: "Continuing.", items: ids.map((id) => ({ id, disposition: "done" as const, note: "checked" })) } }, { by: { kind: "agent", agentId: "w2" } }, { agentId: "w2", actualHeads: [] });
}

test("the successor settled the one recorded sub-agent answer of a capped pass: the four the cap dropped are stated, the settled one is not counted again", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }, answer(0)];
  for (let n = 0; n < 150; n++) lines.push(exec(n));
  lines.push(answer(1), answer(2), answer(3), answer(4));
  const { entries } = await cappedPass(x, lines);
  const single = entries.find((entry) => entry.value.text.includes("agent_message"))!.value;
  await settle(x, [single.id]);
  // The settled answer left the current list and the overflow index: only its archived versions name it.
  const settled = await x.service.records.read("card-a", "project");
  expect([...settled.gaps, ...settled.overflow].some((entry) => entry.id === single.id)).toBe(false);

  await x.service.migrateGaps({ pauseMs: 0 });
  const { record, open } = await all(x);
  const script = open.find((gap) => gap.text.startsWith("Capture gap (opaque_tool_background)"))!, answers = open.filter((gap) => gap.text.includes("agent_message"));
  expect(script.count).toBe(150);
  expect(answers.map((gap) => [gap.count, gap.text])).toEqual([[4, "Capture gap (unknown_response_type): agent_message: 4 occurrences in session #1 (w1) past an older build's cap of 100 gaps per pass, never listed and not preserved. That session's raw history holds them."]]);
  // Same identity as a group of that session, kind and hint would have.
  expect(answers[0].sourceId).toBe(`legacy-gaps:w1:unknown_response_type\0agent_message`);
  expect((await x.service.records.page("card-a", { entryId: single.id })).items[0].value).toMatchObject({ status: "closed", resolution: { by: { kind: "agent", agentId: "w2" } } });
  expect(handoffOpenIds(record).sort()).toEqual([script.id, answers[0].id].sort());
  expect((await x.board.read()).handoffIndex.find((entry) => entry.taskId === "card-a")?.open).toBe(2);
  expect(note(record)).toMatch(/added 1 counted group for 4 occurrences past an older build's cap that were never listed/);
  expect((await bodyReferences(x.handoffs, "card-a")).missing).toEqual([]);
});

test("the successor settled all 60 recorded script calls of a capped pass: the 90 the cap dropped are one open group; the pass's metadata is closed", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }];
  for (let n = 0; n < 150; n++) { lines.push(exec(n)); if (n < 40) lines.push(usage(n)); }
  const { entries } = await cappedPass(x, lines);
  const scripts = entries.filter((entry) => entry.value.text.startsWith("Capture gap (opaque_tool_background)"));
  expect(scripts).toHaveLength(60);
  await settle(x, scripts.map((entry) => entry.value.id));

  await x.service.migrateGaps({ pauseMs: 0 });
  const { record, open } = await all(x);
  expect(note(record)).toMatch(/^Capture rules v2 \(a one-time migration of the gaps older builds wrote once per occurrence\): closed 40 metadata records \(token_usage_record 40\); added 1 counted group for 90 occurrences past an older build's cap that were never listed; /);
  expect(open.map((gap) => [gap.count, gap.text])).toEqual([[90, scriptText(90)]]);
  expect(open[0].sourceId).toBe(`legacy-gaps:w1:opaque_tool_background\0`);
  for (const { value } of scripts) expect((await x.service.records.page("card-a", { entryId: value.id })).items[0].value).toMatchObject({ status: "closed", resolution: { by: { kind: "agent", agentId: "w2" } } });
  expect(handoffOpenIds(record)).toEqual([open[0].id]);
  expect((await x.board.read()).handoffIndex.find((entry) => entry.taskId === "card-a")?.open).toBe(1);
});

test("every recorded entry of a capped pass settled: the cap is still seen, the calls and the long line past it are stated once, and a rerun writes nothing", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }];
  for (let n = 0; n < 150; n++) { lines.push(exec(n)); if (n < 40) lines.push(usage(n)); }
  lines.push(output("big"));
  const { file, entries } = await cappedPass(x, lines);
  await settle(x, entries.map((entry) => entry.value.id));
  // No open legacy entry is left, and the session's current ledger entry was not touched since that pass.
  const before = await x.service.records.read("card-a", "project");
  expect(before.gaps.filter((gap) => gap.status === "open")).toEqual([]);

  await x.service.migrateGaps({ pauseMs: 0 });
  const { record, open } = await all(x);
  expect(record.revision).toBe(before.revision + 1);
  expect(open.map((gap) => gap.text).sort()).toEqual([
    scriptText(90),
    `Capture gap (long_line) in bytes ${file.offsets.at(-1)}–${file.size}: response_item/custom_tool_call_output, ${file.size - file.offsets.at(-1)!} bytes. This content was not preserved; that range of the session's raw history holds it.`,
  ].sort());
  const text = note(record);
  expect(text).toMatch(/an older build stopped recording after 100 gaps per capture pass in session #1 \(w1\)/);
  expect(text).toMatch(/1 line over 256 KiB that it skipped and never listed is now a gap/);
  expect((await x.board.read()).handoffIndex.find((entry) => entry.taskId === "card-a")?.open).toBe(2);
  // A second start meets the receipt; with the receipt gone, a rerun derives nothing new and writes nothing.
  const files = await tree(x.handoffs);
  await x.start().migrateGaps({ pauseMs: 0 });
  expect(await tree(x.handoffs)).toEqual(files);
  await rm(join(x.handoffs, "card-a", "ops", `${createHash("sha256").update(gapMigration.operationId).digest("hex")}.json`));
  const again = await tree(x.handoffs), rerun = await x.service.records.migrateLegacyGaps("card-a", countLegacyHistory);
  expect(rerun).toMatchObject({ stored: "none", replayed: false });
  // The group it stated is not stated again (the closed script entries are now all recorded, and the group names the rest).
  expect(rerun.plan?.groups).toEqual([]);
  expect(await tree(x.handoffs)).toEqual(again);
});

test("a kind whose recorded occurrences the history does not all hold is not counted: no group for it, and the note says what may be missing", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }, answer(0)];
  for (let n = 0; n < 120; n++) lines.push(exec(n));
  lines.push(answer(1), answer(2));
  const file = await rollout(x.dir, lines), options = { session: sid, file: file.identity };
  // The recorded answer names a line that holds a script call, not an answer: the history does not hold what it stood for.
  const answerGap = legacyGap("w1", "response", "unknown_response_type", file.offsets[5], { ...options, hint: "agent_message" });
  const entries = [answerGap, ...Array.from({ length: 99 }, (_, n) => legacyGap("w1", "opaque", "opaque_tool_background", file.offsets[2 + n], options))];
  await legacyPass(x.dir, "card-a", session("w1", 1, "implementer"), entries, { path: file.path, identity: file.identity, offset: file.size, size: file.size }, 23);
  await settle(x, [answerGap.value.id]);
  await x.service.migrateGaps({ pauseMs: 0 });
  const { record, open } = await all(x);
  expect(open.map((gap) => [gap.count, gap.text.split(":")[0]])).toEqual([[120, "Capture gap (opaque_tool_background)"]]);
  expect(note(record)).toMatch(/up to where that build read \(not 1 kind whose recorded gaps that history does not all hold: its group says "at least", or what the cap dropped of it may be missing\)/);
});

test("a capped pass that recorded only metadata: the 30 script calls past the cap are counted although no entry names a script call", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }];
  for (let n = 0; n < 100; n++) lines.push(usage(n));
  for (let n = 0; n < 30; n++) lines.push(exec(n));
  await cappedPass(x, lines);
  await x.service.migrateGaps({ pauseMs: 0 });
  const { record, open } = await all(x);
  expect(note(record)).toMatch(/closed 100 metadata records \(token_usage_record 100\); added 1 counted group for 30 occurrences past/);
  expect(open.map((gap) => [gap.count, gap.text])).toEqual([[30, scriptText(30)]]);
  // The note says what was counted and that unknown types no recorded gap names may be missing.
  const text = note(record);
  expect(text).toMatch(/script calls and every unknown record, event or response type named by a gap it recorded there are counted in the session's provider history up to where that build read/);
  expect(text).toMatch(/unknown types that no recorded gap names, and other kinds it raised past that cap \(unparsable lines, images, system notices, tool-call problems\), are not counted again and may be missing/);
  expect(text).not.toMatch(/unknown record, event and response types there are counted/);
});

test("in an uncapped session, recorded entries a successor settled leave nothing to state", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }, answer(0)];
  for (let n = 0; n < 20; n++) lines.push(exec(n));
  const { entries } = await cappedPass(x, lines);
  expect(entries).toHaveLength(21);
  await settle(x, entries.map((entry) => entry.value.id));
  const before = await x.service.records.read("card-a", "project");
  await expect(x.service.records.migrateLegacyGaps("card-a", countLegacyHistory)).resolves.toMatchObject({ stored: "none" });
  expect((await x.service.records.read("card-a", "project")).revision).toBe(before.revision);
});

test("the time an entry was touched is no pass time: a cursor a later build moved, saved in that update, is not read as that build's end", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }];
  for (let n = 0; n < 150; n++) lines.push(exec(n));
  const file = await rollout(x.dir, lines), options = { session: sid, file: file.identity };
  const entries = Array.from({ length: 100 }, (_, n) => legacyGap("w1", "opaque", "opaque_tool_background", file.offsets[1 + n], options));
  const draft = { ...session("w1", 1, "implementer"), background: [{ id: "b:import", kind: "script" as const, ref: "call-0", label: "import", startedAt: stamp, status: "open" as const, source: "live" as const }] };
  await legacyPass(x.dir, "card-a", draft, entries, { path: file.path, identity: file.identity, offset: file.size, size: file.size }, 50);
  // Today's build read 20 more calls, with background detection, and moved the cursor in place.
  await appendFile(file.path, Array.from({ length: 20 }, (_, n) => `${JSON.stringify(exec(500 + n))}\n`).join(""));
  const { size } = await stat(file.path);
  await x.service.records.capture("card-a", "project", { cursor: { agentId: "w1", through: { path: file.path, identity: file.identity, offset: size, size, at: "2026-10-25T12:00:00.000Z", lagBytes: 0, gaps: 0 } } }, flowly);
  // In one update the successor keeps 10 calls open with a note and settles the background item, so w1's ledger entry is
  // saved at that time with today's cursor, and the 10 entries carry that time too.
  await x.service.records.setSession("card-a", "project", session("w2", 2, "implementer"), { ...flowly, sourceId: "session:w2" });
  const record = await x.service.records.read("card-a", "project");
  await x.service.records.update("card-a", "project", { handoffRevision: record.revision, gaps: entries.slice(0, 10).map(({ value }) => ({ id: value.id, status: "open" as const, note: "may still run" })), ack: { handoffRevision: record.revision, heads: [], understanding: "Continuing.", items: [{ id: "b:import", disposition: "done" as const, note: "the import ended" }] } }, { by: { kind: "agent", agentId: "w2" } }, { agentId: "w2", actualHeads: [] });
  // The archive, where the annotated entries' first versions and the pass's ledger version are, cannot be read.
  await rm(join(x.handoffs, "card-a", "archive.jsonl"));
  await x.service.migrateGaps({ pauseMs: 0 });
  const script = (await all(x)).open.find((gap) => gap.sourceId?.startsWith("legacy-gaps:"))!;
  // Never the 20 calls today's build read: the history holds 140 that build stood for, less the 10 annotated.
  expect(script.count).toBeLessThanOrEqual(130);
});

test("the text of a group for occurrences past the cap ends whole within 300 characters, at the largest counts, session labels and hints", () => {
  const agentId = "7c089b5c-83a7-40bd-ab45-e184c9ca67e4", sessions = new Map([[agentId, { n: 99, provider: "codex" }]]);
  for (const count of [1, 99_999]) for (const [kind, hint] of [["opaque_tool_background", undefined], ["unknown_response_type", "h".repeat(80)]] as const) {
    const plan = planGapMigration([], sessions, { measures: new Map(), capped: [], unlisted: [{ agentId, kind, ...(hint ? { hint } : {}), count }] });
    expect(plan.groups.map((group) => group.count)).toEqual([count]);
    expect(plan.groups[0].text.length).toBeLessThanOrEqual(300);
    expect(plan.groups[0].text).toMatch(/(?:flowly_session_history|holds (?:it|them))\.$/);
  }
});
