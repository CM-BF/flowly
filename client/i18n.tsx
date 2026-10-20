import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useSettings } from "@getpaseo/plugin/client";
import { deviceLocale, getLocale, localeFor, setLocale, type LocaleCode } from "../shared/i18n";
import { languageSettings, languageSettingsValues } from "../shared/settings";
import { useCatalog } from "./catalog";

/** How long a surface waits for its language before it shows English and swaps the language in when it arrives. */
export const CATALOG_WAIT_MS = 400;

/**
 * The language in effect: the stored preference (default: follow the device).
 * Until the setting has loaded the last language used stays, so a reload does
 * not flash the device language first.
 */
export function useLocale(): LocaleCode {
  const settings = useSettings(languageSettings);
  if (settings.status === "ready") return localeFor(languageSettingsValues(settings.values).language);
  if (settings.status === "error" || settings.status === "invalid") return deviceLocale();
  return getLocale();
}

/**
 * Wraps each plugin surface. The locale lives in a module variable that `t()`
 * reads, so a change remounts the surface (key) instead of threading the
 * language through memoized components. The language's catalog comes from the
 * daemon (not the bundle): the surface waits a moment for it, then shows English
 * and remounts when it arrives.
 */
export function LocaleRoot({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const catalog = useCatalog(locale);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (catalog !== "loading") return;
    const timer = setTimeout(() => setGaveUp(true), CATALOG_WAIT_MS);
    return () => clearTimeout(timer);
  }, [catalog]);
  setLocale(locale);
  if (catalog === "loading" && !gaveUp) return null;
  return <Fragment key={`${locale}:${catalog}`}>{children}</Fragment>;
}
