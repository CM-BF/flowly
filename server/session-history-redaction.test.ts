import { expect, test } from "vitest";
import { performance } from "node:perf_hooks";
import type { SessionHistoryEntry } from "../shared/session-history";
import { HistoryRecords } from "./session-history-records";
import { redactHistory, sanitizeText, tailWindowStart } from "./session-history-text";
import { filler } from "./session-history-fixture";

const sid = "019a15e5-0000-7abc-8def-0123456789ab";
/** Records straight through the real index builder, without files. */
function build(records: unknown[]) {
  const index = new HistoryRecords(sid);
  let offset = 0;
  for (const record of records) { const raw = Buffer.from(JSON.stringify(record) + "\n"); index.line(raw, "codex", "main", offset, offset + raw.length, false); offset += raw.length; }
  return index.body().split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionHistoryEntry);
}
const call = (id: string, cmd: string) => ({ type: "response_item", payload: { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd }) } });
const output = (id: string, text: string) => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: text } });
/** Filler on one line. */
const flat = (characters: number, salt = 0) => filler(characters, salt).replace(/\n/g, " ");
const outputOf = (text: string) => build([call("c1", "curl -v https://intranet.example/api/me"), output("c1", text)]).find((entry) => entry.tool?.kind === "output")!;

test("a session cookie at the end of a Cookie line longer than the window margin is redacted as in the whole text", () => {
  const session = "k7q2v9m3r8t1x5z0b4n6c2d8f1"; // 26 characters, under the 40-character run rule
  const cookies = Array.from({ length: 220 }, (_, i) => `pref_${i}=v${i}x`).join("; ");
  const header = `Process exited with code 0\nOutput:\n${filler(20_000)}\n`;
  for (const text of [
    `${header}> GET /api/me HTTP/1.1\n> Host: intranet.example\n> Cookie: ${cookies}; PHPSESSID=${session}; theme=dark\n> Accept: */*\n>\n< HTTP/1.1 200 OK\n{"ok":true}\n`,
    // A pretty-printed request object with the cookie as a JSON value.
    `${header}{\n  "method": "GET",\n  "headers": {\n    "cookie": "${cookies}; PHPSESSID=${session}; theme=dark",\n    "accept": "*/*"\n  }\n}\n`,
  ]) {
    expect(redactHistory(text)).not.toContain(session);
    const entry = outputOf(text);
    expect(entry.truncated).toBe(true); expect(entry.text).not.toContain(session); expect(entry.text).not.toContain("pref_219=v219x");
  }
});

test("a long value on the line after its credential name is redacted with the name, as in the whole text", () => {
  const cookies = Array.from({ length: 220 }, (_, i) => `pref_${i}=v${i}x`).join("; ");
  for (const [opener, line, secret] of [
    ["Cookie:", `  ${cookies}; PHPSESSID=k7q2v9m3r8t1x5z0b4n6c2d8f1; theme=dark`, "k7q2v9m3r8t1x5z0b4n6c2d8f1"],
    ["Authorization: Bearer", `  ${"ab1.".repeat(800)}zz9`, "ab1.ab1.ab1."],
    ['"apiToken":', `  "${flat(3000, 2)} json-tail-secret-9"`, "json-tail-secret-9"],
    ["password:", `  "${flat(3000, 4)} yaml-tail-pass-7"`, "yaml-tail-pass-7"],
  ] as const) {
    const text = `Process exited with code 0\nOutput:\n${filler(20_000)}\n${opener}\n${line}\n`;
    expect(redactHistory(text)).not.toContain(secret);
    expect(outputOf(text).text).not.toContain(secret);
  }
});

