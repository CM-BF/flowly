/**
 * Cost of routine observation and of skipped content (review round 2, noise-r2-1/2/3): an idle poll writes nothing, long
 * tool-output lines are one counted gap, the required full read skips Flowly's own observation snapshots. Every text is synthetic.
 */
import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handoffOpenIds, type CardHandoff, type HandoffSession } from "../shared/handoff";
import type { HandoffStore } from "./handoff-store";
import { claudeBase, cleanupObserverFixtures, codexEvent, codexItem, codexResponse, codexTyped, observerFixture } from "./handoff-observer-fixture";

afterEach(cleanupObserverFixtures);
const files = (path: string) => readdir(path).then((names) => names.length, () => 0);

test("a poll with no new provider data writes nothing: the revision stays and an ACK prepared before it still succeeds", async () => {
  const x = await observerFixture();
  await x.append([codexEvent("task_started", { turn_id: "t" }), codexTyped("01a170bb-0001", "Keep the old endpoint"), codexEvent("future_event"), codexEvent("task_complete", { turn_id: "t" })]);
  await x.poll();
  const read1 = await x.read(), folder = join(x.records.root, "card");
  expect(handoffOpenIds(read1)).toHaveLength(2);
  const before = { entries: await files(join(folder, "entries")), ops: await files(join(folder, "ops")) };
  for (let n = 0; n < 3; n++) await x.poll(); // the rollout did not grow
  const read2 = await x.read();
  expect(read2.revision).toBe(read1.revision);
  expect({ entries: await files(join(folder, "entries")), ops: await files(join(folder, "ops")) }).toEqual(before);
  const result = await x.ack("obsolete", "checked", () => true, read1);
  expect(result.ackMissing).toBeUndefined();
  const after = await x.read();
  expect(after.ledger[0].ack).toMatchObject({ complete: true });
  expect(after.gaps).toEqual([expect.objectContaining({ status: "closed" })]);
});

// ---------------------------------------------------------------- long lines: a person's words stay located, tool output is one counted gap (noise-r2-2)
const command = (n: number) => codexItem({ type: "CommandExecution", id: `exec-${n}`, process_id: String(5000 + n), command: ["/bin/zsh", "-lc", "npm test"], status: "completed", exit_code: 0, aggregated_output: "x".repeat(3000) });
const paste = (n: number) => codexEvent("user_message", { message: `synthetic long paste ${n} ${"y".repeat(3000)}`, message_id: `msg-long-${n}` });

test("long tool-output lines are one counted gap that names the item type and lists where the first ones are", async () => {
  const x = await observerFixture({ maxLineBytes: 2048 });
  await x.append(Array.from({ length: 10 }, (_, n) => command(n))); await x.poll();
  let open = (await x.read()).gaps.filter((gap) => gap.status === "open");
  expect(open).toEqual([expect.objectContaining({ count: 10, text: expect.stringMatching(/^Capture gap \(long_line\): event_msg\/item_completed\/CommandExecution \(tool output\), first ones in bytes \d+–\d+, \d+–\d+, \d+–\d+/) })]);
  await x.append(Array.from({ length: 10 }, (_, n) => command(10 + n))); await x.poll();
  open = (await x.read()).gaps.filter((gap) => gap.status === "open");
  expect(open).toEqual([expect.objectContaining({ count: 20 })]);
  // Lines that can hold a person's words keep one located gap each, also mixed in with tool output.
  await x.append([command(30), paste(1), command(31)]); await x.poll();
  const located = (await x.read()).gaps.filter((gap) => gap.text.includes("msg-long-1"));
  expect(located).toEqual([expect.objectContaining({ count: 1, text: expect.stringMatching(/^Capture gap \(long_line\) in bytes \d+–\d+: event_msg\/user_message, message msg-long-1, \d+ bytes\./) })]);
  expect((await x.read()).gaps.filter((gap) => gap.status === "open")).toHaveLength(2);
});

test("past eight located long human lines, the rest are one gap labelled with their real type and counted by occurrence", async () => {
  const x = await observerFixture({ maxLineBytes: 2048 });
  await x.append(Array.from({ length: 12 }, (_, n) => paste(n))); await x.poll();
  const gaps = (await x.read()).gaps;
  expect(gaps.filter((gap) => /^Capture gap \(long_line\) in bytes/.test(gap.text))).toHaveLength(8);
  const overflow = gaps.filter((gap) => !/^Capture gap \(long_line\) in bytes/.test(gap.text));
  expect(overflow).toEqual([expect.objectContaining({ count: 4, text: expect.stringMatching(/^Capture gap \(long_line\): event_msg\/user_message\. More than 8 occurred; each earlier one is its own gap; these start in bytes \d+–\d+/) })]);
  expect(overflow[0].text).not.toContain("other types");
});

