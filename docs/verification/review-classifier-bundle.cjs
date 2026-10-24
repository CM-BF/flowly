// Usage: node docs/verification/review-classifier-bundle.cjs <checkout> [input-filters]
// Read-only: never connects to a daemon. Uses the installed macOS Paseo compiler options.
// Compile <dir>/index.client.tsx with the daemon's client esbuild options (Paseo.app compiler.js), in memory.
const path = require("node:path");
const { realpathSync } = require("node:fs");
const esbuildDir = "/Applications/Paseo.app/Contents/Resources/app.asar.unpacked/node_modules/esbuild";
process.env.ESBUILD_BINARY_PATH = "/Applications/Paseo.app/Contents/Resources/app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild";
const { build, version } = require(esbuildDir);
const SDK = ["@getpaseo/plugin", "@getpaseo/plugin/server", "@getpaseo/plugin/server/provider", "@getpaseo/plugin/server/usage", "@getpaseo/plugin/server/acp", "@getpaseo/plugin/client", "@getpaseo/plugin/client/ui", "@getpaseo/plugin/client/react-native"];
(async () => {
  const dir = realpathSync.native(process.argv[2]);
  const result = await build({
    entryPoints: [path.join(dir, "index.client.tsx")], bundle: true, format: "cjs", jsx: "automatic", platform: "neutral", target: "es2020",
    mainFields: ["module", "main"], supported: { "async-await": false },
    external: [...SDK, "@tanstack/react-query", "react", "react/jsx-runtime", "react-native", "zod"],
    metafile: true, logLevel: "silent", treeShaking: true, write: false,
  });
  const code = result.outputFiles[0].text.replaceAll("get: () => from[key]", "value: from[key]");
  const wrapped = `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`;
  const bytes = Buffer.byteLength(wrapped), lines = wrapped.split("\n").length;
  const outputs = Object.values(result.metafile.outputs)[0].inputs;
  const pick = (process.argv[3] || "").split(",").filter(Boolean);
  const rows = Object.entries(outputs).filter(([f]) => !pick.length || pick.some((p) => f.split(dir.slice(1)).pop().includes(p))).map(([f, v]) => `${f} ${v.bytesInOutput}`);
  console.log(JSON.stringify({ esbuild: version, bytes, lines }));
  if (pick.length) console.log(rows.join("\n"));
  if (process.argv[4]) require("node:fs").writeFileSync(process.argv[4], wrapped);
})().catch((e) => { console.error(e); process.exit(1); });
