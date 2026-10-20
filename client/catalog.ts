import { useEffect, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { hasCatalog, registerCatalog, type Catalog, type LocaleCode } from "../shared/i18n";
import { i18nCatalog } from "../shared/rpc";
import { perfEarly, perfNow } from "./perf";

/**
 * The client bundle carries no translations (they were over half of it, and the
 * phone evaluates the whole bundle at every start). A language's catalog is
 * asked of the daemon once per run and registered; English needs none.
 */
const pending = new Map<LocaleCode, Promise<boolean>>();

type ReadCatalog = (input: { locale: string }) => Promise<Catalog>;

/** True when the language is ready (English, already loaded, or loaded now); false when the daemon could not provide it. */
export function loadCatalog(read: ReadCatalog, locale: LocaleCode): Promise<boolean> {
  if (hasCatalog(locale)) return Promise.resolve(true);
  const running = pending.get(locale);
  if (running) return running;
  const asked = perfNow();
  const request = read({ locale })
    .then((catalog) => {
      registerCatalog(locale, catalog);
      perfEarly("catalog.load", perfNow() - asked);
      return true;
    })
    .catch(() => false)
    .then((ok) => {
      // A failure may be retried by the next surface that mounts.
      if (!ok) pending.delete(locale);
      return ok;
    });
  pending.set(locale, request);
  return request;
}

/** Forgets what was loaded (tests). */
export const resetCatalogRequests = () => pending.clear();

export type CatalogStatus = "ready" | "loading" | "failed";

export function useCatalog(locale: LocaleCode): CatalogStatus {
  const read = useRpc(i18nCatalog);
  const [failed, setFailed] = useState<LocaleCode | "">("");
  const [, setLoaded] = useState(0);
  const ready = hasCatalog(locale);
  useEffect(() => {
    if (ready) return;
    let live = true;
    void loadCatalog(read as ReadCatalog, locale).then((ok) => {
      if (!live) return;
      if (ok) setLoaded((n) => n + 1);
      else setFailed(locale);
    });
    return () => {
      live = false;
    };
  }, [locale, ready]);
  return ready ? "ready" : failed === locale ? "failed" : "loading";
}
