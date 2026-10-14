import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const stamp = new Date().toISOString().replaceAll(":", "-");
const temp = mkdtempSync(join(tmpdir(), `kanban-session-input-${stamp}-`));
const pathReceipt = join(here, `renderer-path-${stamp}.json`);
const output = join(here, `focused-output-${stamp}.txt`);
const cleanup = join(here, `renderer-cleanup-${stamp}.txt`);
writeFileSync(pathReceipt, `${JSON.stringify({ temp, createdAt: new Date().toISOString() }, null, 2)}\n`);
let result = { status: 1, stdout: "", stderr: "runner did not execute" };
try {
  const install = spawnSync("npm", ["install", "--prefix", temp, "--no-save", "--ignore-scripts", "--package-lock=false", "react-test-renderer@19.1.0"], { cwd: root, encoding: "utf8" });
  if (install.status !== 0) throw new Error(`${install.stdout || ""}${install.stderr || ""}`);
  const modules = join(temp, "node_modules");
  rmSync(join(modules, "react"), { recursive: true, force: true });
  symlinkSync(resolve(root, "node_modules/react"), join(modules, "react"), "dir");
  result = spawnSync(resolve(root, "node_modules/.bin/vitest"), ["run", "docs/verification/fixtures/session-input/session-input.test.ts", "docs/verification/fixtures/session-input/session-preview-keyboard.test.tsx"], {
    cwd: root, encoding: "utf8", env: { ...process.env, SESSION_INPUT_RENDERER: join(modules, "react-test-renderer") },
  });
} catch (error) {
  result = { status: 1, stdout: "", stderr: String(error) };
} finally {
  writeFileSync(output, `${result.stdout || ""}${result.stderr || ""}`);
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(cleanup, `renderer_temp=${temp}\nrenderer_temp_exists_after_cleanup=${existsSync(temp)}\n`);
}
process.stdout.write(`${result.stdout || ""}${result.stderr || ""}`);
process.stdout.write(`\nFocused output: ${output}\nPath receipt: ${pathReceipt}\nCleanup receipt: ${cleanup}\n`);
if (result.status !== 0) process.exitCode = result.status ?? 1;
