import { createHash } from "node:crypto";

/** Provider ids are not size bounded; source identities must remain stable without clipping. */
export function handoffSource(value: string) {
  return value.length <= 240 ? value : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function handoffMessageSource(agentId: string, messageId: string) {
  return handoffSource(messageId.startsWith("comment:") ? messageId : `message:${agentId}:${messageId}`);
}
