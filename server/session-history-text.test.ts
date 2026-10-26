import { expect, test } from "vitest";
import { redactHistory, sanitizeText, unescapeLayers } from "./session-history-text";

test("escaped text keeps its original form when decoding reveals nothing, and is stored decoded and redacted when it does", () => {
  // A narration about line endings and a script with escapes inside its string literals: kept exactly.
  for (const text of ["CRLF 需要按原始字节保留：每行以 `\\r\\n` 结尾。", 'await fs.writeFile("a.json", JSON.stringify(x) + "\\n"); /\\d+/.test(s)'])
    expect(sanitizeText(text)).toEqual({ text, decoded: false });
  // A credential behind escaped quotes slips past the patterns in escaped form; one, two and three layers deep.
  for (const text of ['echo "{\\"password\\":\\"esc-1\\"}"', '{"text":"{\\"apiToken\\":\\"esc-2\\"}"}', '"{\\\\\\"secret\\\\\\":\\\\\\"esc-3\\\\\\"}"']) {
    const safe = sanitizeText(text)!;
    expect(safe.decoded).toBe(true); expect(safe.text).not.toMatch(/esc-\d/); expect(safe.text).toContain("[redacted]");
  }
  // Deeper than the decoder goes: still omitted, never stored half-decoded.
  let nested = '{"password":"too-deep-9"}'; for (let n = 0; n < 6; n++) nested = JSON.stringify(nested);
  expect(sanitizeText(nested)).toBeUndefined();
});

test("history redaction is idempotent, so a redacted excerpt checks clean", () => {
  const samples = ["API_KEY=abc123 token: 'x y' password=\"p w\"", "Authorization: Bearer sk-live-0123456789abcdefABCDEF", "https://user:pw@example.invalid/x", "Cookie: session=abc; theme=dark", '{"clientSecret":"s-1","nested":{"authorization":"t"}}', "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----", "ghp_0123456789abcdefABCDEF0123", "z".repeat(39) + "1", '{password:"x"}', "login(password='p w'); next()"];
  for (const sample of samples) { const once = redactHistory(sample); expect(redactHistory(once)).toBe(once); expect(once).toContain("[redacted"); }
  expect(redactHistory('{"note":"stage a","count":3,"tokens":12}')).toBe('{"note":"stage a","count":3,"tokens":12}');
  // JSON values under credential keys that the capture patterns do not name.
  expect(redactHistory('{"authorization":"plain-auth-1","credentials":"plain-cred-2","privateKey":"pk-3"}')).not.toMatch(/plain-auth-1|plain-cred-2|pk-3/);
});

test("a cut through a long credential shows none of it: a token by its prefix, a private key by its BEGIN or END line", async () => {
  const { excerpt } = await import("./session-history-text");
  const key = "-----BEGIN PRIVATE KEY-----\n" + Array.from({ length: 60 }, (_, n) => `MIIEv${n}QIBADANBgkqhkiG9w0BAQEFAASC/BKcwggSjAgEAAoIBAQ${n}`).join("\n") + "\n-----END PRIVATE KEY-----";
  const token = "ghp_" + "Ab1".repeat(700);
  for (const secret of [key, token]) for (const at of [100, 700, 1000, 2900]) {
    const text = "x ".repeat(at) + secret + " y".repeat(4000);
    const shown = excerpt([{ text }], [{ head: 1500, tail: 1500 }, { head: 150, tail: 250 }], { from: 0, to: text.length })!.variants.map((variant) => variant.text).join("\n");
    expect(shown).not.toMatch(/MIIEv\d+QIBAD|BKcwggSj|Ab1Ab1Ab1/);
    const tail = "x ".repeat(4000) + secret + " y".repeat(at);
    const end = excerpt([{ text: tail }], [{ head: 1500, tail: 1500 }, { head: 150, tail: 250 }], { from: 0, to: tail.length })!.variants.map((variant) => variant.text).join("\n");
    expect(end).not.toMatch(/MIIEv\d+QIBAD|BKcwggSj|Ab1Ab1Ab1/);
  }
});

test("the decoder handles JSON and script escapes and leaves unknown ones", () => {
  expect(unescapeLayers('a\\"b\\\\c\\u00e9\\x41\\u{1F6F0}\\q')).toBe('a"b\\cé' + "A🛰\\q");
  expect(unescapeLayers("\\\\\\\"x\\\\\\\"")).toBe('"x"');
});
