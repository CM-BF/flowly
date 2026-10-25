import { open } from "node:fs/promises";
import { tmpdir } from "node:os";

/**
 * Test setup only (vitest.config.ts); runtime entries never import this module. Tests never cut the power, so fsync proves
 * nothing here: crash ordering is tested through the stores' fault seams (HandoffStore `fault`), and every open, write,
 * rename and close still runs for real. What fsync did cost: one npm test run made about 10,300 of them (about 104 s summed
 * over the workers), which stalled file operations in every worker under default parallelism, including tests that never
 * sync. The handoff delivery-gate tests (26 Git calls and 88 fsyncs each, under 1 s alone) and a panel-review test (42 ms
 * alone, no Git and no fsync) then passed their 5 s timeout; without fsync the whole run took 14 s instead of 46 s.
 */
const handle = await open(tmpdir(), "r");
const fileHandle = Object.getPrototypeOf(handle) as { sync: () => Promise<void>; datasync: () => Promise<void> };
await handle.close();
fileHandle.sync = async () => {};
fileHandle.datasync = async () => {};
