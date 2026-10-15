/**
 * Images this client sent, by message ID. The daemon timeline keeps only a
 * message's text, so the transcript shows your own images from here. Memory
 * only (bounded); after a reload the message shows its text alone.
 */
const cache = new Map<string, string[]>();
const limit = 40;

export function newMessageId() {
  const crypto = (globalThis as { crypto?: { randomUUID?(): string } }).crypto;
  return crypto?.randomUUID?.() ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function rememberSentImages(messageId: string, uris: readonly string[]) {
  if (!uris.length) return;
  cache.delete(messageId);
  cache.set(messageId, [...uris]);
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}

export function sentImages(messageId: string | undefined): readonly string[] {
  return (messageId && cache.get(messageId)) || [];
}
