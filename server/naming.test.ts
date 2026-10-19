import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDirectory, linkedDirectory, migrateLegacyPluginData, LEGACY_PLUGIN_ID } from "./service";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("Flowly configuration overrides win, with existing environment overrides retained", () => {
  vi.stubEnv("PASEO_HOME", "/fixture/home");
  vi.stubEnv("ULTRA_KANBAN_DATA_DIR", "/fixture/legacy-data");
  vi.stubEnv("ULTRA_KANBAN_LINKED_DIR", "/fixture/legacy-links");
  vi.stubEnv("FLOWLY_DATA_DIR", "");
  vi.stubEnv("FLOWLY_LINKED_DIR", "");
  expect(dataDirectory()).toBe("/fixture/legacy-data");
  expect(linkedDirectory()).toBe("/fixture/legacy-links");
  vi.stubEnv("FLOWLY_DATA_DIR", "/fixture/flowly-data");
  vi.stubEnv("FLOWLY_LINKED_DIR", "/fixture/flowly-links");
  expect(dataDirectory()).toBe("/fixture/flowly-data");
  expect(linkedDirectory()).toBe("/fixture/flowly-links");
  vi.stubEnv("FLOWLY_DATA_DIR", "");
  vi.stubEnv("FLOWLY_LINKED_DIR", "");
  vi.stubEnv("ULTRA_KANBAN_DATA_DIR", "");
  vi.stubEnv("ULTRA_KANBAN_LINKED_DIR", "");
  expect(dataDirectory()).toBe("/fixture/home/plugin-data/flowly");
  expect(linkedDirectory()).toBe("/fixture/home/plugin-data/flowly/projects");
});

test("legacy data and settings copy once without overwriting either location", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowly-naming-"));
  roots.push(root);
  for (const area of ["plugin-data", "plugin-settings"]) {
    const from = join(root, area, LEGACY_PLUGIN_ID);
    await mkdir(from, { recursive: true });
    await writeFile(join(from, "saved.json"), '{"keep":"exact bytes"}\n');
  }
  expect(migrateLegacyPluginData(root)).toEqual(["plugin-data", "plugin-settings"]);
  for (const area of ["plugin-data", "plugin-settings"]) {
    const to = join(root, area, "flowly", "saved.json");
    expect(await readFile(to, "utf8")).toBe('{"keep":"exact bytes"}\n');
    await writeFile(to, "new Flowly data");
  }
  expect(migrateLegacyPluginData(root)).toEqual([]);
  for (const area of ["plugin-data", "plugin-settings"]) {
    expect(await readFile(join(root, area, LEGACY_PLUGIN_ID, "saved.json"), "utf8")).toBe('{"keep":"exact bytes"}\n');
    expect(await readFile(join(root, area, "flowly", "saved.json"), "utf8")).toBe("new Flowly data");
  }
});
