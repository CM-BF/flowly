import type { SessionPolicyFacts } from "./session-measurement";

export const rotationLimits = {
  bytesRotate: 64 * 2 ** 20, bytesNoRead: 200 * 2 ** 20,
  tightFill: 0.70, coldFill: 0.50, tightMax: 300_000, coldMax: 250_000,
  coldResume: 100_000, minGrowth: 30_000, tightGapMs: 20 * 60_000,
  softPerRun: 4, bytesPerRunBeforeHold: 3, unknownTurns: 8, unknownActiveMs: 3 * 3_600_000,
};
export type RotationLimits = typeof rotationLimits;
export type RotationRule = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
export type RotationDecision = {
  action: "keep" | "rotate" | "hold"; rule: RotationRule;
  boundary: "tight" | "other" | "followup"; forced: boolean; reason: string;
};
export type RotationInput = {
  facts: SessionPolicyFacts; now: number; kind?: string; lastCardTurnEndAt?: number;
  busy?: boolean; archived?: boolean; missing?: boolean; starting?: boolean;
  role: "implementer" | "reviewer"; error?: string; fallback?: boolean; requested?: boolean; newCycle?: boolean;
  softCount?: number; byteCount?: number; abandoned?: boolean; cached?: RotationDecision;
};

/** Context rejection is a poisoned conversation; a temporary host/provider failure is not. */
export function poisonedSession(message: string) {
  return /context.{0,30}(?:overflow|exceed|too (?:long|large)|limit)|(?:prompt|input|history).{0,30}(?:too (?:long|large)|cannot.{0,10}(?:restore|recover))|invalid_request_error.{0,60}(?:400|context|prompt)|(?:HTTP\s*)?400.{0,60}invalid_request_error/i.test(message);
}

/** Estimated cache state, separate from the deliberately conservative finalization safety check. */
export function sessionWarmth(facts: SessionPolicyFacts, now: number): "warm" | "cold" | "unknown" {
  const last = Math.max(facts.lastTurnEndAt ?? 0, facts.lastRequestAt ?? 0);
  if (!last || now < last) return "unknown";
  const idle = now - last;
  if (facts.ttlKind === "codex" || facts.provider === "codex") {
    if (idle < 120 * 60_000) return "warm";
    if (idle >= 360 * 60_000) return "cold";
    return facts.C === undefined ? "unknown" : facts.C < 200_000 ? "warm" : "cold";
  }
  const ttl = facts.ttlKind === "claude-1h" ? 55 * 60 : facts.ttlKind === "claude-5m" ? 4 * 60 : undefined;
  return ttl === undefined ? "unknown" : idle < ttl * 1000 ? "warm" : "cold";
}

/** First matching rule wins. Unknown measurements never become a fictional zero or a cold-cache fact. */
export function rotationDecision(input: RotationInput, overrides: Partial<RotationLimits> = {}): RotationDecision {
  const limits = { ...rotationLimits, ...overrides }, f = input.facts;
  const warmth = sessionWarmth(f, input.now);
  const followup = ["nudge", "retry", "cooldown", "host_retry", "finalize"].includes(input.kind ?? "");
  const recent = input.lastCardTurnEndAt !== undefined && input.now >= input.lastCardTurnEndAt && input.now - input.lastCardTurnEndAt <= limits.tightGapMs;
  const tight = ["changes", "round", "comment"].includes(input.kind ?? "") && recent && (warmth === "warm" || f.ttlKind === "claude-5m");
  const boundary = followup ? "followup" : tight ? "tight" : "other";
  const keep = (reason: string): RotationDecision => ({ action: "keep", rule: "R6", boundary, forced: false, reason });
  const rotate = (rule: RotationRule, reason: string, forced: boolean): RotationDecision => ({ action: "rotate", rule, boundary, forced, reason });
  const bytes = (rule: "R0" | "R1", reason: string) => (input.byteCount ?? 0) + 1 >= limits.bytesPerRunBeforeHold
    ? { ...rotate(rule, reason, true), action: "hold" as const } : rotate(rule, reason, true);
  if (input.busy) return keep("The session or its permissions are still active; wait for a boundary.");
  if (input.fallback) return rotate("R0", "The role must use its fallback model.", true);
  if ((input.role === "reviewer" || input.starting) && (input.archived || input.missing)) return rotate("R0", "The previous session is unavailable.", true);
  if (input.error && (input.error === "session_error" || poisonedSession(input.error))) return rotate("R0", "The previous conversation cannot safely continue.", true);
  // noRead is a proven Codex loader constraint, not a blanket assumption about every provider.
  if (f.provider === "codex" && f.B !== undefined && f.B >= limits.bytesNoRead) return bytes("R0", "The history reached the no-load limit.");
  if (f.B !== undefined && f.B >= limits.bytesRotate) return bytes("R1", "The main history reached the early replacement boundary.");
  if (input.requested || input.newCycle) return rotate("R5", input.newCycle ? "A new review cycle needs a fresh reviewer." : "A person requested a fresh session.", false);
  if (input.cached) return input.cached;
  if (input.abandoned) return keep("This instruction already rolled back a soft replacement.");
  if ((input.softCount ?? 0) >= limits.softPerRun) return keep("The run has used its soft replacement budget.");
  if (followup) return keep("A continuation or retry is not a soft replacement boundary.");
  const peak = f.peakC ?? f.C;
  if (f.C0 !== undefined && peak !== undefined && peak - f.C0 < limits.minGrowth) return keep("There is not enough measured context growth for another soft replacement.");
  const tightLimit = f.W === undefined ? undefined : Math.min(limits.tightFill * f.W, limits.tightMax);
  const coldLimit = f.W === undefined ? undefined : Math.min(limits.coldFill * f.W, limits.coldMax);
  if (boundary === "other" && (f.K ?? 0) > 0 && coldLimit !== undefined && peak !== undefined && peak >= coldLimit)
    return rotate("R2", "A confirmed compaction followed substantial context growth.", false);
  const fillLimit = tight ? tightLimit : coldLimit;
  if (f.C !== undefined && fillLimit !== undefined && f.C >= fillLimit)
    return rotate("R3", tight ? "The tight-loop context reached its higher limit." : "The context reached its normal boundary.", false);
  if (boundary === "other" && f.C === undefined && ((f.completedTurns ?? 0) >= limits.unknownTurns || (f.activeMs ?? 0) >= limits.unknownActiveMs))
    return rotate("R3", "Context use is unknown; completed work crossed the bounded proxy limit.", false);
  if (boundary === "other" && warmth === "cold" && f.C !== undefined && f.C >= limits.coldResume)
    return rotate("R4", "The estimated cache is cold and the previous context is large.", false);
  return keep("The available evidence does not require replacement.");
}


