/** Observed facts for a single native identity; missing evidence stays undefined. Times are epoch ms. */
export type SessionPolicyFacts = {
  agentId: string;
  provider: string;
  at: number;
  C?: number;
  W?: number;
  C0?: number;
  B?: number;
  S?: number;
  K?: number;
  peakC?: number;
  completedTurns?: number;
  activeMs?: number;
  lastTurnEndAt?: number;
  lastRequestAt?: number;
  ttlSeconds?: number;
  ttlKind?: "codex" | "claude-1h" | "claude-5m" | "unknown";
  usageAt?: number;
  usageSource?: "snapshot" | "ledger" | "tail";
  coverage?: { gaps?: number; lagBytes?: number; tailBytes?: number; tailComplete?: boolean };
  unknown?: string[];
};
