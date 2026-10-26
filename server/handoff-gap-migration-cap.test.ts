import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { handoffOpenIds, type HandoffGap } from "../shared/handoff";
import { handoffView } from "../shared/handoff-view";
import { bodyReferences, tree } from "./handoff-collect-fixture";
import { flowly, legacyGap, legacyPass, migrationFixture, rollout, session } from "./handoff-gap-migration-fixture";
import { gapMigration, planGapMigration } from "./handoff-gap-migration";
import { countLegacyHistory } from "./handoff-gap-migration-history";

// The older builds' 100-gaps-per-pass cap dropped every gap past the 100th of a pass, of any kind: script calls, but also
// lines over 256 KiB (located, unpreserved content) and single entries of a countable kind. In a capped session the
// migration lists the long lines no recorded gap covers, counts a single entry of a countable kind like a group, and says
// in its note what it could and could not count again (SESSION-HANDOFF-SPEC §21.19). Temporary directories only.
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const sid = "019a0000-0000-7000-8000-00000000c0de", stamp = "2026-10-23T02:00:00.000Z";
const exec = (n: number) => ({ timestamp: stamp, type: "response_item", payload: { type: "function_call", name: "exec", call_id: `call-${n}`, arguments: "{}" } });
const answer = (n: number) => ({ timestamp: stamp, type: "response_item", payload: { type: "agent_message", message: `sub-agent answer ${n}` } });
const usage = { timestamp: stamp, type: "token_usage_record", payload: {} };
const output = (id: string, size = 300_000) => JSON.stringify({ timestamp: stamp, type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: "x".repeat(size) } });
const command = (id: string) => JSON.stringify({ timestamp: stamp, type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id, aggregated_output: "y".repeat(300_000) } } });
const typed = (n: number) => JSON.stringify({ timestamp: stamp, type: "event_msg", payload: { type: "user_message", message: `pasted log ${n} ${"z".repeat(300_000)}` } });
const compacted = JSON.stringify({ timestamp: stamp, type: "compacted", payload: { message: "", replacement_history: [{ type: "message", content: "c".repeat(300_000) }] }, latest_token_usage_record: {} });
const lineText = (start: number, end: number, hint: string) => `Capture gap (long_line) in bytes ${start}–${end}: ${hint}, ${end - start} bytes. This content was not preserved; that range of the session's raw history holds it.`;
const note = (record: { notes: { text: string }[] }) => record.notes.find((entry) => entry.text.startsWith("Capture rules v2"))?.text ?? "";
const openGaps = async (x: Awaited<ReturnType<typeof migrationFixture>>) => {
  const record = await x.service.records.read("card-a", "project"), all: HandoffGap[] = [...record.gaps];
  for (const entry of record.overflow.filter((e) => e.section === "gaps")) all.push((await x.service.records.page("card-a", { entryId: entry.id })).items[0].value as HandoffGap);
  return { record, open: all.filter((gap) => gap.status === "open") };
};

/**
 * One pass of an older build over `lines` that recorded the first 100 gap-worthy records (`worthy` returns the legacy gap a
 * line raised, or null) and only counted the rest. Returns the file and what was recorded.
 */
async function cappedPass(x: Awaited<ReturnType<typeof migrationFixture>>, lines: unknown[], worthy: (line: unknown, offset: number, file: { identity: string }) => ReturnType<typeof legacyGap> | null) {
  const file = await rollout(x.dir, lines), raised = lines.flatMap((line, index) => worthy(line, file.offsets[index], file) ?? []);
  const entries = raised.slice(0, 100);
  await legacyPass(x.dir, "card-a", session("w1", 1, "implementer"), entries, { path: file.path, identity: file.identity, offset: file.size, size: file.size }, raised.length - 100);
  return { file, entries };
}
const scriptOrAnswer = (line: unknown, offset: number, file: { identity: string }) => {
  const payload = typeof line === "object" ? (line as { payload?: { type?: string; name?: string } }).payload : undefined;
  if (payload?.name === "exec") return legacyGap("w1", "opaque", "opaque_tool_background", offset, { session: sid, file: file.identity });
  if (payload?.type === "agent_message") return legacyGap("w1", "response", "unknown_response_type", offset, { session: sid, file: file.identity, hint: "agent_message" });
  return null;
};

