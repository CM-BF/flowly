import { Fragment, type ReactNode } from "react";
import { useSettings } from "@getpaseo/plugin/client";
import { deviceLocale, getLocale, localeFor, setLocale, type LocaleCode } from "../shared/i18n";
import { languageSettings, languageSettingsValues } from "../shared/settings";

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
 * language through memoized components.
 */
export function LocaleRoot({ children }: { children: ReactNode }) {
  const locale = useLocale();
  setLocale(locale);
  return <Fragment key={locale}>{children}</Fragment>;
}
