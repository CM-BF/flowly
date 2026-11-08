import { afterEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paseoInvocation, resolvePaseoCli } from "./paseo-cli";

const roots: string[] = [];
afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test("an executable override wins; invalid overrides fall through to the daemon's app bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowly-cli-resolver-"));
  roots.push(root);
  const helper = join(root, "Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper");
  const bundled = join(root, "Paseo.app/Contents/Resources/bin/paseo");
  await mkdir(join(bundled, ".."), { recursive: true });
  await writeFile(bundled, "fixture");
  await chmod(bundled, 0o700);
  const override = join(root, "override");
  await writeFile(override, "fixture");
  await chmod(override, 0o700);
  expect(await resolvePaseoCli(helper, { PASEO_CLI: override })).toBe(override);
  await chmod(override, 0o600);
  expect(await resolvePaseoCli(helper, { PASEO_CLI: override })).toBe(bundled);
  expect(await resolvePaseoCli(helper, { PASEO_CLI: join(root, "missing") })).toBe(bundled);
});

const desktop = "C:\\Users\\me\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd";
const npmShim = "C:\\Users\\me\\AppData\\Roaming\\npm\\paseo.cmd";

test("non-Windows platforms and non-shim files run the CLI directly", async () => {
  expect(await paseoInvocation("/Applications/Paseo.app/Contents/Resources/bin/paseo", ["agent", "stop", "a1"], "darwin")).toEqual({
    file: "/Applications/Paseo.app/Contents/Resources/bin/paseo",
    args: ["agent", "stop", "a1"],
  });
  expect(await paseoInvocation("C:\\tools\\paseo.exe", ["ls"], "win32")).toEqual({ file: "C:\\tools\\paseo.exe", args: ["ls"] });
});

test("the desktop app's paseo.cmd becomes Paseo.exe with the bundled runner, no shell", async () => {
  const seen: string[] = [];
  const run = await paseoInvocation(desktop, ["agent", "update", "a1", "--name=a & b %PATH%"], "win32", { KEEP: "1" }, "C:\\x\\Paseo.exe", async (p) => {
    seen.push(p);
    return true;
  });
  const resources = "C:\\Users\\me\\AppData\\Local\\Programs\\Paseo\\resources";
  expect(run.file).toBe("C:\\Users\\me\\AppData\\Local\\Programs\\Paseo\\Paseo.exe");
  expect(run.args).toEqual([
    "--disable-warning=DEP0040",
    `${resources}\\app.asar.unpacked\\dist\\daemon\\node-entrypoint-runner.js`,
    "node-script",
    `${resources}\\app.asar\\node_modules\\@getpaseo\\cli\\dist\\index.js`,
    "agent", "update", "a1", "--name=a & b %PATH%",
  ]);
  expect(run.env).toMatchObject({ KEEP: "1", ELECTRON_RUN_AS_NODE: "1", PASEO_NODE_ENV: "production", PASEO_DESKTOP_MANAGED: "1", PASEO_CLI: desktop });
  expect(seen).toContain(run.file);
});

test("npm's paseo.cmd runs the package's bin script with the daemon's runtime", async () => {
  const script = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@getpaseo\\cli\\bin\\paseo";
  const run = await paseoInvocation(npmShim, ["project", "create", "C:\\repo"], "win32", {}, "C:\\node\\node.exe", async (p) => p === script);
  expect(run).toEqual({ file: "C:\\node\\node.exe", args: [script, "project", "create", "C:\\repo"], env: { ELECTRON_RUN_AS_NODE: "1" } });
});

test("an unknown shim layout fails with a clear error instead of going through cmd.exe", async () => {
  await expect(paseoInvocation("D:\\odd\\paseo.cmd", [], "win32", {}, "node", async () => false)).rejects.toThrow(/Cannot start the Paseo CLI from paseo\.cmd/);
});
