import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixtureDir, "../../../..");
const output = join(fixtureDir, "final-npm-test-output.txt");
const result = spawnSync("npm", ["test"], { cwd: root, encoding: "utf8" });
const captured = `${result.stdout || ""}${result.stderr || ""}`;
writeFileSync(output, captured);
process.stdout.write(captured);
if (result.status !== 0) process.exitCode = result.status ?? 1;