export type CheckpointSeen = { agentId: string; fill?: boolean; large?: boolean; growth?: boolean; K?: number };
export type HistorySample = { at: number; bytes: number };
/** The fast-growth reminder looks at the minute samples only from this main history size on. */
export const growthWatchBytes = 64 * 2 ** 20;
/**
 * Whether the minute byte samples matter beyond memory: only where the fast-growth reminder can still fire for this session.
 * Below that a sample is no board change (SESSION-HANDOFF-SPEC §5.1); the board copy only bridges a reload.
 */
export const growthSamplesMatter = (bytes: number | undefined, seen: CheckpointSeen) => bytes !== undefined && bytes >= growthWatchBytes && !seen.growth;
/** A checkpoint is a card/tool reminder, never a native message or an instruction to interrupt. */
export function checkpointObservation(input: { facts: SessionPolicyFacts; now: number; seen?: CheckpointSeen; samples?: HistorySample[]; turnStartedAt?: number; checkpointAt?: number; lastToolAt?: number }) {
  const { facts: f, now } = input, seen: CheckpointSeen = input.seen?.agentId === f.agentId ? { ...input.seen } : { agentId: f.agentId };
  const samples = [...(input.samples ?? []).filter(s => s.at < now), ...(f.B === undefined ? [] : [{ at: now, bytes: f.B }])].slice(-3);
  const reasons: string[] = [];
  if (f.W !== undefined && f.W > 0 && f.C !== undefined && f.C >= .6 * f.W && !seen.fill) { seen.fill = true; reasons.push("Context is at least 60% full."); }
  if (f.B !== undefined && f.B >= 128 * 2 ** 20 && !seen.large) { seen.large = true; reasons.push("The main session history reached 128 MiB."); }
  const [a, b, c] = samples;
  if (!seen.growth && f.B !== undefined && f.B >= growthWatchBytes && a && b && c && b.bytes > a.bytes && c.bytes > b.bytes && c.at > b.at && b.at > a.at) {
    const rate = (c.bytes - a.bytes) / (c.at - a.at);
    if (c.bytes + rate * 10 * 60_000 >= 200 * 2 ** 20) { seen.growth = true; reasons.push("History is growing fast enough to reach 200 MiB within ten minutes."); }
  }
  if (f.K !== undefined && f.K > (seen.K ?? 0)) reasons.push("The provider confirmed a context compaction.");
  if (f.K !== undefined) seen.K = Math.max(seen.K ?? 0, f.K);
  const start = input.turnStartedAt;
  if (start !== undefined && start <= now && (input.checkpointAt === undefined || input.checkpointAt <= now) && now - Math.max(start, input.checkpointAt ?? start) >= 20 * 60_000)
    reasons.push("This turn has run for twenty minutes without a handoff checkpoint.");
  const last = input.lastToolAt;
  const silentSince = start !== undefined && start <= now && (last === undefined || last <= now) && now - Math.max(start, last ?? start) >= 20 * 60_000 ? Math.max(start, last ?? start) : undefined;
  return { reason: reasons.length ? reasons.join(" ") : undefined, seen, samples, silentSince };
}
