import { beforeEach, expect, test, vi } from "vitest";
import { i18nCatalog } from "../shared/rpc";
import { catalogs } from "../shared/i18n-all";
import { hasCatalog, localeCodes, t, withLocale, type LocaleCode } from "../shared/i18n";
import { loadCatalog, resetCatalogRequests } from "./catalog";

vi.mock("react", () => ({ useEffect: () => undefined, useState: (v: unknown) => [v, () => undefined] }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => null }));

beforeEach(() => resetCatalogRequests());

test("English needs no catalog and is never requested", async () => {
  const read = vi.fn();
  expect(await loadCatalog(read, "en")).toBe(true);
  expect(read).not.toHaveBeenCalled();
});

test("a language is requested once, even from several surfaces at the same time, and then translates", async () => {
  // A language no other test in this file registers.
  const locale: LocaleCode = "sv" as LocaleCode;
  const read = vi.fn(async () => ({ "Add task": "Lägg till" }));
  const [a, b] = await Promise.all([loadCatalog(read, locale), loadCatalog(read, locale)]);
  expect([a, b]).toEqual([true, true]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(hasCatalog(locale)).toBe(true);
  withLocale(locale, () => expect(t("Add task")).toBe("Lägg till"));
  // Registered: later surfaces do not ask again.
  expect(await loadCatalog(read, locale)).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);
});

test("a failed request reports false and is retried by the next surface", async () => {
  const locale: LocaleCode = "no" as LocaleCode;
  const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ Todo: "Å gjøre" });
  expect(await loadCatalog(read, locale)).toBe(false);
  expect(hasCatalog(locale)).toBe(false);
  expect(await loadCatalog(read, locale)).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
});

test("every shipped catalog fits the daemon's reply, and English has no request", () => {
  const output = (i18nCatalog as unknown as { output: { safeParse(v: unknown): { success: boolean } } }).output;
  const input = (i18nCatalog as unknown as { input: { safeParse(v: unknown): { success: boolean } } }).input;
  for (const code of localeCodes.filter((c) => c !== "en")) {
    expect(input.safeParse({ locale: code }).success).toBe(true);
    expect(output.safeParse(catalogs[code]).success, code).toBe(true);
  }
  expect(input.safeParse({ locale: "en" }).success).toBe(false);
  expect(input.safeParse({ locale: "xx" }).success).toBe(false);
});

test("nothing the client entry imports reaches the catalogs (they would be in the phone's bundle again)", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const root = resolve(new URL("..", import.meta.url).pathname);
  const resolveImport = (from: string, spec: string) => {
    const base = resolve(dirname(from), spec);
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((f) => existsSync(f) && /\.tsx?$/.test(f));
  };
  const seen = new Set<string>();
  const queue = [resolve(root, "index.client.tsx")];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/(?:from|import\()\s*"(\.[^"]+)"/g)) {
      const next = resolveImport(file, m[1]);
      if (next) queue.push(next);
    }
  }
  const names = [...seen].map((f) => f.slice(root.length + 1));
  expect(names).toContain("shared/i18n.ts");
  expect(names.filter((f) => /^shared\/i18n(-all|\/)/.test(f))).toEqual([]);
});
