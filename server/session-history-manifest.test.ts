import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionHistoryExcerpts, type SessionHistoryPage } from "../shared/session-history";
import { SessionHistory } from "./session-history";
import { excerpt } from "./session-history-text";
import { publishedManifests, releaseHistory } from "./session-history-fixture";

// read() refuses a manifest its schema does not accept ('skeleton_invalid'), and rebuild=true builds the same manifest,
// so the builder never publishes one (SESSION-HANDOFF-SPEC §8.1, §21.16).
const roots: string[] = [], readers: SessionHistory[] = [];
// Every manifest these tests publish is one read() accepts (SESSION-HANDOFF-SPEC §21.16).
afterEach(async () => { expect(await releaseHistory(readers, roots)).toEqual([]); });

async function build(id: string, text: string) {
  const root = await mkdtemp(join(tmpdir(), "flowly-history-manifest-")); roots.push(root);
  const folder = join(root, "codex", "sessions", "2026", "10", "25"); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `rollout-manifest-${id}.jsonl`), text);
  const reader = new SessionHistory(join(root, "derived"), { codexHome: join(root, "codex") }); readers.push(reader);
  const agent = { id: `manifest-${id.slice(-4)}`, provider: "codex", persistence: { provider: "codex", nativeHandle: id, sessionId: id } } as never;
  const settle = async (query: Parameters<SessionHistory["read"]>[1]) => {
    await reader.read(agent, query);
    let page!: SessionHistoryPage;
    await vi.waitFor(async () => { page = await reader.read(agent, { session: "#1" }); expect(page.status).not.toBe("building"); }, { timeout: 10_000, interval: 10 });
    return page;
  };
  const page = await settle({ session: "#1" });
  return { root, page, settle, find: (query: string) => reader.read(agent, { session: "#1", query, limit: 20 }) };
}
const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: "2026-10-25T10:00:00.000Z", type, payload }) + "\n";
const prose = (n: number) => { const w = ["alpha", "beta", "gamma", "delta", "note", "path", "value"]; let s = "", i = 0; while (s.length < n) s += w[(i++ * 3) % w.length] + " "; return s.slice(0, n); };
/** `grep token_count rollout.jsonl` output: each short value under a *_tokens key grows by about 8 characters when redacted. */
const usage = (tag: string) => `{"${tag}_input_tokens":1,"${tag}_output_tokens":2,"${tag}_total_tokens":3}`;
function grown(length: number) {
  const head = [usage("a"), usage("b")].join(" ") + " ", tail = " " + [usage("c"), usage("d")].join(" ");
  return head + prose(length - head.length - tail.length) + tail;
}

test("an output that redaction grows past both budgets keeps its index readable, and a rebuild finds it", async () => {
  const id = "01a17565-6df7-7f20-b755-0000000000d1", output = grown(2990);
  const x = await build(id, line("session_meta", { id })
    + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Check the usage parser; the codeword is OSPREY-4410." }] })
    + line("response_item", { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "grep token_count rollout.jsonl | tail -4" }) })
    + line("response_item", { type: "function_call_output", call_id: "c1", output }));
  expect(x.page.status).toBe("ready");
  expect((await x.settle({ session: "#1", rebuild: true })).status).toBe("ready");
  expect((await x.find("OSPREY-4410")).entries).toHaveLength(1);
  // The output reads once, in order, with no duplicated text and no inverted range.
  const [entry] = (await x.find("c_total_tokens")).entries;
  expect(entry.text.match(/"a_input_tokens"/g)).toHaveLength(1); expect(entry.text.match(/"d_total_tokens"/g)).toHaveLength(1);
  if (entry.middle) expect(entry.middle.to).toBeGreaterThanOrEqual(entry.middle.from);
  for (const gap of x.page.gaps) expect(gap.bytes ?? 0).toBeGreaterThanOrEqual(0);
  expect((await publishedManifests(join(x.root, "derived"))).map((manifest) => manifest.valid)).toEqual([true]);
});

test("a head and tail that meet or overlap never invert the middle or show text twice", () => {
  for (const length of [2930, 2950, 2970, 2990, 3000, 3010, 3040]) {
    const text = grown(length), token = Buffer.from(JSON.stringify(text)), raw = Buffer.concat([Buffer.from('{"output":'), token, Buffer.from("}")]);
    const cut = excerpt([{ text, start: 10, bytes: token.length }], sessionHistoryExcerpts.output, { from: 0, to: raw.length })!;
    for (const variant of cut.variants) {
      if (variant.middle) { expect(variant.middle.to).toBeGreaterThanOrEqual(variant.middle.from); expect(variant.middle.characters).toBeGreaterThanOrEqual(0); }
      for (const tag of ["a", "b", "c", "d"]) expect((variant.text.match(new RegExp(`"${tag}_input_tokens"`, "g")) ?? []).length).toBeLessThanOrEqual(1);
    }
    // The widest level shows the whole redacted text once, in order.
    expect(cut.variants[0].text).toMatch(/^\{"a_input_tokens"[\s\S]*"d_total_tokens":\[redacted\]$/);
  }
});

test("a record whose first two type values are long keeps the index readable", async () => {
  const id = "01a17565-6df7-7f20-b755-0000000000d2", long = "x".repeat(60);
  const x = await build(id, line("session_meta", { id })
    + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "The codeword is OSPREY-4411." }] })
    + JSON.stringify({ timestamp: "2026-10-25T10:00:00.000Z", type: `vendor_extension_${long}`, payload: { type: `vendor_payload_${long}` } }) + "\n");
  expect(x.page.status).toBe("ready");
  expect(x.page.growth?.every((growth) => growth.type.length <= 100)).toBe(true);
  expect((await x.find("OSPREY-4411")).entries).toHaveLength(1);
  expect(x.page.gaps.map((gap) => gap.kind)).toContain(`unsupported_record/vendor_extension_${"x".repeat(13)}`);
  expect((await publishedManifests(join(x.root, "derived"))).every((manifest) => manifest.valid)).toBe(true);
  expect(JSON.parse(await readFile((await publishedManifests(join(x.root, "derived")))[0].path, "utf8")).growth.length).toBeGreaterThan(0);
});
