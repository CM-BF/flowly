import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixtureDir, "../../../..");
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const rendererRecord = join(fixtureDir, `renderer-path-${runId}.json`);
const focusedOutput = join(fixtureDir, `focused-output-${runId}.txt`);
const regressionOutput = join(fixtureDir, `legacy-regression-output-${runId}.txt`);
const immediateCloseOutput = join(fixtureDir, `legacy-immediate-close-output-${runId}.txt`);
const cleanupReceipt = join(fixtureDir, `renderer-cleanup-${runId}.txt`);
const sourceFiles = ["client/drawer.tsx", "client/disclosure.tsx", "client/task-metadata.tsx", "client/motion.tsx", "client/resize.tsx", "client/board.tsx"];
const sourceHashes = Object.fromEntries(sourceFiles.map((file) => [file, createHash("sha256").update(readFileSync(join(root, file))).digest("hex")]));
writeFileSync(join(fixtureDir, `source-hashes-${runId}.json`), `${JSON.stringify(sourceHashes, null, 2)}\n`);
const temporaryRoot = mkdtempSync(join(tmpdir(), "paseo-drawer-renderer-"));
writeFileSync(rendererRecord, `${JSON.stringify({ temporaryRoot, createdAt: new Date().toISOString() }, null, 2)}\n`);
let installStatus = null;
const runs = [];

try {
  const install = spawnSync("npm", ["install", "--prefix", temporaryRoot, "--no-save", "--ignore-scripts", "--package-lock=false", "react-test-renderer@19.1.0"], { cwd: root, encoding: "utf8" });
  installStatus = install.status;
  if (install.status !== 0) {
    const detail = `${install.stdout || ""}${install.stderr || ""}`;
    writeFileSync(focusedOutput, detail);
    throw new Error(`temporary renderer install failed (${install.status})`);
  }

  const tempNodeModules = join(temporaryRoot, "node_modules");
  rmSync(join(tempNodeModules, "react"), { recursive: true, force: true });
  symlinkSync(resolve(root, "node_modules/react"), join(tempNodeModules, "react"), "dir");
  const renderer = join(tempNodeModules, "react-test-renderer");
  const vitest = resolve(root, "node_modules/.bin/vitest");

  const run = (name, args, env, outputPath) => {
    const result = spawnSync(vitest, ["run", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    writeFileSync(outputPath, output);
    runs.push({ name, status: result.status, signal: result.signal, outputPath });
    process.stdout.write(`\n===== ${name} (exit ${result.status}) =====\n${output}`);
    return result.status;
  };

  const focusedStatus = run("focused drawer verification", ["docs/verification/fixtures/drawer/drawer-components.test.tsx"], { DRAWER_TEST_RENDERER: renderer, MOTION_TEST_REDUCED: "false" }, focusedOutput);
  if (focusedStatus !== 0) process.exitCode = focusedStatus ?? 1;
  else {
    const legacyStatus = run("legacy renderer regressions", [
      "docs/verification/fixtures/session-pane/session-components.test.tsx",
      "docs/verification/fixtures/session-chip/session-entry-components.test.tsx",
      "docs/verification/fixtures/ui-ux/card-responder.test.tsx",
      "docs/verification/fixtures/session-layout/session-layout-components.test.tsx",
      "docs/verification/fixtures/session-attention/session-attention-components.test.tsx",
      "docs/verification/fixtures/motion/motion-components.test.tsx",
      "docs/verification/fixtures/motion/motion-primitives.test.tsx",
      "docs/verification/fixtures/motion/motion-drag.test.tsx",
      "client/session-state.test.ts",
    ], {
      DRAWER_TEST_RENDERER: renderer,
      UIUX_TEST_RENDERER: renderer,
      SESSION_CHIP_RENDERER: renderer,
      SESSION_LAYOUT_TEST_RENDERER: renderer,
      SESSION_ATTENTION_RENDERER: renderer,
      MOTION_TEST_RENDERER: renderer,
    }, regressionOutput);
    if (legacyStatus !== 0) process.exitCode = legacyStatus ?? 1;
    else {
      const immediateCloseStatus = run("legacy immediate-close regression", [
        "docs/verification/fixtures/session-chip/board-entry-components.test.tsx",
      ], {
        SESSION_CHIP_RENDERER: renderer,
        MOTION_TEST_REDUCED: "true",
      }, immediateCloseOutput);
      if (immediateCloseStatus !== 0) process.exitCode = immediateCloseStatus ?? 1;
    }
  }
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${String(error)}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
  writeFileSync(cleanupReceipt, [
    `renderer_temp=${temporaryRoot}`,
    `renderer_temp_exists_after_cleanup=${existsSync(temporaryRoot)}`,
    `renderer_record=${rendererRecord}`,
    `install_status=${installStatus}`,
    ...runs.map((r) => `${r.name}_status=${r.status}`),
  ].join("\n") + "\n");
}
