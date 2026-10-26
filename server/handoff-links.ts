import type { CardHandoff } from "../shared/handoff";

export type ContinuityKind = "child" | "dependency" | "parent";
export type ContinuityReader = (taskId: string, kind: ContinuityKind) => Promise<string | undefined>;

/** Cross-card context deliberately excludes original inputs, human notes and private conversation. */
export function linkedContinuity(record: CardHandoff, kind: ContinuityKind) {
  const budget = kind === "child" ? 600 : kind === "parent" ? 1000 : 1500;
  const reserve = 100;
  const owned = (entry: { by: { kind: string } }) => entry.by.kind !== "human";
  const parts = [`Handoff r${record.revision}; card ${record.taskId}`];
  if (kind !== "parent" && record.state && owned(record.state)) {
    const available = Math.max(0, budget - reserve - parts.join("\n").length - 40);
    parts.push(`State: ${record.state.text.slice(0, Math.min(300, available))}`);
  }
  if (kind !== "parent") parts.push(`Problems: ${record.problems.filter(owned).length}`);
  const candidates = [
    ...record.pitfalls.filter(owned).map(e => `Pitfall (${e.id}): ${e.text.replace(/\s+/g, " ")}`),
    ...(kind === "parent" ? [] : record.notes.filter(e => e.by.kind === "flowly" && ["incident", "hazard"].includes(e.kind)).map(e => `Incident (${e.id}): ${e.text.replace(/\s+/g, " ")}`)),
    ...(kind === "dependency" ? record.env.filter(owned).map(e => `Environment (${e.id}): ${e.text.replace(/\s+/g, " ")}`) : []),
  ];
  let omitted = 0;
  for (const line of candidates) {
    if (parts.join("\n").length + line.length + 1 > budget - reserve) { omitted++; continue; }
    parts.push(line);
  }
  if (record.overflow.some(e => ["pitfalls", "problems", "env", "notes"].includes(e.section))) omitted += record.overflow.filter(e => ["pitfalls", "problems", "env", "notes"].includes(e.section)).length;
  if (omitted) parts.push(`Omitted ${omitted} entries; open this card's Handoff for details.`);
  return parts.join("\n").slice(0, budget);
}
