import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixtureDir, "../../../..");
const output = join(fixtureDir, "legacy-regressions-output.txt");
const cleanup = join(fixtureDir, "legacy-regressions-cleanup.txt");
const temp = mkdtempSync(join(tmpdir(), "kanban-session-chip-regressions-"));
let result;
try {
  const install = spawnSync("npm", ["install", "--prefix", temp, "--no-save", "--ignore-scripts", "--package-lock=false", "react-test-renderer@19.1.0"], { cwd: root, encoding: "utf8" });
  if (install.status !== 0) throw new Error(`${install.stdout || ""}${install.stderr || ""}`);
  const modules = join(temp, "node_modules");
  rmSync(join(modules, "react"), { recursive: true, force: true });
  symlinkSync(resolve(root, "node_modules/react"), join(modules, "react"), "dir");
  const files = [
    "docs/verification/fixtures/session-pane/session-components.test.tsx",
    "docs/verification/fixtures/session-layout/session-layout-components.test.tsx",
    "docs/verification/fixtures/session-attention/session-attention-components.test.tsx",
    "docs/verification/fixtures/session-attention/shared-attention.test.ts",
    "docs/verification/fixtures/session-attention/server-session-reads.test.ts",
  ];
  result = spawnSync(resolve(root, "node_modules/.bin/vitest"), ["run", ...files], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      UIUX_TEST_RENDERER: join(modules, "react-test-renderer"),
      SESSION_LAYOUT_TEST_RENDERER: join(modules, "react-test-renderer"),
      SESSION_ATTENTION_RENDERER: join(modules, "react-test-renderer"),
    },
  });
  writeFileSync(output, `${result.stdout || ""}${result.stderr || ""}`);
} catch (error) {
  writeFileSync(output, String(error));
  result = { status: 1, stdout: "", stderr: String(error) };
} finally {
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(cleanup, `renderer_temp=${temp}\nrenderer_temp_exists_after_cleanup=${existsSync(temp)}\n`);
}
process.stdout.write(`${result.stdout || ""}${result.stderr || ""}`);
if (result.status !== 0) process.exitCode = result.status ?? 1;
