import { afterEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePaseoCli } from "./paseo-cli";

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
