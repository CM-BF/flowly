import { registerCatalog, type LocaleCode } from "./i18n";
import { catalogs } from "./i18n/catalogs";

/** Registers every language's catalog. Daemon and tests only: never import this from client code (bundle size). */
export function registerAllCatalogs() {
  (Object.keys(catalogs) as LocaleCode[]).forEach((code) => registerCatalog(code, catalogs[code]!));
}
registerAllCatalogs();
export { catalogs };
