/**
 * Runtime-neutral i18n: gettext style, the English source text is the key.
 * `t("Add task")` returns the current language's translation, or the English
 * text when the language is English or the string is not translated yet.
 * Catalogs live in `shared/i18n/<code>.ts`; `shared/i18n.test.ts` keeps them
 * complete. Only UI text is translated: agent-facing text (skill, tool
 * descriptions, prompts) and daemon error messages stay English.
 */
import { catalogs } from "./i18n/catalogs";

export const locales = [
  { code: "en", name: "English" },
  { code: "zh-CN", name: "简体中文" },
  { code: "zh-TW", name: "繁體中文" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "pt-BR", name: "Português (Brasil)" },
  { code: "ru", name: "Русский" },
] as const;

export type LocaleCode = (typeof locales)[number]["code"];
export const localeCodes = locales.map((l) => l.code) as readonly LocaleCode[];
/** The stored language preference: follow the device, or one fixed language. */
export type LanguagePreference = "auto" | LocaleCode;
export const languageChoices = ["auto", ...localeCodes] as const;

/** A translation is one string, or one string per CLDR plural category. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;
export type CatalogEntry = string | PluralForms;
export type Catalog = Record<string, CatalogEntry>;

/** Best supported language for a BCP 47 tag such as "zh-Hant-TW" or "pt-PT"; English when none fits. */
export function resolveLocale(tag: string | null | undefined): LocaleCode {
  const parts = String(tag ?? "").replace(/_/g, "-").toLowerCase().split("-").filter(Boolean);
  const base = parts[0];
  if (!base) return "en";
  if (base === "zh") {
    const traditional = parts.includes("hant") || parts.some((p) => p === "tw" || p === "hk" || p === "mo");
    return traditional ? "zh-TW" : "zh-CN";
  }
  if (base === "pt") return "pt-BR";
  const match = localeCodes.find((code) => code.toLowerCase() === base);
  return match ?? "en";
}

/** The device language, when the runtime reports one. */
export function deviceLocale(): LocaleCode {
  try {
    return resolveLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return "en";
  }
}

export function localeFor(preference: LanguagePreference | string | null | undefined): LocaleCode {
  if (!preference || preference === "auto") return deviceLocale();
  return localeCodes.includes(preference as LocaleCode) ? (preference as LocaleCode) : deviceLocale();
}

let current: LocaleCode = "en";
export const getLocale = (): LocaleCode => current;
export function setLocale(code: LocaleCode): void {
  current = code;
}

export type Params = Record<string, string | number>;

function format(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

function entry(source: string): CatalogEntry | undefined {
  if (current === "en") return undefined;
  return catalogs[current]?.[source];
}

/** Translate `source` (English text, `{name}` placeholders) into the current language. */
export function t(source: string, params?: Params): string {
  const found = entry(source);
  return format(typeof found === "string" ? found : source, params);
}

function pluralCategory(count: number): Intl.LDMLPluralRule {
  try {
    return new Intl.PluralRules(current).select(count);
  } catch {
    return count === 1 ? "one" : "other";
  }
}

/**
 * Count-dependent text. `one` and `other` are the English singular and plural
 * (the catalog key is `other`); `{n}` is replaced by the count.
 */
export function tn(count: number, one: string, other: string, params?: Params): string {
  const all = { n: count, ...params };
  const found = entry(other);
  if (typeof found === "string") return format(found, all);
  if (found) {
    const form = found[pluralCategory(count)] ?? found.other;
    if (form) return format(form, all);
  }
  return format(count === 1 ? one : other, all);
}

/** Marks text for extraction without translating it yet (module-level tables); translate with `t` at render. */
export const msg = (source: string): string => source;

/** Locale for Intl/Date formatting calls. */
export const formatLocale = (): string => (current === "en" ? "en-US" : current);

/**
 * A label table whose values translate on read. Wrap the English text in `msg()`
 * so the extractor sees it. The daemon never sets a language, so its reads stay
 * English (prompts, errors); only the client, which sets one, shows translations.
 */
export function localizedLabels<K extends string>(source: Record<K, string>): Record<K, string> {
  const out = {} as Record<K, string>;
  // forEach, not a for loop: each getter must close over its own key even when the bundler lowers `const` in loops to `var`.
  (Object.keys(source) as K[]).forEach((key) => Object.defineProperty(out, key, { enumerable: true, get: () => t(source[key]) }));
  return out;
}

/** Run `fn` with a language, then restore the previous one (daemon code that builds UI text for a requesting client). */
export function withLocale<T>(code: LocaleCode, fn: () => T): T {
  const previous = current;
  current = code;
  try {
    return fn();
  } finally {
    current = previous;
  }
}
