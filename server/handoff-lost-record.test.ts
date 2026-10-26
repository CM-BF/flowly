import { afterEach, expect, test, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AutomationJob } from "../shared/automation";
import { handoffSignal } from "../client/handoff-signal";
import { agentFixture } from "./agent-fixture";
import { HandoffService } from "./handoff-service";
import { HandoffObserver } from "./handoff-observer";

// A lost or unreadable handoff record reaches the card face (the board's handoff index) through whatever meets it first:
// the observer's poll, an agent's read or write, a person's write, or plugin start, not only a person's unfolded drawer
// (SESSION-HANDOFF-SPEC §12, §21.16). No provider is read in these cases.
vi.mock("./provider-history", () => ({ historyBytes: async () => 0 }));
vi.mock("./handoff-git", () => ({ handoffGitDirectories: async () => ({ directories: [], unchecked: [] }), handoffGitSnapshot: vi.fn() }));
const roots: string[] = [], observers: HandoffObserver[] = [];
afterEach(async () => { await Promise.all(observers.splice(0).map((observer) => observer.stop())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const at = () => new Date().toISOString();
const job = (extra: Partial<AutomationJob>): AutomationJob => ({ taskId: "t", projectId: "p", role: "implementer", state: "working", generation: 1, nudges: 0, failures: 0, reviewRounds: 1, queuedAt: at(), updatedAt: at(), ...extra });
const losses = { missing: (file: string) => rm(file), unreadable: (file: string) => writeFile(file, "{ not json"), none: async () => undefined };

/** A live automation card whose agent wrote its handoff (the index reads fresh), then loses the record. */
async function lost(loss: keyof typeof losses) {
  const x = await agentFixture(); roots.push(x.root);
  const h = new HandoffService(x.store); h.attach(x.paseo); x.service.handoffs = h;
  await x.store.mutate((board) => { board.projects[0].automation = { enabled: true, maxRunning: 1, maxReviewRounds: 3, fullAccess: true, nudgeLimit: 2, failureLimit: 2 }; board.automation.push(job({ implementerId: "actor" })); board.tasks[0].status = "development"; });
  // Production wiring (index.server.ts): the observer runs in the service's card queue and syncs through it.
  const observer = new HandoffObserver({ records: h.records, board: x.store, paseo: () => x.paseo, serial: h.serial.bind(h), syncIndex: h.syncIndex.bind(h), capture: async () => { throw new Error("no provider capture in this test"); } });
  observers.push(observer);
  const index = async () => (await x.store.read()).handoffIndex.find((entry) => entry.taskId === "t")!;
  const tone = async () => { const board = await x.store.read(); return handoffSignal(await index(), board.automation[0], board.tasks[0])?.tone; };
  const first = await x.service.get(x.identity);
  await x.service.updateHandoff(x.identity, { handoffRevision: first.handoff!.revision, operationId: "cp", state: "Working on the parser", set: [{ section: "next", text: "Finish the parser" }] });
  expect(await index()).toMatchObject({ fresh: true });
  expect(await tone()).toBe("recorded");
  await losses[loss](join(h.records.root, "t.json"));
  let commits = 0; const committed = x.store.onCommit; x.store.onCommit = () => { commits++; committed?.(); };
  return { ...x, h, observer, index, tone, commits: () => commits, poll: () => observer.poll(async () => [{ taskId: "t", agentId: "actor" }]) };
}

for (const loss of ["missing", "unreadable"] as const) {
  test(`the observer's poll of a working card whose record is ${loss} turns the card face into a warning, once`, async () => {
    const x = await lost(loss);
    await x.poll();
    expect(await x.index()).toMatchObject({ fresh: false, behind: "unverified", staleSince: expect.any(String) });
    expect(await x.tone()).toBe("check");
    // Later polls meet the same loss and write nothing more.
    const written = x.commits();
    await x.poll(); await x.poll();
    expect(x.commits()).toBe(written);
  });

  test(`an agent's read or write that meets a ${loss} record turns the card face into a warning`, async () => {
    for (const meet of ["read", "write"] as const) {
      const x = await lost(loss);
      if (meet === "read") expect((await x.h.context("t", "actor", { recordAccess: false })).unavailable).toBeTruthy();
      else await expect(x.h.update(x.identity, { handoffRevision: 1, operationId: "cp2", state: "More work" })).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" });
      await vi.waitFor(async () => expect(await x.index()).toMatchObject({ behind: "unverified" }), { timeout: 2000, interval: 10 });
      expect(await x.tone()).toBe("check");
    }
  });

  test(`plugin start checks every known record, so a record ${loss} while the daemon was down shows on the board`, async () => {
    const x = await lost(loss);
    // The entry already says what the record is behind on, so the old start sync (entries without `behind`) skipped it.
    await x.store.mutate((board) => { const entry = board.handoffIndex.find((item) => item.taskId === "t")!; Object.assign(entry, { fresh: false, behind: "activity", staleSince: at() }); });
    await x.h.sweepBodies({ delayMs: 0, pauseMs: 0 });
    expect(await x.index()).toMatchObject({ fresh: false, behind: "unverified" });
  });
}

test("plugin start leaves a readable record's index entry as it is when it agrees, and writes nothing", async () => {
  const x = await lost("none");
  const before = await x.index();
  await x.h.sweepBodies({ delayMs: 0, pauseMs: 0 });
  expect(await x.index()).toEqual(before); expect(x.commits()).toBe(0);
});