test("credential-file formats that tools print are redacted in arguments and outputs, in the head and in the tail", () => {
  const v = "Zq123456v.789012", auth = Buffer.from(`citrine:${v}`).toString("base64");
  const forms = {
    netrc: `machine api.example.com login citrine password ${v}`,
    netrcLines: `machine api.example.com\n  login citrine\n  password ${v}`,
    pgpass: `db.example.com:5432:app:admin:${v}`,
    dockerConfig: `{"auths": {"ghcr.io": {"auth": "${auth}"}}}`,
    passwordFlag: `mysql -u root -p${v} app && psql --password ${v}`,
    pgpPrivateKey: `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF${v}\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----`,
  };
  const leaked = (shown: string) => shown.includes(v) || shown.includes(auth);
  expect(Object.entries(forms).filter(([, text]) => leaked(sanitizeText(text)?.text ?? "")).map(([name]) => name)).toEqual([]);
  for (const [name, form] of Object.entries(forms)) for (const text of [`cat ~/.config/${name}\n${form}\n${filler(9000, 5)}`, `${filler(9000, 6)}\n${form}\n`]) {
    const entries = build([call("c1", `printf '%s' '${text.replace(/'/g, "")}'`), output("c1", text)]);
    expect(entries.filter((entry) => leaked(entry.text)).map((entry) => `${name}:${entry.tool?.kind}`)).toEqual([]);
  }
  // Ordinary text that only looks similar stays readable.
  for (const text of ["mkdir -p build && cc -pthread x.c", "The password reset link expired.", "at Object.<anonymous> (src/a.ts:12:5)"]) expect(redactHistory(text)).toBe(text);
});

test("a tail window starts at a line, or inside a long compact line at a JSON element boundary that no credential spans", () => {
  const nominal = (text: string) => text.length - 2500;
  // Compact JSON on one line (JavaScript's separators, then Python's): the window starts at an element's quote within a few KiB.
  const rows = JSON.stringify(Array.from({ length: 1800 }, (_, i) => ({ id: i, name: `item-${i}`, path: `/srv/app/src/m${i % 100}/f${i}.ts`, note: `status_"ok"_${i}` })));
  for (const json of [rows, rows.replace(/,"/g, ', "')]) {
    const compact = `Process exited with code 0\nOutput:\n${json}`, start = tailWindowStart(compact, nominal(compact));
    expect(nominal(compact) - start).toBeLessThanOrEqual(4096); expect(compact[start]).toBe('"'); expect(compact.slice(0, start)).toMatch(/,\s*$/);
  }
  // A line start close by wins; a line ending in a credential name or `:` pulls the window back to that line.
  const lines = `${flat(9000)}\nfirst line\nsecond line ${flat(3000, 1)}`;
  expect(lines.slice(tailWindowStart(lines, nominal(lines)))).toMatch(/^second line /);
  const carried = `${flat(9000)}\nexport API_TOKEN=\n${flat(3000, 1)}`;
  expect(carried.slice(tailWindowStart(carried, nominal(carried)))).toMatch(/^export API_TOKEN=\n/);
  // Inside a URL's user info, a single-quoted credential value or a private key the window falls back to the line start (here 0).
  for (const risky of [`{"u":"https://user:${'p,"'.repeat(3000)}@host"}`, `{"cfg":"x", password='${'q,"'.repeat(3000)}'}`, `-----BEGIN PRIVATE KEY-----${'x,"'.repeat(3000)}`]) {
    expect(redactHistory(risky)).toContain("[redacted");
    expect(tailWindowStart(risky, nominal(risky))).toBe(0);
  }
});

test("a whitespace-free output (compact JSON) costs about what a prose output of the same size costs to index", () => {
  const rows = () => JSON.stringify(Array.from({ length: 1800 }, (_, i) => ({ id: i, name: `item-${i}`, path: `/srv/app/src/module${i % 100}/file${i}.ts`, note: `status_"ok"_for_run_${i}` })));
  const time = (make: () => string) => {
    const text = make(), records: unknown[] = [];
    for (let i = 0; i < 80; i++) { records.push(call(`c${i}`, "gh api /repos/x/y/issues")); records.push(output(`c${i}`, `Process exited with code 0\nOutput:\n${text}`)); }
    const started = performance.now(); build(records); return performance.now() - started;
  };
  time(rows); // warm up the regular expressions
  const compact = time(rows), prose = time(() => rows().replace(/,/g, ", "));
  expect(compact / prose).toBeLessThan(2.5);
}, 120_000);
