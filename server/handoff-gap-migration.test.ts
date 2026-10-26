import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { handoffOpenIds, type CardHandoff, type HandoffGap } from "../shared/handoff";
import { handoffRefusalFingerprint } from "./handoff-requirements";
import { handoffSource } from "./handoff-source";
import { captureTimeline } from "./handoff-capture";
import { CaptureRecords } from "./handoff-capture-records";
import { bodyReferences } from "./handoff-collect-fixture";
import { at, flowly, legacyGap, many, migrationFixture, session } from "./handoff-gap-migration-fixture";
import { gapMetadataV2 } from "./handoff-gap-migration";

// The one-time migration of the gaps older builds (684a8fd, 786d9cd) wrote once per occurrence (SESSION-HANDOFF-SPEC
// §21.17): metadata kinds are closed with the reason in their history, a session's per-call opaque_tool_background gaps
// become one gap to acknowledge once, identical duplicates are grouped, and every other gap is left as it was.
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const fixture = async (cards?: string[]) => { const x = await migrationFixture(cards); dirs.push(x.dir); return x; };

/** Every gap of the card (current list and the bodies its overflow index names), by id. */
async function gaps(x: Awaited<ReturnType<typeof fixture>>, card = "card-a") {
  const record = await x.service.records.read(card, "project"), all = new Map<string, HandoffGap>();
  for (const gap of record.gaps) all.set(gap.id, gap);
  for (const entry of record.overflow.filter((e) => e.section === "gaps")) {
    const page = await x.service.records.page(card, { entryId: entry.id });
    all.set(entry.id, page.items[0].value as HandoffGap);
  }
  return { record, all };
}
/** The latest version of any gap, archived ones too. */
const version = async (x: Awaited<ReturnType<typeof fixture>>, id: string, card = "card-a") => (await x.service.records.page(card, { entryId: id })).items[0].value as HandoffGap;
const openGapIds = (record: CardHandoff) => handoffOpenIds(record).filter((id) => id.startsWith("g:"));

/** Every legacy kind the live board holds, plus the ones the v2 rules leave open, over three sessions and the timeline. */
async function mixed(x: Awaited<ReturnType<typeof fixture>>) {
  const records = x.service.records;
  await records.setSession("card-a", "project", session("w1", 1, "implementer"), { ...flowly, sourceId: "session:w1" });
  await records.setSession("card-a", "project", session("w2", 2, "reviewer"), { ...flowly, sourceId: "session:w2" });
  await records.setSession("card-a", "project", session("w3", 3, "manual", "claude"), { ...flowly, sourceId: "session:w3" });
  const metadata = [
    ...many(30, (n) => legacyGap("w1", "type", "unknown_record_type", 1000 + n, { hint: "token_usage_record" })),
    ...many(3, (n) => legacyGap("w1", "type", "unknown_record_type", 2000 + n, { hint: "world_state" })),
    ...many(2, (n) => legacyGap("w1", "type", "unknown_record_type", 2100 + n, { hint: "inter_agent_communication_metadata" })),
    ...many(4, (n) => legacyGap("w1", "event", "unknown_event_type", 2200 + n, { hint: "thread_settings_applied" })),
    ...many(5, (n) => legacyGap("w2", "type", "unknown_record_type", 3000 + n, { hint: "token_usage_record" })),
    ...many(2, (n) => legacyGap("w3", "type", "unknown_record_type", 4000 + n, { hint: "cost-state", provider: "claude" })),
    legacyGap("w1", "timeline", "unknown_timeline_type", 5000, { hint: "todo" }),
  ];
  const opaque = [...many(25, (n) => legacyGap("w1", "opaque", "opaque_tool_background", 6000 + n)), ...many(5, (n) => legacyGap("w2", "opaque", "opaque_tool_background", 7000 + n))];
  const duplicates = [...many(3, (n) => legacyGap("w1", "response", "unknown_response_type", 8000 + n, { hint: "agent_message" })), ...many(2, (n) => legacyGap("w3", "type", "unknown_record_type", 8100 + n, { hint: "attachment", provider: "claude" }))];
  const kept = [
    legacyGap("w1", "long", "long_line", 9000, { hint: "event_msg/item_completed", bytes: [9000, 400000] }),
    legacyGap("w1", "long", "long_line", 9001, { hint: "event_msg/item_completed", bytes: [500000, 900000] }),
    legacyGap("w1", "handle", "background_handle_unknown", 9002),
    legacyGap("w1", "event", "unknown_event_type", 9003, { hint: "thread_goal_updated" }),
    legacyGap("w1", "timeline", "unknown_timeline_type", 9004, { hint: "plugin" }),
  ];
  // Interleaved as the polls wrote them, so metadata, scripts and real gaps are both in the current list and in the overflow.
  const legacy = [...metadata, ...opaque, ...duplicates, ...kept].sort((a, b) => a.value.sourceId.localeCompare(b.value.sourceId));
  await x.write("card-a", legacy);
  // Gaps the migration must not touch: a Flowly coverage gap, the current capture's grouped gap, the successor's own gap.
  const coverage = { section: "gaps" as const, value: { id: `g:${sha("git-coverage:card-a:1").slice(0, 32)}`, sourceId: "git-coverage:card-a:1", kind: "flowly", agentId: "w1", text: "1 repository locations were not inspected. Git coverage is partial; verify the remaining directories.", status: "open" } };
  const groupedSource = handoffSource("capture-gaps:w1:unknown_event_type\0future_event");
  await records.capture("card-a", "project", { entries: [coverage], gaps: [{ id: `g:${sha(groupedSource).slice(0, 32)}`, sourceId: groupedSource, agentId: "w1", text: "Capture gap (unknown_event_type): future_event. This content was not preserved; count, firstAt and lastAt cover every occurrence in this session.", count: 3, firstAt: at, lastAt: at }] }, flowly);
  const revision = (await records.read("card-a", "project")).revision;
  await records.update("card-a", "project", { handoffRevision: revision, gaps: [{ text: "The predecessor never said which fixture it used.", status: "open" }] }, { by: { kind: "agent", agentId: "w2" } });
  return { metadata, opaque, duplicates, kept: [...kept.map((entry) => entry.value.id), coverage.value.id, `g:${sha(groupedSource).slice(0, 32)}`] };
}

