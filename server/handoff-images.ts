import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { OutgoingImage } from "../shared/composer";
import { ToolError } from "./tool-error";

const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as const;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const budget = { files: 20, bytes: 20 * 1024 * 1024 };

/** Keep original bytes once; no transformation and no image payload in the semantic record. */
export async function persistHandoffImages(root: string, taskId: string, sourceId: string, images: readonly OutgoingImage[]) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(taskId)) throw new ToolError("HANDOFF_UNAVAILABLE", "Invalid card image identity.");
  if (!images.length) return { images: [] as string[], lost: 0 };
  const directory = join(root, taskId, "images");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new ToolError("HANDOFF_UNAVAILABLE", "Handoff images directory is not an owned ordinary directory.");
  let files = 0, bytes = 0;
  const names = new Set<string>();
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (++files > 1000) throw new ToolError("HANDOFF_TOO_LARGE", "The image directory exceeds its inventory budget; existing files are preserved.");
    const metadata = await lstat(join(directory, entry.name));
    if (!metadata.isFile()) throw new ToolError("HANDOFF_UNAVAILABLE", "An unexpected image-directory entry was preserved.");
    bytes += metadata.size;
    names.add(entry.name);
  }
  const retained: string[] = [];
  let lost = 0;
  for (let index = 0; index < images.length; index++) {
    const image = images[index], data = Buffer.from(image.data, "base64");
    const name = `${hash(sourceId).slice(0, 32)}-${index}.${extensions[image.mimeType]}`;
    const prefix = `${hash(sourceId).slice(0, 32)}-${index}.`;
    if ([...names].some((existing) => existing.startsWith(prefix) && existing !== name)) throw new ToolError("OPERATION_REUSED", "This image source already has a different media type; the original is preserved.");
    const path = join(directory, name);
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (existing) {
      if (!existing.isFile() || existing.size !== data.length || hash(await readFile(path)) !== hash(data)) throw new ToolError("OPERATION_REUSED", "This image source already refers to different bytes; the original is preserved.");
      retained.push(`images/${name}`); continue;
    }
    if (files >= budget.files || bytes + data.length > budget.bytes) { lost++; continue; }
    const temporary = join(directory, `image-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const folder = await open(directory, "r");
      try { await folder.sync(); } finally { await folder.close(); }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    files++; bytes += data.length; names.add(name); retained.push(`images/${name}`);
  }
  return { images: retained, lost };
}
