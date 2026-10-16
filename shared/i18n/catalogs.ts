import type { Catalog, LocaleCode } from "../i18n";
import de from "./de";
import es from "./es";
import fr from "./fr";
import ja from "./ja";
import ko from "./ko";
import ptBR from "./pt-BR";
import ru from "./ru";
import zhCN from "./zh-CN";
import zhTW from "./zh-TW";

export const catalogs: Partial<Record<LocaleCode, Catalog>> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ko,
  es,
  fr,
  de,
  "pt-BR": ptBR,
  ru,
};
