import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureRotationOverrides } from "./rotation-settings";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function file(value: unknown) { const root = await mkdtemp(join(tmpdir(), "flowly-rotation-settings-")); roots.push(root); const path = join(root, "rotation.json"); await writeFile(path, JSON.stringify(value)); return path; }
test("small acceptance thresholds apply only to the exact fixture identity", async () => {
  const overrides = await fixtureRotationOverrides(await file({ version: 1, fixtures: [{ taskId: "fixture", projectId: "fixture-project", limits: { bytesRotate: 1024 } }] }));
  expect(overrides("fixture", "fixture-project")).toEqual({ bytesRotate: 1024 });
  expect(overrides("user-card", "fixture-project")).toEqual({}); expect(overrides("fixture", "user-project")).toEqual({});
});
test("host-wide overrides and changes to the no-read guard are refused", async () => {
  await expect(fixtureRotationOverrides(await file({ version: 1, fixtures: [{ limits: { bytesRotate: 1024 } }] }))).rejects.toThrow("scope");
  await expect(fixtureRotationOverrides(await file({ version: 1, fixtures: [{ taskId: "fixture", limits: { bytesNoRead: 1024 } }] }))).rejects.toThrow("threshold");
});
