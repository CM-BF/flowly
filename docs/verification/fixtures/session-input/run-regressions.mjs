import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const stamp = new Date().toISOString().replaceAll(":", "-");
const temp = mkdtempSync(join(tmpdir(), `kanban-session-input-regressions-${stamp}-`));
const pathReceipt = join(here, `regression-renderer-path-${stamp}.json`);
const output = join(here, `regression-output-${stamp}.txt`);
const cleanup = join(here, `regression-renderer-cleanup-${stamp}.txt`);
writeFileSync(pathReceipt, `${JSON.stringify({ temp, createdAt: new Date().toISOString() }, null, 2)}\n`);
let result = { status: 1, stdout: "", stderr: "runner did not execute" };
try {
  const install = spawnSync("npm", ["install", "--prefix", temp, "--no-save", "--ignore-scripts", "--package-lock=false", "react-test-renderer@19.1.0"], { cwd: root, encoding: "utf8" });
  if (install.status !== 0) throw new Error(`${install.stdout || ""}${install.stderr || ""}`);
  const modules = join(temp, "node_modules");
  rmSync(join(modules, "react"), { recursive: true, force: true });
  symlinkSync(resolve(root, "node_modules/react"), join(modules, "react"), "dir");
  const renderer = join(modules, "react-test-renderer");
  const files = [
    "docs/verification/fixtures/session-pane/session-components.test.tsx",
    "docs/verification/fixtures/session-layout/session-layout-components.test.tsx",
    "docs/verification/fixtures/session-attention/session-attention-components.test.tsx",
    "docs/verification/fixtures/session-chip/session-entry-components.test.tsx",
    "docs/verification/fixtures/drawer/drawer-components.test.tsx",
    "docs/verification/fixtures/motion/motion-components.test.tsx",
    "docs/verification/fixtures/motion/motion-primitives.test.tsx",
    "docs/verification/fixtures/ui-ux/card-responder.test.tsx",
  ];
  result = spawnSync(resolve(root, "node_modules/.bin/vitest"), ["run", ...files], {
    cwd: root, encoding: "utf8", env: { ...process.env,
      SESSION_ATTENTION_RENDERER: renderer,
      UIUX_TEST_RENDERER: renderer,
      SESSION_CHIP_RENDERER: renderer,
      SESSION_LAYOUT_TEST_RENDERER: renderer,
      MOTION_TEST_RENDERER: renderer,
      DRAWER_TEST_RENDERER: renderer,
      MOTION_TEST_REDUCED: "false",
    },
  });
} catch (error) {
  result = { status: 1, stdout: "", stderr: String(error) };
} finally {
  writeFileSync(output, `${result.stdout || ""}${result.stderr || ""}`);
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(cleanup, `renderer_temp=${temp}\nrenderer_temp_exists_after_cleanup=${existsSync(temp)}\n`);
}
process.stdout.write(`${result.stdout || ""}${result.stderr || ""}`);
process.stdout.write(`\nRegression output: ${output}\nPath receipt: ${pathReceipt}\nCleanup receipt: ${cleanup}\n`);
if (result.status !== 0) process.exitCode = result.status ?? 1;
