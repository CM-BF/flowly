import { afterEach, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HandoffPage, HandoffSession } from "../shared/handoff";
import { cleanupObserverFixtures, codexResponse, observerFixture } from "./handoff-observer-fixture";
import type { HandoffStore } from "./handoff-store";

// Every turn end adds a turn to its session's ledger entry (at most 10 kept). Archiving the whole entry at each turn end made
// the successor's required full read return every copy: about one page per 3-4 turns, one final up to 15 times
// (SESSION-HANDOFF-SPEC §5.1). Each finished turn is archived once. In-memory Paseo fake and a temporary directory only.
afterEach(cleanupObserverFixtures);

const final = (n: number) => `Turn ${n} done. ${"Details of what was changed and verified in this turn. ".repeat(25)}`;
async function fullRead(records: HandoffStore) {
  const pages: HandoffPage[] = []; let cursor: string | undefined;
  do { const page = await records.page("card", cursor ? { cursor } : { scope: "all" }); pages.push(page); cursor = page.nextCursor; } while (cursor);
  expect(pages.at(-1)!.complete).toBe(true);
  return pages;
}
async function archivedLedger(records: HandoffStore) {
  const text = await readFile(join(records.root, "card", "archive.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { section: string }).filter((pointer) => pointer.section === "ledger").length;
}
const finals = (pages: HandoffPage[]) => pages.flatMap((page) => page.items).flatMap((item) => item.section === "ledger" && item.value ? (item.value as HandoffSession).turns.map((turn) => turn.n) : []);

test("sixty turn ends archive each finished turn once: the full read returns every final at most twice and stays small", async () => {
  const x = await observerFixture();
  await x.poll();
  const start = await fullRead(x.records);
  for (let turn = 1; turn <= 60; turn++) {
    // A background server started in turn 35 and stopped in turn 38: history other than turns still archives a version.
    if (turn === 35) await x.append([codexResponse("function_call", { name: "exec_command", call_id: "serve", arguments: JSON.stringify({ cmd: "npm run dev" }) }), codexResponse("function_call_output", { call_id: "serve", output: "Process running with session ID 4100" })]);
    if (turn === 38) await x.append([codexResponse("function_call", { name: "write_stdin", call_id: "stop", arguments: JSON.stringify({ session_id: 4100, chars: "\u0003" }) }), { timestamp: "2026-10-25T02:00:00.000Z", type: "event_msg", payload: { type: "item_completed", thread_id: "t", turn_id: "t", item: { type: "CommandExecution", id: "ce-4100", command: ["bash", "-lc", "npm run dev"], process_id: 4100, exit_code: 130, aggregated_output: "" } } }]);
    await x.hook([{ type: "user_message", text: `Turn ${turn}: continue`, messageId: `m-${turn}` }, { type: "assistant_message", text: final(turn) }]);
  }
  const pages = await fullRead(x.records), counted = finals(pages);
  // Every turn is in the read (archived once, or still in the current 10-turn window), none more than twice.
  expect(new Set(counted)).toEqual(new Set(Array.from({ length: 60 }, (_, n) => n + 1)));
  expect(Math.max(...Array.from({ length: 60 }, (_, n) => counted.filter((value) => value === n + 1).length))).toBeLessThanOrEqual(2);
  // As text: a turn that left the window is in the read once (its archived turn); a recent one also in the current preview.
  const text = JSON.stringify(pages);
  for (let turn = 1; turn <= 50; turn++) expect({ turn, copies: text.split(`Turn ${turn} done.`).length - 1 }).toEqual({ turn, copies: 1 });
  // One archived version per 10 turns, plus the server's start and end.
  expect(await archivedLedger(x.records)).toBeLessThanOrEqual(8);
  expect(pages.length - start.length).toBeLessThanOrEqual(3);
  expect((await x.read()).ledger[0].background).toEqual([expect.objectContaining({ ref: "4100", status: "closed" })]);
}, 60_000);