test("a capped pass: the long line and the single answer past the 100th gap are stated, and the note keeps the cap", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }, answer(0)];
  for (let n = 0; n < 150; n++) lines.push(exec(n));
  lines.push(output("big"), answer(1), answer(2), answer(3), answer(4));
  // The pass recorded the first answer and 99 script calls; 51 calls, the long line and 4 answers were only counted.
  const { file, entries } = await cappedPass(x, lines, scriptOrAnswer);
  expect(entries.filter((entry) => entry.value.text.includes("agent_message"))).toHaveLength(1);
  await x.service.migrateGaps({ pauseMs: 0 });
  const { record, open } = await openGaps(x);
  const script = open.find((gap) => gap.text.startsWith("Capture gap (opaque_tool_background)"))!;
  expect(script.count).toBe(150);
  // The single recorded answer stood for five: it is closed into a group that counts them.
  const answers = open.filter((gap) => gap.text.includes("agent_message"));
  expect(answers.map((gap) => [gap.count, gap.text])).toEqual([[5, "Capture gap (unknown_response_type): agent_message: 5 occurrences in session #1 (w1) that an older build did not preserve. That session's raw history holds them."]]);
  const single = entries.find((entry) => entry.value.text.includes("agent_message"))!.value.id;
  expect((await x.service.records.page("card-a", { entryId: single })).items[0].value).toMatchObject({ status: "closed", resolution: { by: { kind: "flowly" }, note: `grouped by capture rules v2 into ${answers[0].id}` } });
  // The skipped tool output is its own gap in today's located form, with the line's own time.
  const long = open.filter((gap) => gap.text.startsWith("Capture gap (long_line)"));
  expect(long.map((gap) => [gap.text, gap.count, gap.firstAt, gap.lastAt, gap.by.kind])).toEqual([[lineText(file.offsets[152], file.offsets[153], "response_item/custom_tool_call_output"), 1, stamp, stamp, "flowly"]]);
  expect(handoffOpenIds(record).sort()).toEqual([script.id, answers[0].id, long[0].id].sort());
  expect((await x.board.read()).handoffIndex.find((entry) => entry.taskId === "card-a")?.open).toBe(3);
  // The note keeps the cap: what was counted again in the history, the line now listed, and what could not be counted.
  const text = note(record);
  expect(text).toMatch(/an older build stopped recording after 100 gaps per capture pass in session #1 \(w1\)/);
  expect(text).toMatch(/counted in the session's provider history/);
  expect(text).toMatch(/1 line over 256 KiB that it skipped and never listed is now a gap/);
  expect(text).toMatch(/other kinds it raised past that cap .* may be missing/);
  expect(text).toMatch(/replaced 1 single gap .* with 1 counted group/);
  expect((await bodyReferences(x.handoffs, "card-a")).missing).toEqual([]);
});

