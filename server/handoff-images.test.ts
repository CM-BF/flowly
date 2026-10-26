import { afterEach, expect, test } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistHandoffImages } from "./handoff-images";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
test("image originals are retained once across retries, with byte conflicts refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowly-handoff-images-")); roots.push(root);
  const image = { data: Buffer.from("original bytes").toString("base64"), mimeType: "image/png" as const };
  const first = await persistHandoffImages(root, "card", "source", [image]);
  expect(await persistHandoffImages(root, "card", "source", [image])).toEqual(first);
  expect(await readFile(join(root, "card", first.images[0]), "utf8")).toBe("original bytes");
  await expect(persistHandoffImages(root, "card", "source", [{ ...image, data: Buffer.from("different").toString("base64") }])).rejects.toMatchObject({ code: "OPERATION_REUSED" });
  await expect(persistHandoffImages(root, "card", "source", [{ ...image, mimeType: "image/jpeg", data: Buffer.from("different media").toString("base64") }])).rejects.toMatchObject({ code: "OPERATION_REUSED" });
  expect(await readdir(join(root, "card", "images"))).toHaveLength(1);
});
test("exhausting the image count reports the gap without replacing earlier evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowly-handoff-images-")); roots.push(root);
  const image = { data: Buffer.from("a").toString("base64"), mimeType: "image/png" as const };
  for (let i = 0; i < 20; i++) await persistHandoffImages(root, "card", `source-${i}`, [image]);
  expect(await persistHandoffImages(root, "card", "over-budget", [image])).toEqual({ images: [], lost: 1 });
  expect(await readdir(join(root, "card", "images"))).toHaveLength(20);
  expect((await persistHandoffImages(root, "card", "source-0", [image])).lost).toBe(0);
});
