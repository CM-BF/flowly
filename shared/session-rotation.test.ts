import { expect, test } from "vitest";
import { checkpointObservation, poisonedSession, rotationDecision, rotationLimits, sessionWarmth, type RotationInput } from "./session-rotation";
const now = 10 * 86_400_000;
const input = (patch: Partial<RotationInput> = {}): RotationInput => ({ role: "implementer", now, kind: "wake", facts: { agentId: "a", provider: "codex", at: now, C: 50_000, C0: 10_000, W: 475_000, B: 100, lastTurnEndAt: now - 1000 }, ...patch });
const facts = (patch: Partial<RotationInput["facts"]>) => input({ facts: { ...input().facts, ...patch } });
test("byte boundaries stay separate from noRead, run for retries and hold only the third distinct trigger", () => {
 expect(rotationDecision(facts({ B: rotationLimits.bytesRotate - 1 })).action).toBe("keep");
 expect(rotationDecision({ ...facts({ B: rotationLimits.bytesRotate }), kind: "retry", abandoned: true, softCount: 4 })).toMatchObject({ action: "rotate", rule: "R1", forced: true });
 expect(rotationDecision(facts({ B: rotationLimits.bytesNoRead }))).toMatchObject({ action: "rotate", rule: "R0" });
 expect(rotationDecision({ ...facts({ B: rotationLimits.bytesRotate }), byteCount: 2 })).toMatchObject({ action: "hold" });
 expect(rotationDecision({ ...facts({ B: rotationLimits.bytesNoRead }), busy: true }).action).toBe("keep");
});
test("tight loops use their actual window and card turn boundary rather than the peer's long run", () => {
 const x = { ...facts({ C: 200_000, C0: 0, W: 475_000 }), kind: "changes", lastCardTurnEndAt: now - 1000 };
 expect(rotationDecision(x).action).toBe("keep");
 expect(rotationDecision({ ...x, facts: { ...x.facts, W: 258_400 } }).rule).toBe("R3");
 expect(rotationDecision({ ...x, facts: { ...x.facts, C: 250_000 }, lastCardTurnEndAt: now - 20 * 60_000 - 1 }).rule).toBe("R3");
 expect(rotationDecision({ ...x, facts: { ...x.facts, provider: "claude", ttlKind: "claude-5m", lastTurnEndAt: now - 15 * 60_000 } }).boundary).toBe("tight");
});
test("confirmed compaction uses the peak; growth and per-run limits prevent churn", () => {
 const x = facts({ C: 40_000, peakC: 300_000, C0: 10_000, K: 1 });
 expect(rotationDecision(x).rule).toBe("R2");
 expect(rotationDecision({ ...x, kind: "round", lastCardTurnEndAt: now - 1 }).action).toBe("keep");
 expect(rotationDecision({ ...x, facts: { ...x.facts, K: 0 } }).action).toBe("keep");
 expect(rotationDecision({ ...x, facts: { ...x.facts, C0: 270_001 } }).action).toBe("keep");
 expect(rotationDecision({ ...x, facts: { ...x.facts, C0: 270_000 } }).rule).toBe("R2");
 expect(rotationDecision({ ...x, softCount: 4 }).action).toBe("keep");
 expect(rotationDecision({ ...x, abandoned: true }).action).toBe("keep");
 expect(rotationDecision({ ...x, kind: "nudge" }).action).toBe("keep");
});
test("cache estimates distinguish provider tiers, unknown evidence and clock reversal", () => {
 expect(sessionWarmth({ ...input().facts, lastTurnEndAt: now - 121 * 60_000, C: 199_999 }, now)).toBe("warm");
 expect(sessionWarmth({ ...input().facts, lastTurnEndAt: now - 121 * 60_000, C: 200_000 }, now)).toBe("cold");
 expect(sessionWarmth({ ...input().facts, lastTurnEndAt: now - 360 * 60_000 }, now)).toBe("cold");
 expect(sessionWarmth({ ...input().facts, provider: "claude", ttlKind: "unknown" }, now)).toBe("unknown");
 expect(sessionWarmth({ ...input().facts, provider: "claude", ttlKind: "claude-1h", lastTurnEndAt: now - 55 * 60_000 }, now)).toBe("cold");
 expect(sessionWarmth({ ...input().facts, provider: "claude", ttlKind: "claude-5m", lastTurnEndAt: now - 4 * 60_000 }, now)).toBe("cold");
 expect(sessionWarmth({ ...input().facts, lastTurnEndAt: now + 1 }, now)).toBe("unknown");
 expect(rotationDecision(facts({ C: 100_000, lastTurnEndAt: now - 360 * 60_000 })).rule).toBe("R4");
});
test("unknown context proxies count completed work, not passive session age", () => {
 expect(rotationDecision(facts({ C: undefined, completedTurns: 7, lastTurnEndAt: now - 8 * 3_600_000 })).action).toBe("keep");
 expect(rotationDecision(facts({ C: undefined, completedTurns: 8 })).rule).toBe("R3");
 expect(rotationDecision(facts({ C: undefined, activeMs: 3 * 3_600_000 })).rule).toBe("R3");
 expect(rotationDecision(facts({ C: undefined, C0: undefined, completedTurns: 8 })).rule).toBe("R3");
});
test("explicit boundaries override soft budgets but missing live implementers still follow recovery", () => {
 expect(rotationDecision({ ...input(), requested: true, softCount: 4 }).rule).toBe("R5");
 expect(rotationDecision({ ...input(), newCycle: true, role: "reviewer" }).rule).toBe("R5");
 expect(rotationDecision({ ...input(), missing: true, role: "reviewer" }).rule).toBe("R0");
 expect(rotationDecision({ ...input(), missing: true }).action).toBe("keep");
 expect(poisonedSession("context window exceeded")).toBe(true);
 expect(poisonedSession("HTTP 400 invalid_request_error")).toBe(true);
 expect(poisonedSession("temporary websocket closed")).toBe(false);
});


