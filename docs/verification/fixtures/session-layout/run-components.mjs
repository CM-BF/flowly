import { spawnSync } from "node:child_process";
import {
  existsSync,
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
const outputPath = join(fixtureDir, "session-layout-components-rerun-output.txt");
const cleanupPath = join(fixtureDir, "session-layout-renderer-rerun-cleanup.txt");
const temporaryRoot = mkdtempSync(join(tmpdir(), "paseo-session-layout-renderer-"));
let result;

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
  result = spawnSync(
    resolve(root, "node_modules/.bin/vitest"),
    ["run", "docs/verification/fixtures/session-layout/session-layout-components.test.tsx", "client/session-state.test.ts", "docs/verification/fixtures/session-pane/session-components.test.tsx"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SESSION_LAYOUT_TEST_RENDERER: join(tempNodeModules, "react-test-renderer"),
        UIUX_TEST_RENDERER: join(tempNodeModules, "react-test-renderer"),
      },
    },
  );
  writeFileSync(outputPath, `${result.stdout || ""}${result.stderr || ""}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
  writeFileSync(
    cleanupPath,
    `renderer_temp=${temporaryRoot}\nrenderer_temp_exists_after_cleanup=${existsSync(temporaryRoot)}\n`,
  );
}

if (result?.status !== 0) process.exitCode = result?.status ?? 1;
process.stdout.write(`${result?.stdout || ""}${result?.stderr || ""}`);
