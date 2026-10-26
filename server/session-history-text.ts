import { redactCaptureText } from "./handoff-capture-records";

/** JSON keys whose value is a credential: the names the argument walker redacts by key. */
export const secretKey = /password|passwd|passphrase|secret|credential|token|apikey|authorization|cookie|privatekey/i;
/** A credential key, compared without its separators: one of `secretKey`, or exactly a short name (Docker's `auth`). */
export const credentialKey = (key: string) => { const name = key.replace(/[^a-z0-9]/gi, ""); return secretKey.test(name) || /^(?:auth|pass|pwd)$/i.test(name); };

/**
 * What `cat -n`, `nl`, `grep -n` and `rg -n` put before a line they print: a line number, after a file name for grep.
 * A credential file printed that way is still recognized from its line start.
 */
const numbered = String.raw`(?:[ \t]*\d+\t|(?:[^\s:]+:)?\d+[:-])?`;
/**
 * A .pgpass line's `host:port:database:user:` (SESSION-HANDOFF-SPEC §8.1): a host name, an address or `*`, a port or `*`,
 * and fields with no quote, brace, bracket or whitespace (`\:` escapes a colon). Lines that `grep -n` prints over JSONL
 * or a timestamped log (`notes.jsonl:3:{"id":…`, `app.log:88:2026-10-25T10:00:00Z ERROR …`) are not one.
 */
const pgpassPrefix = String.raw`${numbered}(?:(?:[A-Za-z0-9_.-]|\\[:\\])+|\*):(?:\d{1,5}|\*):(?:(?:[^:\s"'{}[\]\\]|\\[:\\])+:){2}`;
/** A .pgpass line: its password runs to the end of the line, with no whitespace in it. */
const pgpass = new RegExp(String.raw`^(${pgpassPrefix})(?:[^\s\\]|\\.)+(?=[ \t]*\r?$)`, "gm");
/**
 * .netrc entries (`machine host login user password secret`, on one line or several): a `machine` entry anywhere, a
 * `default` entry only at a line start ("the default password policy" is prose).
 */