test("legacy gaps of every kind: metadata closed with the reason, scripts grouped per session, duplicates grouped, the rest untouched, in one revision", async () => {
  const x = await fixture(["card-a"]), legacy = await mixed(x);
  await x.service.syncIndex("card-a");
  const before = await gaps(x), successorGap = [...before.all.values()].find((gap) => gap.by.kind === "agent")!;
  const untouched = [...legacy.kept, successorGap.id];
  expect(openGapIds(before.record)).toHaveLength(90);
  expect(before.record.overflow.filter((entry) => entry.section === "gaps").length).toBeGreaterThan(40);

  await x.service.migrateGaps({ pauseMs: 0 });
  const after = await gaps(x);
  expect(after.record.revision).toBe(before.record.revision + 1);

  // Metadata: closed, text and source kept, the reason and the first time in the closed version.
  for (const { value } of legacy.metadata) {
    const closed = await version(x, value.id);
    expect(closed).toMatchObject({ text: value.text, sourceId: value.sourceId, at, status: "closed", rev: after.record.revision, resolution: { by: { kind: "flowly" }, at: after.record.updatedAt, note: "classified as metadata by capture rules v2" } });
  }
  // Scripts: one open gap per session that counts them and says why; each legacy entry closed into it.
  const groups = [...after.all.values()].filter((gap) => gap.sourceId?.startsWith("legacy-gaps:"));
  const group = (agentId: string, kind: string) => groups.find((gap) => gap.agentId === agentId && gap.text.startsWith(`Capture gap (${kind})`))!;
  expect(groups.map((gap) => [gap.agentId, gap.text.split(")")[0], gap.count, gap.status]).sort()).toEqual([
    ["w1", "Capture gap (opaque_tool_background", 25, "open"], ["w1", "Capture gap (unknown_response_type", 3, "open"],
    ["w2", "Capture gap (opaque_tool_background", 5, "open"], ["w3", "Capture gap (unknown_record_type", 2, "open"]]);
  expect(group("w1", "opaque_tool_background").text).toMatch(/25 script or workflow calls of session #1 \(w1\) predate/);
  expect(group("w1", "opaque_tool_background").text.length).toBeLessThanOrEqual(300);
  for (const { value } of [...legacy.opaque, ...legacy.duplicates]) {
    const closed = await version(x, value.id), into = group(value.agentId, value.text.slice("Capture gap (".length).split(")")[0]);
    expect(closed).toMatchObject({ text: value.text, at, status: "closed", resolution: { by: { kind: "flowly" }, note: `grouped by capture rules v2 into ${into.id}` } });
  }
  // Everything else is exactly as it was (current entries and overflow index entries alike).
  for (const id of untouched) {
    const old = before.record.gaps.find((gap) => gap.id === id) ?? before.record.overflow.find((entry) => entry.id === id);
    expect(after.record.gaps.find((gap) => gap.id === id) ?? after.record.overflow.find((entry) => entry.id === id)).toEqual(old);
  }
  expect(openGapIds(after.record).sort()).toEqual([...untouched, ...groups.map((gap) => gap.id)].sort());
  // Closed legacy entries leave the current record and its overflow index (they no longer count for the delivery gate);
  // each closed version is one archive line, and no body any file names is missing.
  const closedIds = new Set([...legacy.metadata, ...legacy.opaque, ...legacy.duplicates].map(({ value }) => value.id));
  expect([...after.record.gaps, ...after.record.overflow].some((entry) => closedIds.has(entry.id))).toBe(false);
  const lines = (await readFile(join(x.handoffs, "card-a", "archive.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { id: string; rev: number });
  for (const id of closedIds) expect(lines.filter((line) => line.id === id && line.rev === after.record.revision)).toHaveLength(1);
  expect((await bodyReferences(x.handoffs, "card-a")).missing).toEqual([]);
  // One Flowly note says what happened; the board index counts what is open now.
  expect(after.record.notes.filter((note) => note.text.startsWith("Capture rules v2"))).toHaveLength(1);
  expect(after.record.notes.find((note) => note.text.startsWith("Capture rules v2"))!.text).toMatch(/closed 47 .*metadata.*30 per-call opaque_tool_background gaps.*2 grouped gaps.*5 identical gaps into 2/s);
  const index = (await x.board.read()).handoffIndex.find((entry) => entry.taskId === "card-a")!;
  expect(index.open).toBe(handoffOpenIds(after.record).length);
  expect(index.open).toBe(untouched.length + groups.length);
  // A second run changes nothing: same revision, same delivery-gate fingerprint.
  const fingerprint = handoffRefusalFingerprint(after.record);
  await x.service.migrateGaps({ pauseMs: 0 });
  const again = await x.service.records.read("card-a", "project");
  expect(again.revision).toBe(after.record.revision); expect(handoffRefusalFingerprint(again)).toBe(fingerprint);
});

test("acknowledgements already given stay as they were; a session's group counts only what is still open", async () => {
  const x = await fixture(["card-a"]), records = x.service.records;
  await records.setSession("card-a", "project", session("old", 1, "implementer"), { ...flowly, sourceId: "session:old" });
  await records.setSession("card-a", "project", session("rev", 2, "reviewer"), { ...flowly, sourceId: "session:rev" });
  await records.setSession("card-a", "project", session("successor", 3, "implementer"), { ...flowly, sourceId: "session:successor" });
  const opaque = many(6, (n) => legacyGap("old", "opaque", "opaque_tool_background", 100 + n)), tokens = many(4, (n) => legacyGap("old", "type", "unknown_record_type", 200 + n, { hint: "token_usage_record" }));
  const reviewer = many(2, (n) => legacyGap("rev", "opaque", "opaque_tool_background", 300 + n));
  await x.write("card-a", [...opaque, ...tokens, ...reviewer]);
  const read = await records.read("card-a", "project"), note = "checked: the session ended a day ago, nothing runs";
  const ack = await records.update("card-a", "project", { handoffRevision: read.revision, ack: { handoffRevision: read.revision, heads: [], understanding: "Continuing from the reviewer's last round.", items: [
    ...opaque.slice(0, 3).map(({ value }) => ({ id: value.id, disposition: "done" as const, note })), { id: tokens[0].value.id, disposition: "obsolete" as const, note: "usage metadata" },
    { id: opaque[3].value.id, disposition: "doing" as const }, { id: tokens[1].value.id, disposition: "ask" as const },
    ...reviewer.map(({ value }) => ({ id: value.id, disposition: "obsolete" as const, note })),
  ] } }, { by: { kind: "agent", agentId: "successor" } }, { agentId: "successor", actualHeads: [] });
  expect(ack.ackMissing?.length).toBeGreaterThan(0);
  const acknowledged = [...opaque.slice(0, 3), tokens[0], ...reviewer].map(({ value }) => value.id);
  const settled = new Map(await Promise.all(acknowledged.map(async (id) => [id, await version(x, id)] as const)));
  const before = await records.read("card-a", "project"), ledger = before.ledger.find((entry) => entry.agentId === "successor")!;
  expect(ledger.ack?.complete).toBe(false);

  await x.service.migrateGaps({ pauseMs: 0 });
  const after = await records.read("card-a", "project");
  for (const [id, value] of settled) expect(await version(x, id)).toEqual(value);
  // The same entry (its body may be rewritten in schema key order by the next revision, as by any write).
  const { contentRef: _before, ...acknowledgement } = ledger, { contentRef: _after, ...kept } = after.ledger.find((entry) => entry.agentId === "successor")!;
  expect(kept).toEqual(acknowledgement);
  const groups = after.gaps.filter((gap) => gap.sourceId?.startsWith("legacy-gaps:"));
  expect(groups.map((gap) => [gap.agentId, gap.count])).toEqual([["old", 3]]);
  expect(groups[0].text).toMatch(/3 script or workflow calls of session #1/);
  for (const { value } of tokens.slice(1)) expect(await version(x, value.id)).toMatchObject({ status: "closed", resolution: { by: { kind: "flowly" } } });
  for (const { value } of opaque.slice(3)) expect(await version(x, value.id)).toMatchObject({ status: "closed", resolution: { note: expect.stringContaining(groups[0].id) } });
  // What is left is one id: the successor acknowledges it once and its acknowledgement is complete.
  expect(handoffOpenIds(after)).toEqual([groups[0].id]);
  const done = await records.update("card-a", "project", { handoffRevision: after.revision, ack: { handoffRevision: after.revision, heads: [], understanding: "Continuing from the reviewer's last round.", items: [{ id: groups[0].id, disposition: "obsolete", note }] } }, { by: { kind: "agent", agentId: "successor" } }, { agentId: "successor", actualHeads: [] });
  expect(done.ackMissing).toBeUndefined();
  expect((await records.read("card-a", "project")).ledger.find((entry) => entry.agentId === "successor")?.ack?.complete).toBe(true);
});

test("a reader paging the older revision is told its view changed, and every body it could page is still there", async () => {
  const x = await fixture(["card-a"]);
  await x.service.records.setSession("card-a", "project", session("w1", 1, "implementer"), { ...flowly, sourceId: "session:w1" });
  await x.write("card-a", [...many(120, (n) => legacyGap("w1", "type", "unknown_record_type", n, { hint: "token_usage_record" })), ...many(60, (n) => legacyGap("w1", "opaque", "opaque_tool_background", 1000 + n))]);
  const first = await x.service.records.page("card-a", { scope: "all" });
  expect(first.nextCursor).toBeTruthy();
  await x.service.migrateGaps({ pauseMs: 0 });
  const next = await x.service.records.page("card-a", { cursor: first.nextCursor });
  expect(next).toMatchObject({ viewChanged: true, items: [] });
  expect((await bodyReferences(x.handoffs, "card-a")).missing).toEqual([]);
  // A fresh full read completes; each migrated gap's closed version is in it.
  let page = await x.service.records.page("card-a", { scope: "all" }); const seen = new Map<string, string>();
  for (let n = 0; ; n++) {
    for (const item of page.items) if (item.section === "gaps" && item.value) seen.set(item.id, (item.value as HandoffGap).status);
    if (!page.nextCursor) break;
    expect(n).toBeLessThan(100); page = await x.service.records.page("card-a", { cursor: page.nextCursor });
  }
  expect(page.complete).toBe(true);
  expect(page.openIdsTotal).toBe(1);
});

test("the migration waits for the card's queue: a turn's capture in progress finishes first and is kept", async () => {
  const x = await fixture(["card-a"]), records = x.service.records;
  await records.setSession("card-a", "project", session("w1", 1, "implementer"), { ...flowly, sourceId: "session:w1" });
  await x.write("card-a", many(5, (n) => legacyGap("w1", "type", "unknown_record_type", n, { hint: "world_state" })));
  const start = (await records.read("card-a", "project")).revision;
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  let inside = -1;
  // A turn's transaction in the card's queue (the observer's capture runs there): the migration must not land inside it.
  const turn = x.service.serial("card-a", async () => {
    await held;
    inside = (await records.read("card-a", "project")).revision;
    await records.capture("card-a", "project", { entries: [legacyGap("w1", "type", "unknown_record_type", 99, { hint: "token_usage_record" })] }, flowly);
  });
  const migration = x.service.migrateGaps({ pauseMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await records.read("card-a", "project")).revision).toBe(start);
  release(); await turn; await migration;
  expect(inside).toBe(start);
  const after = await records.read("card-a", "project");
  // The turn's write came first (start + 1); the migration then closed all six in one revision.
  expect(after.revision).toBe(start + 2);
  expect(openGapIds(after)).toEqual([]);
});

test("an open gap left only in the overflow index still makes the card need checking", async () => {
  const x = await fixture(["card-a"]);
  await x.service.records.setSession("card-a", "project", session("w1", 1, "implementer"), { ...flowly, sourceId: "session:w1" });
  const coverage = { section: "gaps" as const, value: { id: "g:coverage", sourceId: "git-coverage:card-a:2", kind: "flowly", agentId: "w1", text: "1 repository locations were not inspected. Git coverage is partial; verify the remaining directories.", status: "open" } };
  await x.write("card-a", [coverage as never, ...many(45, (n) => legacyGap("w1", "type", "unknown_record_type", n, { hint: "token_usage_record" }))]);
  await x.service.migrateGaps({ pauseMs: 0 });
  const record = await x.service.records.read("card-a", "project");
  expect(record.gaps.some((gap) => gap.status === "open")).toBe(false);
  expect(record.overflow.filter((entry) => entry.section === "gaps").map((entry) => entry.id)).toEqual(["g:coverage"]);
  const index = (await x.board.read()).handoffIndex.find((entry) => entry.taskId === "card-a")!;
  expect(index).toMatchObject({ open: 1, fresh: false, behind: "unverified" });
});

test("what capture rules v2 close as metadata is metadata for the current capture: it raises no gap", () => {
  const codex = "019a15e5-0000-7abc-8def-0123456789ab", stamp = "2026-10-25T02:00:00.000Z";
  const records = (provider: "codex" | "claude", lines: unknown[]) => {
    const capture = new CaptureRecords("agent", stamp);
    for (const [n, line] of lines.entries()) capture.providerLine(provider, Buffer.from(JSON.stringify(line)), { agentId: "agent", provider, sessionId: provider === "codex" ? codex : "claude-session", fileId: "f", offset: n * 100, end: n * 100 + 99 });
    return capture.result;
  };
  const usage = () => ({ input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 });
  const codexRecord = (type: string) => type === "token_usage_record"
    ? { timestamp: stamp, ordinal: 1, type, payload: { thread_id: codex, turn_id: "t", session_id: codex, root_turn_id: "t", response_id: "r", usage: usage(), turn_token_usage: usage(), thread_token_usage: usage() } }
    : { timestamp: stamp, type, payload: {} };
  expect(records("codex", [...gapMetadataV2.unknown_record_type.codex].map(codexRecord)).gaps).toEqual([]);
  expect(records("codex", [...gapMetadataV2.unknown_event_type.codex].map((type) => ({ timestamp: stamp, type: "event_msg", payload: { type } }))).gaps).toEqual([]);
  expect(records("claude", [...gapMetadataV2.unknown_record_type.claude].map((type) => ({ type, sessionId: "claude-session", timestamp: stamp, uuid: `u-${type}` }))).gaps).toEqual([]);
  expect(captureTimeline("agent", [...gapMetadataV2.unknown_timeline_type.timeline].map((type) => ({ type, status: "loading" })), { outcome: "completed" }).gaps).toEqual([]);
  // And what they leave open is still a gap or captured content today, never silently metadata.
  expect(records("codex", [{ timestamp: stamp, type: "event_msg", payload: { type: "thread_goal_updated", goal: { objective: "Keep the API" } } }]).inputs).toHaveLength(1);
  expect(records("claude", [{ type: "attachment", sessionId: "claude-session", timestamp: stamp, uuid: "a1", attachment: { type: "queued_command", prompt: "do not deploy" } }]).inputs).toHaveLength(1);
});
