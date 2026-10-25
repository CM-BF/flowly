/**
 * Cost of routine observation (review round 2, noise-r2): an idle poll writes nothing. Every text is synthetic.
 */
import { afterEach, expect, test } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { handoffOpenIds } from "../shared/handoff";
import { cleanupObserverFixtures, codexEvent, codexTyped, observerFixture } from "./handoff-observer-fixture";

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
