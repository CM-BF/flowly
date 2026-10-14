import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixtureDir, "../../../..");
const outputPath = join(fixtureDir, "legacy-renderer-output.txt");
const cleanupPath = join(fixtureDir, "legacy-renderer-cleanup.txt");
const temp = mkdtempSync(join(tmpdir(), "kanban-session-attention-legacy-renderer-"));
let result;
try {
  const install = spawnSync("npm", ["install", "--prefix", temp, "--no-save", "--ignore-scripts", "--package-lock=false", "react-test-renderer@19.1.0"], { cwd: root, encoding: "utf8" });
  if (install.status !== 0) throw new Error(`${install.stdout || ""}${install.stderr || ""}`);
  const modules = join(temp, "node_modules");
  rmSync(join(modules, "react"), { recursive: true, force: true });
  symlinkSync(resolve(root, "node_modules/react"), join(modules, "react"), "dir");
  result = spawnSync(resolve(root, "node_modules/.bin/vitest"), ["run",
    "docs/verification/fixtures/session-pane/session-components.test.tsx",
    "docs/verification/fixtures/session-layout/session-layout-components.test.tsx",
  ], {
    cwd: root, encoding: "utf8", env: {
      ...process.env,
      UIUX_TEST_RENDERER: join(modules, "react-test-renderer"),
      SESSION_LAYOUT_TEST_RENDERER: join(modules, "react-test-renderer"),
    },
  });
  writeFileSync(outputPath, `${result.stdout || ""}${result.stderr || ""}`);
} catch (error) {
  writeFileSync(outputPath, String(error));
  result = { status: 1, stdout: "", stderr: String(error) };
} finally {
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(cleanupPath, `renderer_temp=${temp}\nrenderer_temp_exists_after_cleanup=${existsSync(temp)}\n`);
}
process.stdout.write(`${result.stdout || ""}${result.stderr || ""}`);
if (result.status !== 0) process.exitCode = result.status ?? 1;
