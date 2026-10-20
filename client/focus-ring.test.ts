import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// Every Pressable draws its own focus/hover state (background, opacity). A browser outline on one is
// clipped by rounded, overflow-hidden lists into a stray coloured line (user reports: a line under a
// session row while scrolling the board). So every Pressable opening tag must carry `noFocusRing`.
test("every Pressable in client/ opts out of the browser focus outline", () => {
  const dir = join(__dirname);
  const missing: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
    const source = readFileSync(join(dir, file), "utf8");
    const re = /<Pressable\b/g;
    for (let m = re.exec(source); m; m = re.exec(source)) {
      // The opening tag: up to the first line that is just ">" (multi-line tags) or the end of a one-line tag.
      const rest = source.slice(m.index, m.index + 6000);
      const firstLine = rest.slice(0, rest.indexOf("\n"));
      const close = /(^|[^=])>\s*$/.test(firstLine) ? firstLine.length : rest.search(/\n\s*\/?>\s*\n/);
      if (!rest.slice(0, close === -1 ? 6000 : close).includes("noFocusRing")) missing.push(`${file}:${source.slice(0, m.index).split("\n").length}`);
    }
  }
  expect(missing).toEqual([]);
});