test("a Claude tool result over the line budget is tool output; a long typed Claude message keeps its own located gap", async () => {
  const x = await observerFixture({ provider: "claude", maxLineBytes: 2048 });
  const result = (n: number) => ({ ...claudeBase, type: "user", uuid: `u-${n}`, message: { role: "user", content: [{ tool_use_id: `tu-${n}`, type: "tool_result", content: "z".repeat(3000) }] } });
  await x.append([result(1), result(2), { ...claudeBase, type: "user", uuid: "typed-1", message: { role: "user", content: `please read this carefully ${"w".repeat(3000)}` } }]);
  await x.poll();
  const gaps = (await x.read()).gaps;
  expect(gaps).toEqual(expect.arrayContaining([
    expect.objectContaining({ count: 2, text: expect.stringMatching(/^Capture gap \(long_line\): user\/tool_result \(tool output\)/) }),
    expect.objectContaining({ count: 1, text: expect.stringMatching(/^Capture gap \(long_line\) in bytes \d+–\d+: user, message typed-1/) })]));
  expect(gaps).toHaveLength(2);
});

// ---------------------------------------------------------------- the required full read skips Flowly's observation snapshots (noise-r2-3)
/** Archive ledger versions the way 786d9cd did (every poll superseded the entry and archived the previous version). */
async function legacyArchive(root: string, versions: HandoffSession[]) {
  const folder = join(root, "card"), current = join(root, "card.json"), lines: string[] = [];
  await mkdir(join(folder, "entries"), { recursive: true });
  for (const [n, version] of versions.entries()) {
    const { contentRef: _, ...plain } = version, body = JSON.stringify(plain), ref = createHash("sha256").update(body).digest("hex");
    await writeFile(join(folder, "entries", `${ref}.json`), body);
    lines.push(JSON.stringify({ eventId: `legacy:${n}`, section: "ledger", id: version.id, ref, rev: version.rev, at: version.at, ...(version.sourceId ? { sourceId: version.sourceId } : {}) }) + "\n");
  }
  await appendFile(join(folder, "archive.jsonl"), lines.join(""));
  const record = JSON.parse(await readFile(current, "utf8")) as CardHandoff; record.archivedCount += versions.length;
  await writeFile(current, JSON.stringify(record));
}
async function fullRead(records: HandoffStore) {
  let page = await records.page("card", { scope: "all" }); const items = [...page.items];
  for (let n = 0; !page.complete && page.nextCursor && n < 100; n++) { page = await records.page("card", { cursor: page.nextCursor }); items.push(...page.items); }
  return { items, superseded: page.supersededSnapshots ?? 0, complete: page.complete };
}

test("the full read skips an archived ledger version whose history equals the next version's, and says how many", async () => {
  const x = await observerFixture(), versions: HandoffSession[] = [];
  for (let n = 0; n < 7; n++) {
    await x.append([codexEvent("token_count", { info: { last_token_usage: { total_tokens: 1000 + n } } }), ...(n === 3 ? [codexResponse("custom_tool_call", { call_id: "s1", name: "exec", input: "const r = await tools.exec_command({ cmd: \"npm run dev\" }); text(r);" }), codexResponse("custom_tool_call_output", { call_id: "s1", output: [{ type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text: JSON.stringify({ session_id: 4242 }) }] })] : [])]);
    await x.poll();
    versions.push((await x.read()).ledger[0]);
  }
  // The current code archived one version, when v4 opened the dev server (that version is v3). 786d9cd archived each of
  // the first six versions too; the seventh is current. Only v3 differs from the version after it.
  expect((await fullRead(x.records)).items.filter((item) => item.origin === "archive" && item.section === "ledger")).toHaveLength(1);
  await legacyArchive(x.records.root, versions.slice(0, 6));
  const after = await fullRead(x.records);
  const archived = after.items.filter((item) => item.origin === "archive" && item.section === "ledger");
  expect(archived.map((item) => (item.value as HandoffSession).rev)).toEqual([versions[2].rev]);
  expect(after.superseded).toBe(6); expect(after.complete).toBe(true);
  // Nothing was deleted: every archived body is still on disk.
  for (const version of versions.slice(0, 6)) { const { contentRef: _, ...plain } = version; await expect(readFile(join(x.records.root, "card", "entries", `${createHash("sha256").update(JSON.stringify(plain)).digest("hex")}.json`), "utf8")).resolves.toBe(JSON.stringify(plain)); }
});
