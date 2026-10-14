import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixtureDir, "../../../..");
const outputPath = join(fixtureDir, "session-components-output.txt");
const cleanupPath = join(fixtureDir, "session-components-temp-cleanup.txt");
const temporaryRoot = mkdtempSync(join(tmpdir(), "paseo-session-pane-renderer-"));
let testResult;

try {
  const install = spawnSync(
    "npm",
    ["install", "--prefix", temporaryRoot, "--no-save", "--ignore-scripts", "--package-lock=false", "react-test-renderer@19.1.0"],
    { cwd: root, encoding: "utf8" },
  );
  if (install.status !== 0) {
    const detail = `${install.stdout || ""}${install.stderr || ""}`;
    writeFileSync(outputPath, detail);
    throw new Error(`temporary renderer install failed (${install.status})`);
  }
  const tempNodeModules = join(temporaryRoot, "node_modules");
  rmSync(join(tempNodeModules, "react"), { recursive: true, force: true });
  symlinkSync(resolve(root, "node_modules/react"), join(tempNodeModules, "react"), "dir");
  const vitest = resolve(root, "node_modules/.bin/vitest");
  testResult = spawnSync(
    vitest,
    ["run", "docs/verification/fixtures/session-pane/session-components.test.tsx"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, UIUX_TEST_RENDERER: join(tempNodeModules, "react-test-renderer") },
    },
  );
  writeFileSync(outputPath, `${testResult.stdout || ""}${testResult.stderr || ""}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
  writeFileSync(cleanupPath, `renderer_temp=${temporaryRoot}\nrenderer_temp_exists_after_cleanup=${existsSync(temporaryRoot)}\n`);
}

if (testResult?.status !== 0) process.exitCode = testResult?.status ?? 1;
process.stdout.write(`${testResult?.stdout || ""}${testResult?.stderr || ""}`);
