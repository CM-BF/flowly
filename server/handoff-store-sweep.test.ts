import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HandoffService } from "./handoff-service";
import { BoardStore } from "./store";
import { bodyName, bodyReferences, tree } from "./handoff-collect-fixture";
import type { HandoffContext } from "./handoff-store";

// Plugin start collects every card once (SESSION-HANDOFF-SPEC §5.1), also cards nothing opens, polls or writes again (done
// or stopped cards): what older versions left there would otherwise stay for good. Once per collection version, recorded in
// plugin data; one card at a time in its own queue. Temporary directories only; the board is never written.
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const flowly: HandoffContext = { by: { kind: "flowly" } };
const at = "2026-10-25T02:00:00.000Z";
const session = { agentId: "worker", sourceId: "session:worker", n: 1, role: "implementer" as const, provider: "codex", reason: "replacement", startedAt: at, finalized: false, turns: [], background: [], live: [] };
const cards = ["0c1f6f2e-4a55-4b8e-9c55-3b9e2f6c1a01", "7d2a9b10-1f3c-4e7a-8b21-5c6d7e8f9a02"];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "flowly-handoff-sweep-")); folders.push(dir);
  const handoffs = join(dir, "handoffs"), service = new HandoffService(new BoardStore(dir));
  for (const card of cards) {
    await service.records.setSession(card, "project", session, { ...flowly, sourceId: "session:worker" });
    for (let n = 0; n < 3; n++) await service.records.appendNote(card, "project", { kind: "background", text: `Note ${n}` }, { ...flowly, sourceId: `note:${n}` });
  }
  /** What an older version left: bodies of the card's ledger entry at earlier revisions, which nothing references. */
  const orphans = async (card: string, count: number) => {
    const record = (await service.records.read(card))!, { contentRef: _, ...plain } = record.ledger[0], names: string[] = [];
    for (let n = 0; n < count; n++) { const body = JSON.stringify({ ...plain, rev: 0, measured: { C: n, turns: 0 } }), ref = bodyName(body); await writeFile(join(handoffs, card, "entries", `${ref}.json`), body); names.push(ref); }
    return names;
  };
  const start = () => new HandoffService(new BoardStore(dir));
  return { dir, handoffs, service, orphans, start };
}

test("plugin start collects every card once, cards nothing touches too; a later start reads and writes nothing", async () => {
  const { handoffs, orphans, start } = await fixture();
  for (const card of cards) expect(await orphans(card, 5)).toHaveLength(5);
  for (const card of cards) expect((await bodyReferences(handoffs, card)).unreferenced).toHaveLength(5);
  // A new process: nothing opens, polls or writes these cards.
  await start().sweepBodies({ delayMs: 0, pauseMs: 0 });
  for (const card of cards) {
    const references = await bodyReferences(handoffs, card);
    expect(references.unreferenced).toEqual([]); expect(references.missing).toEqual([]);
  }
  expect(JSON.parse(await readFile(join(handoffs, ".collected.json"), "utf8"))).toMatchObject({ version: 1 });
  // A later start with the sweep recorded: nothing is collected (that card's next touch does it), nothing is written.
  const left = await orphans(cards[0], 1), files = await tree(handoffs);
  await start().sweepBodies({ delayMs: 0, pauseMs: 0 });
  expect(await tree(handoffs)).toEqual(files);
  expect((await bodyReferences(handoffs, cards[0])).unreferenced).toEqual(left);
});

test("a sweep the plugin's stop interrupts records nothing; the next start sweeps again", async () => {
  const { handoffs, orphans, start } = await fixture();
  for (const card of cards) await orphans(card, 2);
  const stopped = start(), sweep = stopped.sweepBodies({ delayMs: 60_000, pauseMs: 0 });
  stopped.stop(); await sweep;
  expect(await readdir(handoffs)).not.toContain(".collected.json");
  for (const card of cards) expect((await bodyReferences(handoffs, card)).unreferenced).toHaveLength(2);
  await start().sweepBodies({ delayMs: 0, pauseMs: 0 });
  for (const card of cards) expect((await bodyReferences(handoffs, card)).unreferenced).toEqual([]);
  expect(await readdir(handoffs)).toContain(".collected.json");
});
