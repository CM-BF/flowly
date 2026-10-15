import { createHash } from "node:crypto";

/** `{ etag, value }`, or only `{ etag }` when the caller already holds this value (PERFORMANCE-SPEC §3). */
export function ifChanged<T>(value: T, etag?: string): { etag: string; value?: T } {
  const tag = createHash("sha1").update(JSON.stringify(value)).digest("base64url");
  return tag === etag ? { etag: tag } : { etag: tag, value };
}