test("running checkpoints use observed facts and durable watermarks without resending messages",()=>{
 const f={...input().facts,C:285_000,W:475_000,B:128*2**20,K:1};
 const first=checkpointObservation({facts:f,now});expect(first.reason).toContain("60%");expect(first.reason).toContain("128 MiB");expect(first.reason).toContain("compaction");
 expect(checkpointObservation({facts:f,now:now+60_000,seen:first.seen,samples:first.samples}).reason).toBeUndefined();
 const growth=checkpointObservation({facts:{...f,C:0,K:0,B:100*2**20},now,samples:[{at:now-120_000,bytes:70*2**20},{at:now-60_000,bytes:85*2**20}]});expect(growth.reason).toContain("ten minutes");
 const unknown=checkpointObservation({facts:{agentId:"a",provider:"unknown",at:now},now});expect(unknown.reason).toBeUndefined();expect(unknown.silentSince).toBeUndefined();
});

test("silence and active checkpoint age use a proved current turn and real checkpoint/tool times",()=>{
 const opts={facts:input().facts,now,turnStartedAt:now-21*60_000};
 expect(checkpointObservation(opts).silentSince).toBe(opts.turnStartedAt);expect(checkpointObservation(opts).reason).toContain("twenty minutes");
 const recent={...opts,lastToolAt:now-1000,checkpointAt:now-1000};expect(checkpointObservation(recent).silentSince).toBeUndefined();expect(checkpointObservation(recent).reason).toBeUndefined();
 expect(checkpointObservation({...opts,lastToolAt:NaN,checkpointAt:NaN}).silentSince).toBeUndefined();
 expect(checkpointObservation({...opts,lastToolAt:now+1,checkpointAt:now+1}).reason).toBeUndefined();
 expect(checkpointObservation({...opts,lastToolAt:now+1}).silentSince).toBeUndefined();
});
