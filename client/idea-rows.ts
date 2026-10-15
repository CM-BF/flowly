/** Current items, with leaving ones re-inserted at their last index so nothing jumps while they collapse. */
export function exitRows<T extends { id: string }>(
  items: readonly T[],
  leaving: readonly { item: T; index: number }[],
  initial: ReadonlySet<string>,
) {
  const rows = items.map((item) => ({ item, leaving: false, entering: !initial.has(item.id) }));
  for (const { item, index } of [...leaving].sort((a, b) => a.index - b.index))
    if (!items.some((i) => i.id === item.id)) rows.splice(Math.min(index, rows.length), 0, { item, leaving: true, entering: false });
  return rows;
}