test("long lines a recorded gap covers are not listed again, settled ones stay settled, a compaction record is no gap, a person's paste is", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }, command("recorded-open"), command("recorded-settled")];
  for (let n = 0; n < 120; n++) lines.push(exec(n));
  lines.push(compacted, typed(1), output("unlisted"));
  const longs = new Set([1, 2, 123, 124, 125]);
  const { file, entries } = await cappedPass(x, lines, (line, offset, f) => {
    const index = lines.indexOf(line);
    if (longs.has(index)) return legacyGap("w1", "long", "long_line", offset, { hint: index === 123 ? "compacted/message" : index === 124 ? "event_msg/user_message" : index === 125 ? "response_item/custom_tool_call_output" : "event_msg/item_completed", bytes: [offset, offset + Buffer.byteLength(`${line as string}\n`)], file: f.identity });
    return scriptOrAnswer(line, offset, f);
  });
  // Recorded: the two command outputs and 98 calls. Past the cap: 22 calls, the compaction, the paste and a tool output.
  const recorded = entries.filter((entry) => entry.value.text.startsWith("Capture gap (long_line)"));
  expect(recorded).toHaveLength(2);
  // A successor settled one of them; a later write moves the settled one out of the current list into the archive.
  await x.service.records.setSession("card-a", "project", session("w2", 2, "implementer"), { ...flowly, sourceId: "session:w2" });
  let record = await x.service.records.read("card-a", "project");
  await x.service.records.update("card-a", "project", { handoffRevision: record.revision, ack: { handoffRevision: record.revision, heads: [], understanding: "Continuing.", items: [{ id: recorded[1].value.id, disposition: "done" as const, note: "that output is in the test log" }] } }, { by: { kind: "agent", agentId: "w2" } }, { agentId: "w2", actualHeads: [] });
  record = await x.service.records.read("card-a", "project");
  await x.service.records.update("card-a", "project", { handoffRevision: record.revision, gaps: [{ text: "Which fixture did the predecessor use?", status: "open" }] }, { by: { kind: "agent", agentId: "w2" } });
  record = await x.service.records.read("card-a", "project");
  expect([...record.gaps, ...record.overflow].some((entry) => entry.id === recorded[1].value.id)).toBe(false);

  await x.service.migrateGaps({ pauseMs: 0 });
  const { record: after, open } = await openGaps(x);
  const long = open.filter((gap) => gap.text.startsWith("Capture gap (long_line)")).map((gap) => gap.text).sort();
  expect(long).toEqual([
    recorded[0].value.text,
    lineText(file.offsets[124], file.offsets[125], "event_msg/user_message"),
    lineText(file.offsets[125], file.size, "response_item/custom_tool_call_output"),
  ].sort());
  expect((await x.service.records.page("card-a", { entryId: recorded[1].value.id })).items[0].value).toMatchObject({ status: "closed", resolution: { by: { kind: "agent", agentId: "w2" } } });
  const text = note(after);
  expect(text).toMatch(/2 lines over 256 KiB that it skipped and never listed are now gaps \(1 skipped compaction record is not a gap under capture rules v2\)/);
  // A second start meets the receipt and writes nothing; even with the receipt gone, a rerun derives the same entries and
  // writes nothing.
  const files = await tree(x.handoffs);
  await x.start().migrateGaps({ pauseMs: 0 });
  expect(await tree(x.handoffs)).toEqual(files);
  await rm(join(x.handoffs, "card-a", "ops", `${createHash("sha256").update(gapMigration.operationId).digest("hex")}.json`));
  const again = await tree(x.handoffs);
  await expect(x.service.records.migrateLegacyGaps("card-a", countLegacyHistory)).resolves.toMatchObject({ stored: "none", replayed: false });
  expect(await tree(x.handoffs)).toEqual(again);
});

test("a capped session holding only metadata gaps still gets its unlisted long lines; past eight, one group counts the rest", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }];
  for (let n = 0; n < 110; n++) lines.push(usage);
  for (let n = 0; n < 10; n++) lines.push(output(`out-${n}`, 270_000));
  // The pass recorded 100 usage records; 10 more and the 10 long lines that followed were only counted.
  const { file } = await cappedPass(x, lines, (line, offset, f) => line === usage ? legacyGap("w1", "type", "unknown_record_type", offset, { session: sid, file: f.identity, hint: "token_usage_record" })
    : typeof line === "string" ? legacyGap("w1", "long", "long_line", offset, { hint: "response_item/custom_tool_call_output", bytes: [offset, offset + Buffer.byteLength(`${line}\n`)], file: f.identity }) : null);
  await x.service.migrateGaps({ pauseMs: 0 });
  const { record, open } = await openGaps(x);
  const own = open.filter((gap) => gap.text.startsWith("Capture gap (long_line) in bytes")), more = open.filter((gap) => gap.text.startsWith("Capture gap (long_line):"));
  expect(own.map((gap) => gap.text).sort()).toEqual(Array.from({ length: 8 }, (_, n) => lineText(file.offsets[111 + n], file.offsets[112 + n], "response_item/custom_tool_call_output")).sort());
  expect(more.map((gap) => [gap.count, gap.text])).toEqual([[2, `Capture gap (long_line): 2 more lines over 256 KiB in session #1 (w1) that an older build skipped and never listed, the first in bytes ${file.offsets[119]}–${file.offsets[120]}, ${file.offsets[120]}–${file.size}. This content was not preserved; that session's raw history holds them.`]]);
  expect(handoffOpenIds(record)).toHaveLength(9);
  expect(note(record)).toMatch(/10 lines over 256 KiB that it skipped and never listed are now gaps/);
  // Everything the record holds open is in view.
  expect(handoffView(record).omitted).toBe(0);
});