const netrc = new RegExp(String.raw`(\bmachine[ \t]+\S+|^${numbered}[ \t]*default)((?:\s+(?:login|account)\s+\S+)*\s+password\s+)[^\s"']+`, "gim");
const redactOnce = (value: string) => redactCaptureText(value)
  // A tail window can start inside a private key: everything up to its END line goes.
  .replace(/^(?:(?!-----BEGIN )[\s\S])*?-----END (?:[A-Z ]*PRIVATE KEY(?: BLOCK)?|OPENSSH PRIVATE KEY)-----/, "[redacted private key]")
  .replace(/-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?(?:-----END PGP PRIVATE KEY BLOCK-----|$)/g, "[redacted private key]")
  // A cookie header or value: name=value pairs, or one token (a test named "cookie: keeps SameSite" is not one).
  .replace(/((?:set-)?cookie(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)(?=[^\s=;,"'\\]*=|[^\s;,"'\\]+(?:[;,"'\\]|[ \t]*(?:\r?\n|$))|[A-Za-z0-9%._~+/-]{16})[^\r\n"'\\]+/gi, "$1[redacted]")
  .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
  .replace(netrc, "$1$2[redacted]")
  // A `password` line on its own (a .netrc entry over several lines, cut above it): kept for privacy, so a line that is
  // exactly "password reset" reads "password [redacted]".
  .replace(/^([ \t]*password[ \t]+)[^\s"']+(?=[ \t]*\r?$)/gim, "$1[redacted]")
  .replace(pgpass, "$1[redacted]")
  // Password flags: `mysql -pSECRET`, `--password SECRET` (`--password=SECRET` is a KEY=value).
  .replace(/(\b(?:mysql|mysqldump|mysqladmin|mariadb(?:-dump)?)\b[^\r\n]*?[ \t]-p)[^\s"'-][^\s"']*/gi, "$1[redacted]")
  .replace(/((?:^|[ \t])--(?:password|passwd|pass)[ \t]+)[^\s"'-][^\s"']*/gim, "$1[redacted]")
  .replace(/("([^"\\\r\n]{1,100})"\s*:\s*)"((?:[^"\\\r\n]|\\.){1,4000})"/g, (all, head: string, key: string, value: string) => value !== "[redacted]" && credentialKey(key) ? `${head}"[redacted]"` : all);
/**
 * The capture redaction plus cookies, credentials in any URL scheme, .netrc and .pgpass lines, password flags, PGP
 * private keys and JSON string values under credential keys, run
 * until nothing changes: the capture patterns are not idempotent on their own (`password="x"}` becomes
 * `password=[redacted]}`, whose unquoted value a second pass swallows), and `sanitizeText` needs a redacted text to
 * redact to itself.
 */
export function redactHistory(value: string): string {
  let current = value;
  for (let n = 0; n < 4; n++) { const next = redactOnce(current); if (next === current) break; current = next; }
  return current;
}

const simple: Record<string, string> = { '"': '"', "'": "'", "\\": "\\", "/": "/", "`": "`", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" };
const escape = /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(["'\\/`bfnrtv0]))/g;
/** JSON and JavaScript string escapes, up to `layers` levels of JSON in JSON; an unknown escape stays as it is. */
export function unescapeLayers(text: string, layers = 4): string {
  let current = text;
  for (let n = 0; n < layers && current.includes("\\"); n++) {
    const next = current.replace(escape, (all, braced?: string, unicode?: string, hex?: string, char?: string) => {
      if (char) return simple[char];
      const code = parseInt(braced ?? unicode ?? hex!, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : all;
    });
    if (next === current) break;
    current = next;
  }
  return current;
}
/** Nothing the redactor removes is visible once the text's escapes are decoded (and none still hides a quote). */
function clean(redacted: string) {
  if (!redacted.includes("\\")) return true;
  const view = unescapeLayers(redacted);
  return !/\\["'\\]/.test(view) && redactHistory(view) === view;
}
export type Sanitized = { text: string; decoded: boolean };
/**
 * Redacted text, or undefined when it cannot be made safe (SESSION-HANDOFF-SPEC §8.1). Escaped text (JSON in JSON, a
 * code-mode script, a narration that writes `\r\n`) keeps its original form when decoding it reveals nothing to
 * redact, so its characters still map onto the source; it is stored decoded and redacted when decoding does reveal
 * something (`\"password\":\"…\"` passes the patterns in escaped form). Deeper escaping than the decoder resolves is
 * refused, never stored half-decoded.
 */
export function sanitizeText(text: string): Sanitized | undefined {
  const plain = redactHistory(text);
  if (clean(plain)) return { text: plain, decoded: false };
  const decoded = redactHistory(unescapeLayers(text));
  return clean(decoded) ? { text: decoded, decoded: true } : undefined;
}

/** Structured tool arguments: JSON strings are decoded, credential keys and text redacted. */
export function safeArguments(input: unknown): { value: unknown; omitted: boolean; decoded: boolean } {
  let nodes = 0, characters = 0, omitted = false, decoded = false;
  const walk = (value: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) throw new Error("Argument structure budget");
    if (typeof value === "string") {
      characters += value.length; if (characters > 512 * 1024) throw new Error("Argument text budget");
      if (/^[\s]*[\[{"]/.test(value)) {
        let parsed: unknown; try { parsed = JSON.parse(value); } catch { /* An opaque command may start with a bracket. */ }
        if (parsed !== undefined) return walk(parsed, depth + 1);
      }
      const safe = sanitizeText(value);
      if (!safe) { omitted = true; return "[escaped content omitted]"; }
      decoded ||= safe.decoded;
      return safe.text;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => { if (++nodes > 4096) throw new Error("Argument field budget"); return [key, credentialKey(key) ? "[redacted]" : walk(item, depth + 1)]; }));
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    throw new Error("Unsupported arguments");
  };
  try { return { value: walk(input ?? {}, 0), omitted, decoded }; }
  catch { return { value: "[arguments omitted: bounded parser]", omitted: true, decoded: false }; }
}

/** A decoded string of a source record and the file offset of its JSON string token, when found. */
export type Field = { text: string; start?: number; bytes?: number };
/**
 * Where each string sits in the raw record: the token JSON.stringify writes, found in order. Codex (serde_json) and
 * Claude Code (JSON.stringify) escape strings the same way; a string not found is located by its record only.
 */
export function locateFields(raw: Buffer, recordFrom: number, texts: string[]): Field[] {
  let cursor = 0;
  return texts.map((text) => {
    const token = Buffer.from(JSON.stringify(text)), at = raw.indexOf(token, cursor);
    if (at < 0) return { text };
    cursor = at + token.length;
    return { text, start: recordFrom + at, bytes: token.length };
  });
}
export type Budget = { readonly head: number; readonly tail: number };
export type Middle = { from: number; to: number; characters: number; exact: boolean };
export type Variant = { text: string; truncated: boolean; middle?: Middle };
export type Excerpt = { characters: number; decoded: boolean; unsafe: boolean; variants: Variant[] };

const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** Fields joined by a newline: the text an excerpt cuts, the file offset of one of its positions and its field. */
function joined(fields: Field[]) {
  const text = fields.map((field) => field.text).join("\n");
  const find = (position: number) => {
    let offset = 0;
    for (const [index, field] of fields.entries()) {
      if (position <= offset + field.text.length) return { index, field, within: Math.max(0, position - offset) };
      offset += field.text.length + 1;
    }
    return undefined;
  };
  // The token is `"` + escaped prefix + escaped suffix + `"`: measure whichever side of the position is shorter.
  const byteAt = (position: number) => {
    const found = find(position), start = found?.field.start, bytes = found?.field.bytes;
    if (!found || start === undefined || bytes === undefined) return undefined;
    const { field: { text }, within } = found;
    return within <= text.length / 2 ? start + Buffer.byteLength(JSON.stringify(text.slice(0, within))) - 1 : start + bytes - Buffer.byteLength(JSON.stringify(text.slice(within))) + 1;
  };
  return { text, byteAt, fieldAt: (position: number) => find(position)?.index };
}
function snapHead(text: string, at: number) {
  const line = text.lastIndexOf("\n", at - 1);
  let cut = line >= 0 && line >= at - 200 ? line + 1 : at;
  if (cut > 0 && high(text.charCodeAt(cut - 1))) cut--;
  return cut;
}
function snapTail(text: string, at: number) {
  const line = text.indexOf("\n", at);
  let cut = line >= 0 && line < at + 200 ? line + 1 : at;
  if (cut < text.length && low(text.charCodeAt(cut))) cut--;
  return cut;
}
const marker = (middle: Middle) => middle.exact ? `[… ${middle.characters} characters omitted · source bytes ${middle.from}–${middle.to} …]` : `[… about ${middle.characters} characters omitted · within source bytes ${middle.from}–${middle.to} …]`;
const stub = (middle: Middle) => `[${middle.characters} characters not indexed · ${middle.exact ? "source bytes" : "within source bytes"} ${middle.from}–${middle.to}]`;

/**
 * Characters past a cut that are redacted with it, so a credential across the cut is seen whole (or by what the
 * patterns know it by: a token's start or first 40 characters, a private key's BEGIN or END line). A match that starts
 * before a window and runs more than this far into it would show; where a window may start keeps such matches whole.
 */
const margin = 1024;
/** How far back from its nominal start a tail window may begin; beyond that it is the whole text. */
const windowFloor = 64 * 1024, nearby = 4 * 1024;
/** The end of a line that a rule's match continues past: `password:`, `Authorization: Bearer`, a credential name, an opening quote. */
const carries = /(?:[:=]|\b(?:bearer|basic|token)|(?:token|key|secret|passw|auth|cookie|credential)[\w-]*\\?["']?)[ \t]*(?:\\?["'])?[ \t]*\r?$/i;
/**
 * Before a start inside a line, what a match running past a `,"` can begin with: a single-quoted credential value, a
 * private key, a mysql command line (its `-p` value may follow anything on the line).
 */
const spansElements = /(?:token|key|secret|passw|auth)[\w-]*["']?\s*[=:]\s*'|-----BEGIN |\b(?:mysql|mysqldump|mysqladmin|mariadb)\b/i;
/** A .pgpass line, whose password runs to the end of the line. */
const pgpassLine = new RegExp(`^${pgpassPrefix}`);
const whitespace = (code: number) => code === 32 || code >= 9 && code <= 13;
/** Steps back over lines whose end a rule's match continues past (bounded by `floor`; past it, the whole text). */
function carried(source: string, line: number, floor: number) {
  while (line > 0) {
    if (!carries.test(source.slice(Math.max(0, line - 121), line - 1))) return line;
    const previous = source.lastIndexOf("\n", line - 2) + 1;
    if (previous < floor) return 0;
    line = previous;
  }
  return 0;
}
/** Whether a match could run across the `,"` at `at`: inside a URL's user info, a single-quoted credential value, a private key, a mysql command, a .pgpass line. */
function insideMatch(source: string, at: number, from: number, line: number) {
  if (spansElements.test(source.slice(from, at)) || line >= 0 && pgpassLine.test(source.slice(line, line + 300))) return true;
  for (let i = at - 1; i >= Math.max(0, at - nearby); i--) {
    const code = source.charCodeAt(i);
    if (whitespace(code) || code === 64) return false;
    if (code === 47) return source[i - 1] === "/" && source[i - 2] === ":";
  }
  return true;
}
/**
 * Where a tail window may start without beginning inside a credential rule's match (SESSION-HANDOFF-SPEC §8.1). Every
 * rule but the private-key rules matches within a line, so the window starts at a line, stepping back over a line that
 * ends in a credential name, a `:` or `=`, or an opening quote. A line that starts more than 4 KiB back (compact JSON,
 * a minified file) may instead start at an element's opening quote after a comma: no rule's match crosses a `,"` except
 * a URL's user info, a single-quoted value, a private key or a mysql command line, which keep the line start. Neither
 * within 64 KiB: 0.
 * Not covered: a quoted value that spans lines, and matches longer than 64 KiB other than private keys.
 */
export function tailWindowStart(source: string, nominal: number): number {
  const floor = Math.max(0, nominal - windowFloor), newline = source.lastIndexOf("\n", nominal - 1), line = newline + 1 >= floor && newline >= 0 ? newline + 1 : -1;
  if (line >= 0 && nominal - line <= nearby) return carried(source, line, floor);
  const lowest = Math.max(line, floor, nominal - nearby);
  for (let quote = source.lastIndexOf('"', nominal); quote > lowest; quote = source.lastIndexOf('"', quote - 1)) {
    let before = quote - 1;
    while (before > lowest && (source.charCodeAt(before) === 32 || source.charCodeAt(before) === 9)) before--;
    if (source[before] !== ",") continue;
    if (!insideMatch(source, quote, Math.max(line, floor), line)) return quote;
    break;
  }
  return line >= 0 ? carried(source, line, floor) : 0;
}
type Side = { source: string; safe?: Sanitized; offset: number };
/**
 * Head and tail of the redacted fields at each level (SESSION-HANDOFF-SPEC §8.1), or undefined when a text short enough
 * to show whole cannot be made safe. Only a head window and a tail window (the widest level plus `margin`, the tail
 * starting where `tailWindowStart` puts it) are redacted, so a large output costs about what a small one does, unless
 * its last 64 KiB have no line start and no safe element boundary. A side is cut in the source's own characters when its shown text is
 * a prefix (suffix) of its redacted window, so a credential cut in half shows no more than the whole redaction does, and
 * the omitted middle is then exact source bytes. A decoded side, or unlocated fields, name the bytes that contain it; a
 * side that cannot be made safe shows nothing and the middle grows over it.
 */
export function excerpt(fields: Field[], levels: readonly Budget[], record: { from: number; to: number }): Excerpt | undefined {
  if (!fields.length) return undefined;
  const { text: source, byteAt, fieldAt } = joined(fields), located = fields.every((field) => field.start !== undefined);
  // The bytes of the fields' contents, from inside the first token's opening quote to the last one's closing quote.
  const span = located ? { from: fields[0].start! + 1, to: byteAt(source.length)! } : record;
  const widest = { head: Math.max(...levels.map((level) => level.head)), tail: Math.max(...levels.map((level) => level.tail)) };
  let head: Side, tail: Side, whole: Sanitized | undefined;
  if (source.length <= widest.head + widest.tail + 2 * margin) {
    whole = sanitizeText(source);
    if (!whole && source.length <= widest.head + widest.tail + 80) return undefined;
    head = tail = { source, safe: whole, offset: 0 };
  } else {
    let end = widest.head + margin;
    if (high(source.charCodeAt(end - 1))) end--;
    const start = tailWindowStart(source, source.length - widest.tail - margin);
    head = { source: source.slice(0, end), safe: sanitizeText(source.slice(0, end)), offset: 0 };
    tail = { source: source.slice(start), safe: sanitizeText(source.slice(start)), offset: start };
  }
  const front = (budget: number) => {
    const { safe } = head;
    if (!budget || !safe) return { shown: "", at: 0, exact: true };
    if (safe.decoded) { const cut = snapHead(safe.text, budget); return { shown: safe.text.slice(0, cut), at: cut, exact: false }; }
    // A cut inside something redacted shows the prefix redacted differently: back off until it is a true prefix.
    for (let h = snapHead(head.source, budget), tries = 0; h > 0 && tries < 9; h = snapHead(head.source, Math.floor(h * 0.75)), tries++) {
      const shown = safe.text === head.source ? head.source.slice(0, h) : redactHistory(head.source.slice(0, h));
      if (safe.text.startsWith(shown) && shown.length <= budget + 64) return { shown, at: h, exact: true };
    }
    return { shown: "", at: 0, exact: true };
  };
  /** `floor`: where the head ends; the tail never starts before it, so the two never overlap. */
  const back = (budget: number, floor = 0) => {
    const { safe } = tail, length = tail.source.length;
    if (!budget || !safe) return { shown: "", at: source.length, exact: true };
    if (safe.decoded) { const cut = snapTail(safe.text, safe.text.length - budget); return { shown: safe.text.slice(cut), at: source.length - (safe.text.length - cut), exact: false }; }
    for (let t = Math.max(snapTail(tail.source, length - budget), floor - tail.offset), tries = 0; t < length && tries < 9; t = snapTail(tail.source, length - Math.floor((length - t) * 0.75)), tries++) {
      const shown = safe.text === tail.source ? tail.source.slice(t) : redactHistory(tail.source.slice(t));
      if (safe.text.endsWith(shown) && shown.length <= budget + 64) return { shown, at: tail.offset + t, exact: true };
    }
    return { shown: "", at: source.length, exact: true };
  };
  const variant = (budget: Budget): Variant => {
    if (whole && whole.text.length <= budget.head + budget.tail + 80) return { text: whole.text, truncated: false };
    const first = front(budget.head);
    let last = back(budget.tail);
    // A text shorter than both budgets that redaction made longer than them: the tail starts where the head ends, and
    // when the two meet the excerpt is the whole redacted text.
    if (last.at < first.at) last = back(budget.tail, first.at);
    if (whole && last.at === first.at && first.shown + last.shown === whole.text) return { text: whole.text, truncated: false };
    const exact = located && first.exact && last.exact;
    // Exact only inside one string: across fields the bytes also hold the JSON between them.
    const middle = { from: located && first.exact ? byteAt(first.at)! : span.from, to: located && last.exact ? byteAt(last.at)! : span.to, characters: Math.max(0, last.at - first.at), exact: exact && fieldAt(first.at) === fieldAt(last.at) };
    return { text: first.shown || last.shown ? `${first.shown}\n${marker(middle)}\n${last.shown}` : stub(middle), truncated: true, middle };
  };
  return { characters: whole?.text.length ?? source.length, decoded: !!(head.safe?.decoded || tail.safe?.decoded || whole?.decoded), unsafe: !head.safe || !tail.safe, variants: levels.map(variant) };
}
