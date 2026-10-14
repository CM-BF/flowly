/**
 * Cards whose status changed since the previous board snapshot. The first
 * snapshot (empty memory) reports nothing, so opening the board never flashes.
 */
export function statusChanges(
  previous: ReadonlyMap<string, string> | null,
  tasks: readonly { id: string; status: string }[],
): { next: Map<string, string>; changed: string[] } {
  const next = new Map(tasks.map((t) => [t.id, t.status]));
  if (!previous) return { next, changed: [] };
  const changed = tasks
    .filter((t) => previous.has(t.id) && previous.get(t.id) !== t.status)
    .map((t) => t.id);
  return { next, changed };
}
