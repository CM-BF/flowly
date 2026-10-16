/**
 * Finds every translatable string in the source: `t("…")`, `tn(n, one, "other")`
 * and `msg("…")` calls with literal text. Used by the catalog tests; not shipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export type SourceKey = { key: string; one?: string; file: string; line: number };

function files(root: string, dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (/\.test\.tsx?$/.test(name) || name === "i18n-keys.ts" || path.startsWith(join("shared", "i18n", ""))) return [];
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const literal = (node: ts.Node | undefined): string | null =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

export function sourceKeys(root: string): SourceKey[] {
  const found: SourceKey[] = [];
  for (const file of [...files(root, "client"), ...files(root, "shared"), "index.client.tsx"]) {
    const text = readFileSync(join(root, file), "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (name === "t" || name === "msg") {
          const key = literal(node.arguments[0]);
          if (key !== null) found.push({ key, file, line });
        } else if (name === "tn") {
          const key = literal(node.arguments[2]);
          if (key !== null) found.push({ key, one: literal(node.arguments[1]) ?? undefined, file, line });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}
