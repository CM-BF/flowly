import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const stamp = new Date().toISOString().replaceAll(":", "-");
const output = join(here, `wire-focused-output-${stamp}.txt`);
const result = spawnSync(resolve(root, "node_modules/.bin/vitest"), ["run", "client/session.test.ts", "docs/verification/fixtures/session-input/session-wire-payload.test.ts"], { cwd: root, encoding: "utf8" });
writeFileSync(output, `${result.stdout || ""}${result.stderr || ""}`);
process.stdout.write(`${result.stdout || ""}${result.stderr || ""}`);
process.stdout.write(`\nFocused wire output: ${output}\n`);
if (result.status !== 0) process.exitCode = result.status ?? 1;
