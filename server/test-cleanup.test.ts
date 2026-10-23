import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCleanups, type Cleanup } from "./test-cleanup";

test("a failing cleanup does not skip the ones registered before it, and its error is still reported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowly-cleanup-test-"));
  const list: Cleanup[] = [() => rm(directory, { recursive: true, force: true })];
  // A server that never listened: close() fails with ERR_SERVER_NOT_RUNNING, as when listen is denied.
  const server = createServer();
  list.push(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  await expect(runCleanups(list)).rejects.toMatchObject({ code: "ERR_SERVER_NOT_RUNNING" });
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(list).toEqual([]);
});

test("every failure is reported when several cleanups fail", async () => {
  const ran: string[] = [];
  const list: Cleanup[] = [
    () => { ran.push("first"); },
    () => { ran.push("second"); throw new Error("second failed"); },
    () => { ran.push("third"); throw new Error("third failed"); },
  ];
  const error = await runCleanups(list).then(() => null, (e: unknown) => e);
  expect(ran).toEqual(["third", "second", "first"]);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual(["third failed", "second failed"]);
});
