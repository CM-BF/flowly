import { afterEach, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { cleanupRunningFixtures, fullRead, handedOver } from "./handoff-running-fixture";

// A successor reads the card's full record and acknowledges it inside its own running turn: every page it reads and every
// check it runs is new data in its own provider file, observed by the 60-second pass (SESSION-HANDOFF-SPEC §5.1, §7.5).
// Production wiring on synthetic Codex rollouts and a real Git repository (server/handoff-running-fixture.ts).
afterEach(cleanupRunningFixtures);

test("a running successor's full read and ACK survive its own session being observed between every page and before the ACK", async () => {
  const x = await handedOver();
  const before = await x.read(), bytes = await readFile(x.file, "utf8");
  const pages = await fullRead(x, async (page) => {
    // Between pages: a Git check, a call still running when the pass lands, another card's commit in the shared root.
    await x.tool("exec_command", { cmd: "git rev-parse --short=12 HEAD && git status --porcelain" }, "Process exited with code 0\nOutput:\nabc\n");
    if (page === 1) await x.tool("exec_command", { cmd: "npm test" });
    if (page === 2) await x.elsewhere(page);
    await x.minute();
  });
  expect(pages.length).toBeGreaterThanOrEqual(3);
  expect(pages.map((page) => [page.revision, !!page.viewChanged])).toEqual(pages.map(() => [before.revision, false]));
  expect(pages.at(-1)!.complete).toBe(true);
  // The observation was stored (the successor's cursor moved, its call in flight and the new head are on the card) under the same revision.
  const observed = await x.read(), succ = observed.ledger.find((session) => session.agentId === "succ")!;
  expect(await readFile(x.file, "utf8")).not.toBe(bytes);
  expect(succ.through!.offset).toBeGreaterThan(before.ledger.find((session) => session.agentId === "succ")!.through!.offset);
  expect(succ.background.filter((item) => item.inFlight).map((item) => item.label)).toEqual(["npm test"]);
  expect(observed.git[0].sha).not.toBe(before.git[0].sha);
  expect(observed.revision).toBe(before.revision);
  // It verifies the heads (one more observed call), then acknowledges every id the read listed; its own call in flight is not one.
  const ids = [...new Set(pages.flatMap((page) => page.openIds))];
  expect(ids).toHaveLength(2);
  await x.tool("exec_command", { cmd: "git rev-parse --short=12 HEAD" }, "Process exited with code 0\nOutput:\nabc\n"); await x.minute();
  const result = await x.handoffs.update(x.identity, { handoffRevision: pages[0].revision, ack: { handoffRevision: pages[0].revision, heads: await x.heads(), understanding: "Read every page; heads verified.", items: ids.map((id) => ({ id, disposition: "doing" as const })) } });
  expect(result).toMatchObject({ ok: true, handoffRevision: before.revision + 1 });
  expect(result.ackMissing).toBeUndefined();
  expect((await x.read()).ledger.find((session) => session.agentId === "succ")!.ack).toMatchObject({ complete: true, recordRevision: before.revision + 1 });
}, 60_000);

test("a person's words arriving mid-read still change the view and refuse an ACK of the old revision", async () => {
  const x = await handedOver();
  const first = await fullRead(x, async (page) => {
    if (page === 1) await x.handoffs.recordInput({ ...x.identity, messageId: "m-mid-read", text: "Keep the old endpoint working until Friday.", via: "comment" });
    await x.minute();
  });
  expect(first.map((page) => !!page.viewChanged)).toEqual([false, true]);
  const stale = first[0].revision;
  await expect(x.handoffs.update(x.identity, { handoffRevision: stale, ack: { handoffRevision: stale, heads: await x.heads(), understanding: "Read page 1.", items: [] } })).rejects.toMatchObject({ code: "ACK_MISMATCH" });
  // Read again from page 1: complete, and it lists the new input; the ACK of that revision applies.
  const again = await fullRead(x, () => x.minute());
  expect(again.at(-1)!.complete).toBe(true);
  const revision = again[0].revision, input = (await x.read()).inputs.find((entry) => entry.messageId === "m-mid-read")!;
  expect(again.flatMap((page) => page.openIds)).toContain(input.id);
  const result = await x.handoffs.update(x.identity, { handoffRevision: revision, ack: { handoffRevision: revision, heads: await x.heads(), understanding: "Read again; keep the old endpoint.", items: [...new Set(again.flatMap((page) => page.openIds))].map((id) => ({ id, disposition: "doing" as const })) } });
  expect(result).toMatchObject({ ok: true }); expect(result.ackMissing).toBeUndefined();
}, 60_000);

test("a partial ACK is continued after its own session was observed", async () => {
  const x = await handedOver();
  // The successor starts a server before acknowledging: real background work (a new revision), listed with the two gaps.
  await x.tool("exec_command", { cmd: "./scripts/serve --port 4100" }, "Process running with session ID 7001");
  await x.minute();
  const read = await x.read(), [one, two, ...rest] = (await x.handoffs.context("card", "succ", { full: true })).page!.openIds;
  expect(rest).toEqual([expect.stringMatching(/^bg:/)]);
  const partial = await x.handoffs.update(x.identity, { handoffRevision: read.revision, ack: { handoffRevision: read.revision, heads: await x.heads(), understanding: "Two gaps handled.", items: [one, two].map((id) => ({ id, disposition: "done" as const, note: "Checked in the session history." })) } });
  expect(partial.ackMissing).toEqual(rest);
  await x.tool("exec_command", { cmd: "curl -s localhost:4100/health" }, "Process exited with code 0\nOutput:\nok\n"); await x.minute();
  const result = await x.handoffs.update(x.identity, { handoffRevision: partial.handoffRevision, ack: { handoffRevision: partial.handoffRevision, heads: await x.heads(), understanding: "The server is mine now.", items: rest.map((id) => ({ id, disposition: "doing" as const })) } });
  expect(result.ackMissing).toBeUndefined();
  expect((await x.read()).ledger.find((session) => session.agentId === "succ")!.ack).toMatchObject({ complete: true });
}, 60_000);
