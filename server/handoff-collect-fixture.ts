import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { handoffEntrySections, type CardHandoff } from "../shared/handoff";

// Test fixture only; runtime entries never import this module. An account of the entry bodies a card's files reference,
// written from the file formats and independent of the store's own collection (SESSION-HANDOFF-SPEC §5.1).
const hex = /^[a-f0-9]{64}$/;
const json = async <T>(path: string): Promise<T | null> => readFile(path, "utf8").then((text) => JSON.parse(text) as T, (error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
const names = (path: string) => readdir(path).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[]; throw error; });
function recordRefs(record: CardHandoff | null, into: Set<string>) {
  if (!record) return;
  for (const section of handoffEntrySections) for (const entry of record[section] ?? []) if (entry.contentRef) into.add(entry.contentRef);
  for (const entry of record.overflow ?? []) into.add(entry.contentRef);
}

/**
 * `handoffs` is `<data>/handoffs`. Referenced: the current record's entries and overflow, an unfinished write (pending.json),
 * every archive line, every sealed snapshot's entries and overflow, the latest-version and source pointers (a pending
 * operation reaches its original through its source pointer). `unreferenced` are bodies none of them names; `missing` are
 * names without a body.
 */
export async function bodyReferences(handoffs: string, taskId = "card") {
  const folder = join(handoffs, taskId), referenced = new Set<string>();
  recordRefs(await json<CardHandoff>(join(handoffs, `${taskId}.json`)), referenced);
  const intent = await json<{ after: CardHandoff; pointers: { ref: string }[] }>(join(folder, "pending.json"));
  if (intent) { recordRefs(intent.after, referenced); for (const pointer of intent.pointers) referenced.add(pointer.ref); }
  const archive = await readFile(join(folder, "archive.jsonl"), "utf8").catch(() => "");
  for (const line of archive.split("\n").filter(Boolean)) referenced.add((JSON.parse(line) as { ref: string }).ref);
  for (const name of await names(join(folder, "sealed"))) recordRefs(await json<CardHandoff>(join(folder, "sealed", name)), referenced);
  for (const index of ["latest", "sources"]) for (const name of await names(join(folder, index))) referenced.add((await json<{ ref: string }>(join(folder, index, name)))!.ref);
  const bodies = new Set((await names(join(folder, "entries"))).filter((name) => name.endsWith(".json") && hex.test(name.slice(0, -5))).map((name) => name.slice(0, -5)));
  return { referenced, bodies, unreferenced: [...bodies].filter((ref) => !referenced.has(ref)).sort(), missing: [...referenced].filter((ref) => !bodies.has(ref)).sort() };
}

/** Every file and directory under `path` (the directory itself included) with what any rewrite would change: inode, size and times. */
export async function tree(path: string) {
  const out: Record<string, string> = {};
  const walk = async (child: string) => {
    const info = await lstat(child);
    out[relative(path, child) || "."] = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (info.isDirectory()) for (const name of await readdir(child)) await walk(join(child, name));
  };
  await walk(path); return out;
}

/** A body as the store names it: the SHA-256 of its JSON. */
export const bodyName = (body: string) => createHash("sha256").update(body).digest("hex");
