import { redactCaptureText } from "./handoff-capture-records";

/** JSON keys whose value is a credential: the names the argument walker redacts by key. */
export const secretKey = /password|passwd|secret|credential|token|apikey|authorization|cookie|privatekey/i;

const redactOnce = (value: string) => redactCaptureText(value)
  // A tail window can start inside a private key: everything up to its END line goes.
  .replace(/^(?:(?!-----BEGIN )[\s\S])*?-----END (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/, "[redacted private key]")
  .replace(/((?:set-)?cookie(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[^\r\n"'\\]+/gi, "$1[redacted]")
  .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
  .replace(/("([^"\\\r\n]{1,100})"\s*:\s*)"((?:[^"\\\r\n]|\\.){1,4000})"/g, (all, head: string, key: string, value: string) => value !== "[redacted]" && secretKey.test(key.replace(/[^a-z0-9]/gi, "")) ? `${head}"[redacted]"` : all);
/**
 * The capture redaction plus cookies, credentials in any URL scheme and JSON string values under credential keys, run
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
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => { if (++nodes > 4096) throw new Error("Argument field budget"); return [key, secretKey.test(key.replace(/[^a-z0-9]/gi, "")) ? "[redacted]" : walk(item, depth + 1)]; }));
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
 * patterns know it by: a token's start or first 40 characters, a private key's BEGIN or END line).
 */
const margin = 1024;
type Side = { source: string; safe?: Sanitized; offset: number };
/**
 * Head and tail of the redacted fields at each level (SESSION-HANDOFF-SPEC §8.1), or undefined when a text short enough
 * to show whole cannot be made safe. Only a head window and a tail window (the widest level plus `margin`) are redacted,
 * so a large output costs no more than a small one. A side is cut in the source's own characters when its shown text is
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
    let end = widest.head + margin, start = source.length - widest.tail - margin;
    if (high(source.charCodeAt(end - 1))) end--;
    // The tail window starts at whitespace, so it never begins inside a token whose prefix is what names it a credential.
    const floor = Math.max(0, start - 64 * 1024);
    while (start > floor && !/\s/.test(source[start - 1])) start--;
    if (start === floor && floor > 0) start = 0;
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
  const back = (budget: number) => {
    const { safe } = tail, length = tail.source.length;
    if (!budget || !safe) return { shown: "", at: source.length, exact: true };
    if (safe.decoded) { const cut = snapTail(safe.text, safe.text.length - budget); return { shown: safe.text.slice(cut), at: source.length - (safe.text.length - cut), exact: false }; }
    for (let t = snapTail(tail.source, length - budget), tries = 0; t < length && tries < 9; t = snapTail(tail.source, length - Math.floor((length - t) * 0.75)), tries++) {
      const shown = safe.text === tail.source ? tail.source.slice(t) : redactHistory(tail.source.slice(t));
      if (safe.text.endsWith(shown) && shown.length <= budget + 64) return { shown, at: tail.offset + t, exact: true };
    }
    return { shown: "", at: source.length, exact: true };
  };
  const variant = (budget: Budget): Variant => {
    if (whole && whole.text.length <= budget.head + budget.tail + 80) return { text: whole.text, truncated: false };
    const first = front(budget.head), last = back(budget.tail), exact = located && first.exact && last.exact;
    // Exact only inside one string: across fields the bytes also hold the JSON between them.
    const middle = { from: located && first.exact ? byteAt(first.at)! : span.from, to: located && last.exact ? byteAt(last.at)! : span.to, characters: Math.max(0, last.at - first.at), exact: exact && fieldAt(first.at) === fieldAt(last.at) };
    return { text: first.shown || last.shown ? `${first.shown}\n${marker(middle)}\n${last.shown}` : stub(middle), truncated: true, middle };
  };
  return { characters: whole?.text.length ?? source.length, decoded: !!(head.safe?.decoded || tail.safe?.decoded || whole?.decoded), unsafe: !head.safe || !tail.safe, variants: levels.map(variant) };
}