test("a capped pass whose recorded gaps all stay as they are: its unlisted long line alone is written, once", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }];
  for (let n = 0; n < 100; n++) lines.push(`{"type":"response_item","payload":${n}`);
  lines.push(output("big"));
  // The pass recorded 100 unparsable lines (located, kept by the migration); the long line after them was only counted.
  const { file } = await cappedPass(x, lines, (line, offset, f) => typeof line === "string" && !line.includes("custom_tool_call_output") ? legacyGap("w1", "parse", "parse_failed", offset, { session: sid, file: f.identity }) : null);
  const before = (await x.service.records.read("card-a", "project")).revision;
  await x.service.migrateGaps({ pauseMs: 0 });
  const { record, open } = await openGaps(x);
  expect(record.revision).toBe(before + 1);
  expect(open.filter((gap) => gap.text.startsWith("Capture gap (long_line)")).map((gap) => gap.text)).toEqual([lineText(file.offsets[101], file.size, "response_item/custom_tool_call_output")]);
  expect(open.filter((gap) => gap.text.startsWith("Capture gap (parse_failed)"))).toHaveLength(100);
  expect(note(record)).toMatch(/1 line over 256 KiB that it skipped and never listed is now a gap.*100 other open gaps unchanged/);
});

test("a capped session whose history cannot be read: nothing is listed from it, and the note says what may be missing", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }, answer(0)];
  for (let n = 0; n < 120; n++) lines.push(exec(n));
  lines.push(output("big"), answer(1));
  const { file } = await cappedPass(x, lines, scriptOrAnswer);
  await rm(file.path);
  await x.service.migrateGaps({ pauseMs: 0 });
  const { record, open } = await openGaps(x);
  expect(open.some((gap) => gap.text.startsWith("Capture gap (long_line)"))).toBe(false);
  // The single recorded answer cannot be counted: it stays as it was.
  expect(open.filter((gap) => gap.text.includes("agent_message")).map((gap) => [gap.count, gap.text])).toEqual([[undefined, "Capture gap (unknown_response_type): agent_message. This content was not preserved."]]);
  expect(note(record)).toMatch(/an older build stopped recording after 100 gaps per capture pass in session #1 \(w1\) and that session's provider history could not be read: its groups say "at least", and lines over 256 KiB it skipped and other kinds past that cap may be missing/);
});

test("a capped session whose legacy gaps name an earlier epoch of the file: its history no longer holds what that build read, so nothing is counted there", async () => {
  const x = await migrationFixture(["card-a"]); dirs.push(x.dir);
  const lines: unknown[] = [{ timestamp: stamp, type: "session_meta", payload: { id: sid } }];
  for (let n = 0; n < 120; n++) lines.push(exec(n));
  lines.push(output("big"));
  const file = await rollout(x.dir, lines), base = file.identity.replace(/:0$/, ""), later = `${base}:1`;
  // The older build read epoch 0 (its usage records name it), then the file was rewritten in place and it read epoch 1.
  const entries = [...Array.from({ length: 30 }, (_, n) => legacyGap("w1", "type", "unknown_record_type", 10 + n, { session: sid, file: `${base}:0`, hint: "token_usage_record" })),
    ...Array.from({ length: 70 }, (_, n) => legacyGap("w1", "opaque", "opaque_tool_background", file.offsets[1 + n], { session: sid, file: later }))];
  await legacyPass(x.dir, "card-a", session("w1", 1, "implementer"), entries, { path: file.path, identity: later, offset: file.size, size: file.size }, 51);
  await x.service.migrateGaps({ pauseMs: 0 });
  const { record, open } = await openGaps(x);
  expect(open.find((gap) => gap.text.startsWith("Capture gap (opaque_tool_background)"))!.text).toMatch(/^Capture gap \(opaque_tool_background\): at least 70 script or workflow calls/);
  expect(open.some((gap) => gap.text.startsWith("Capture gap (long_line)"))).toBe(false);
  expect(note(record)).toMatch(/session #1 \(w1\) and that session's provider history could not be read/);
});

test("the text of a listed long line ends whole within 300 characters, at the largest offsets, type hints and message ids", () => {
  const agentId = "7c089b5c-83a7-40bd-ab45-e184c9ca67e4", sessions = new Map([[agentId, { n: 99, provider: "codex" }]]);
  const hint = `${"a".repeat(80)}/${"b".repeat(80)}/${"c".repeat(80)} (assistant)`, end = 256 * 2 ** 20;
  for (const count of [9, 99_999]) {
    const lines = Array.from({ length: count }, (_, n) => ({ start: end - (n + 1) * 300, end: end - n * 300, hint, messageId: "m".repeat(200), at: stamp }));
    const plan = planGapMigration([], sessions, { measures: new Map(), capped: [{ agentId, file: "1:2:3.4:0", read: true, lines }] });
    expect(plan.added.map((gap) => gap.count)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, count - 8]);
    for (const gap of plan.added) {
      expect(gap.text.length).toBeLessThanOrEqual(300);
      expect(gap.text).toMatch(/holds (?:it|them)\.$/);
    }
  }
});
