import { describe, expect, it } from "vitest";
import { catalogs } from "./i18n-all";
import { deviceLocale, localeCodes, localizedLabels, resolveLocale, setLocale, t, tn, withLocale, type CatalogEntry } from "./i18n";
import { sourceKeys } from "./i18n-keys";
import { statusLabels, taskTypeLabels } from "./model";

const root = new URL("..", import.meta.url).pathname;
const keys = sourceKeys(root);
const sources = new Map<string, string>();
for (const k of keys) sources.set(k.key, k.file + ":" + k.line);
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const forms = (entry: CatalogEntry) => (typeof entry === "string" ? [entry] : Object.values(entry));

describe("language resolution", () => {
  it("maps device tags to the nearest supported language", () => {
    expect(resolveLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(resolveLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(resolveLocale("zh_HK")).toBe("zh-TW");
    expect(resolveLocale("pt-PT")).toBe("pt-BR");
    expect(resolveLocale("ja-JP")).toBe("ja");
    expect(resolveLocale("de-AT")).toBe("de");
    expect(resolveLocale("sv-SE")).toBe("en");
    expect(resolveLocale("")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });
  it("always returns a supported language for the device", () => {
    expect(localeCodes).toContain(deviceLocale());
  });
});

describe("t / tn", () => {
  it("returns the English text and fills placeholders when no translation exists", () => {
    setLocale("en");
    expect(t("Hello {name}", { name: "Ada" })).toBe("Hello Ada");
    expect(t("{n}", { n: 3 })).toBe("3");
    expect(t("Keep {unknown}", {})).toBe("Keep {unknown}");
    expect(tn(1, "{n} card", "{n} cards")).toBe("1 card");
    expect(tn(2, "{n} card", "{n} cards")).toBe("2 cards");
    expect(tn(0, "{n} card", "{n} cards")).toBe("0 cards");
  });
  it("uses the catalog of the current language and falls back to English per string", () => {
    const [sample] = Object.entries(catalogs["zh-CN"] ?? {}).filter(([, v]) => typeof v === "string");
    withLocale("zh-CN", () => {
      if (sample) expect(t(sample[0], { n: 1, name: "x" })).toBe((sample[1] as string).replace("{n}", "1").replace("{name}", "x"));
      expect(t("A string nobody translated")).toBe("A string nobody translated");
    });
    expect(t("A string nobody translated")).toBe("A string nobody translated");
  });
  it("restores the language after withLocale, even when the callback throws", () => {
    setLocale("en");
    expect(() => withLocale("de", () => { throw new Error("boom"); })).toThrow("boom");
    expect(t("Anything")).toBe("Anything");
  });
  it("gives every key of a label table its own label (not the last key's)", () => {
    for (const code of localeCodes) {
      withLocale(code, () => {
        expect(new Set(Object.values(statusLabels)).size).toBe(Object.keys(statusLabels).length);
        expect(new Set(Object.values(taskTypeLabels)).size).toBe(Object.keys(taskTypeLabels).length);
      });
    }
    expect(statusLabels.todo).toBe("Todo");
    expect(statusLabels.cancelled).toBe("Cancelled");
  });
  it("translates label tables on read", () => {
    const table = localizedLabels({ a: "Alpha" });
    setLocale("en");
    expect(table.a).toBe("Alpha");
  });
});

describe("catalogs", () => {
  it("found strings to translate", () => {
    expect(keys.length).toBeGreaterThan(300);
  });
  for (const code of localeCodes.filter((c) => c !== "en")) {
    describe(code, () => {
      const catalog = catalogs[code] ?? {};
      it("translates every string in the source", () => {
        const missing = [...sources.keys()].filter((k) => !(k in catalog));
        expect(missing, `${missing.length} missing, e.g. ${missing.slice(0, 5).join(" | ")}`).toEqual([]);
      });
      it("has no stale strings", () => {
        const stale = Object.keys(catalog).filter((k) => !sources.has(k));
        expect(stale, `stale: ${stale.slice(0, 5).join(" | ")}`).toEqual([]);
      });
      it("keeps the placeholders of every string", () => {
        const wrong = Object.entries(catalog).filter(([key, entry]) => forms(entry).some((f) => placeholders(f) !== placeholders(key) && !(typeof entry !== "string" && placeholders(f) === "" && false)));
        expect(wrong.map(([k]) => k).slice(0, 5)).toEqual([]);
      });
      it("has no empty translations", () => {
        expect(Object.entries(catalog).filter(([, e]) => forms(e).some((f) => !f.trim())).map(([k]) => k)).toEqual([]);
      });
    });
  }
});
