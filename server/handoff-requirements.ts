import { createHash } from "node:crypto";
import { handoffEntrySections, type CardHandoff, type HandoffEntry, type HandoffEntrySection, type HandoffSession, type HandoffReview } from "../shared/handoff";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The version of an obligation, independent of observation timestamps and storage layout. */
export function handoffRequirementsHash(section: HandoffEntrySection, entry: HandoffEntry): string | null {
  const identity = { id: entry.id, sourceId: entry.sourceId, unconfirmed: !!entry.unconfirmed };
  // Narrow through the section's schema without retaining rev/at/by or a whole-body contentRef.
  const value = entry as unknown as Record<string, unknown>;
  const fields = (...keys: string[]) => Object.fromEntries(keys.map(key => [key, value[key]]));
  let requirement: unknown;
  switch (section) {
    case "inputs":
      if (!["open", "received"].includes(String(value.status)) && !value.standing && !entry.unconfirmed) return null;
      requirement = { ...fields("status", "images", "imagesLost"), original: entry.sourceHash ?? value.textRef ?? hash(value.text ?? ""), standing: !!value.standing };
      break;
    case "questions":
      if (value.status !== "open" && !entry.unconfirmed) return null;
      requirement = fields("kind", "text", "askedBy", "status"); break;
    case "reviews":
      requirement = fields("cycle", "round", "reviewerId", "verdict", "summary", "findings", "risks", "gaps", "delivery"); break;
    case "notes":
      if (entry.by.kind !== "human" && !["incident", "hazard", "direction", "environment"].includes(String(value.kind))) return null;
      requirement = fields("kind", "text"); break;
    case "gaps":
      if (value.status !== "open" && !entry.unconfirmed) return null;
      // Growth of an open grouped gap is the same obligation; a reopened one names the count it grew past.
      requirement = { ...fields("kind", "text", "status"), ...((value.resolution as { count?: number } | undefined)?.count ? { acknowledged: (value.resolution as { count: number }).count } : {}) }; break;
    case "problems":
      if (value.status !== "open") return null;
      requirement = fields("text", "status", "note"); break;
    case "pitfalls": requirement = fields("text"); break;
    case "running":
      if (value.status === "done") return null;
      requirement = fields("what", "how", "check", "owner", "status", "result"); break;
    case "ledger": {
      const session = entry as HandoffSession;
      // In-flight placeholders and exec sessions of the running turn surface on the card, but they are not newly arrived requirements until the turn is over.
      const background = session.background.filter(item => item.status !== "closed" && !item.inFlight && !item.transient).map(({ id, kind, ref, label, status }) => ({ id, kind, ref, label, status })).sort((a, b) => a.id.localeCompare(b.id));
      const through = !session.endedAt ? session.through : undefined;
      const coverage = through && (through.gaps > 0 || through.lagBytes > 0) ? { gaps: through.gaps, lag: through.lagBytes > 0, ...(through.gaps ? { identity: through.identity } : {}) } : undefined;
      if (!background.length && !coverage) return null;
      requirement = { agentId: session.agentId, background, coverage }; break;
    }
    default: return null; // Agent-authored state/next/checkpoint text is not a newly arrived requirement.
  }
  return hash({ ...identity, requirement });
}

/** Bounded by the current 1-MiB record and its overflow indexes; never scans historical bodies. */
export function handoffRefusalFingerprint(record: CardHandoff): string {
  const reviews = [...record.reviews, ...record.overflow.filter(entry => entry.section === "reviews")].filter(entry => !entry.unconfirmed);
  const cycle = Math.max(-1, ...reviews.map(entry => entry.cycle ?? -1));
  const round = Math.max(-1, ...reviews.filter(entry => entry.cycle === cycle).map(entry => entry.round ?? -1));
  const currentReview = (entry: { cycle?: number; round?: number; unconfirmed?: boolean }) => entry.unconfirmed || (entry.cycle === cycle && entry.round === round);
  const requirements: { id: string; section: string; hash: string }[] = [];
  for (const section of handoffEntrySections) for (const entry of record[section]) {
    if (section === "reviews" && !currentReview(entry as HandoffReview)) continue;
    const fingerprint = handoffRequirementsHash(section, entry);
    if (fingerprint) requirements.push({ id: entry.id, section, hash: fingerprint });
  }
  for (const entry of record.overflow) {
    if (entry.section === "reviews" && !currentReview(entry)) continue;
    // Legacy indexes have no semantic hash. Conservatively require one new refusal when
    // such a body is rehydrated; do not load the archive merely to open the soft gate.
    const fingerprint = entry.requirementsHash === undefined ? entry.contentRef : entry.requirementsHash;
    if (fingerprint) requirements.push({ id: entry.id, section: entry.section, hash: fingerprint });
  }
  requirements.sort((a, b) => a.id.localeCompare(b.id));
  return hash({
    requirements,
    pending: record.pendingOperations.map(({ id, sourceId }) => ({ id, sourceId })).sort((a, b) => a.id.localeCompare(b.id)),
    git: record.git.map(({ repo, sha, dirtyHash, error }) => ({ repo, sha, dirtyHash, error })).sort((a, b) => a.repo.localeCompare(b.repo)),
  });
}
