import type { Status } from "../shared/model";

export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type ColumnBounds = { status: Status; x: number; width: number };
export const columnWidth = 280;
export const columnGap = 12;

export function columnAtPoint(
  point: Point,
  viewport: Rect,
  scrollX: number,
  columns: ColumnBounds[],
): Status | null {
  if (
    point.x < viewport.x ||
    point.x >= viewport.x + viewport.width ||
    point.y < viewport.y ||
    point.y >= viewport.y + viewport.height
  )
    return null;
  const x = point.x - viewport.x + scrollX;
  return columns.find((c) => x >= c.x && x < c.x + c.width)?.status ?? null;
}

export function edgeScroll(
  point: Point,
  viewport: Rect,
  offset: number,
  contentWidth: number,
): number {
  if (
    point.y < viewport.y ||
    point.y >= viewport.y + viewport.height ||
    point.x < viewport.x ||
    point.x >= viewport.x + viewport.width
  )
    return offset;
  const edge = Math.min(48, viewport.width / 4);
  const localX = point.x - viewport.x;
  const step = localX < edge ? -18 : localX > viewport.width - edge ? 18 : 0;
  return Math.max(
    0,
    Math.min(Math.max(0, contentWidth - viewport.width), offset + step),
  );
}

export function drawerWidth(preferred: number, surfaceWidth: number): number {
  const max = Math.min(720, Math.max(340, surfaceWidth - 312));
  return Math.max(340, Math.min(max, preferred));
}

export function isCompactLayout(
  hostCompact: boolean,
  platform: string,
  width: number,
): boolean {
  // Native surfaces start unmeasured; stay compact until a tablet-sized width is known.
  if (width <= 0) return hostCompact || platform !== "web";
  return hostCompact || width < 760;
}

export type CardBounds = { id: string; y: number; height: number };
export type DropSlot = {
  index: number;
  beforeId: string | null;
  afterId: string | null;
  lineY: number | null;
};

/** Insertion slot for a pointer at `contentY` in a column's scroll content; the dragged card is ignored. */
export function dropSlot(
  contentY: number,
  cards: CardBounds[],
  draggedId: string,
  gap: number,
): DropSlot {
  const others = cards.filter((c) => c.id !== draggedId);
  let index = others.findIndex((c) => contentY < c.y + c.height / 2);
  if (index < 0) index = others.length;
  const next = others[index],
    last = others[others.length - 1];
  return {
    index,
    beforeId: next?.id ?? null,
    afterId: !next && last ? last.id : null,
    lineY: next ? next.y - gap / 2 : last ? last.y + last.height + gap / 2 : null,
  };
}

/** Column content y for a window point, given the list's window top and vertical scroll. */
export function contentY(pointY: number, listTop: number, scrollY: number) {
  return pointY - listTop + scrollY;
}

/** `tasks.place` input for a drop, or null when outside the board, unmeasured in its own column, or staying in place. */
export function placementUpdate(
  task: { id: string; revision: number; status: Status },
  target: Status | null,
  slot: DropSlot | null,
  columnIds: string[],
) {
  if (!target || (!slot && target === task.status)) return null;
  const index = slot?.index ?? columnIds.filter((id) => id !== task.id).length;
  if (target === task.status && columnIds.indexOf(task.id) === index) return null;
  return {
    id: task.id,
    revision: task.revision,
    status: target,
    beforeId: slot?.beforeId ?? null,
    afterId: slot?.afterId ?? null,
  };
}

/**
 * Index a dragged list row lands on: the number of other rows whose centre is
 * above the dragged row's centre after moving it by `dy`.
 */
export function listDropIndex(heights: readonly number[], from: number, dy: number, gap = 0): number {
  let top = 0;
  const centres = heights.map((h) => {
    const centre = top + h / 2;
    top += h + gap;
    return centre;
  });
  const moved = centres[from] + dy;
  return centres.filter((c, i) => i !== from && c < moved).length;
}

/** How far row `index` slides aside while row `from` is held over `to`. */
export function listShift(index: number, from: number, to: number, size: number): number {
  if (index === from) return 0;
  if (from < to && index > from && index <= to) return -size;
  if (to < from && index >= to && index < from) return size;
  return 0;
}

/**
 * How much of a view the on-screen keyboard covers: its bottom edge minus the
 * keyboard's top edge (both in window coordinates). Zero when the host already
 * resized the window (Android adjustResize) or moved the view out of the way.
 */
export function keyboardOverlap(viewBottom: number, keyboardTop: number | null): number {
  if (keyboardTop === null) return 0;
  return Math.max(0, Math.round(viewBottom - keyboardTop));
}

/** A node of the drawer's dependency map; `more` > 0 is the "+{more} more" node standing for the rest. */
export type NeighbourSlot = { y: number; more: number };
export type Span = { top: number; bottom: number };
export type NeighbourhoodLayout =
  | { vertical: false; height: number; centre: number; left: NeighbourSlot[]; right: NeighbourSlot[]; leftBus: Span | null; rightBus: Span | null }
  | { vertical: true; height: number; centre: number; left: NeighbourSlot[]; right: NeighbourSlot[]; rail: Span | null };

/** Up to `max` nodes per side: past that, `max - 1` cards and one "+n more" node. */
function neighbourSlots(count: number, max: number): number[] {
  if (count <= max) return Array.from({ length: count }, () => 0);
  return [...Array.from({ length: max - 1 }, () => 0), count - max + 1];
}

/**
 * Where the drawer's Dependencies map puts its nodes (CARD-TREE-SPEC §2.6), from counts alone, so
 * the section reserves its exact height before the nodes mount. Horizontal: "Waits for | This card |
 * Blocks", each column centred, one bus per side joining its nodes to the middle node. Vertical
 * (narrow or compact): blockers above, the card, blocked cards below, on one rail.
 */
export function neighbourhoodLayout(left: number, right: number, nodeH: number, gap: number, options: { vertical?: boolean; max?: number } = {}): NeighbourhoodLayout {
  const max = Math.max(2, options.max ?? 4);
  const l = neighbourSlots(Math.max(0, left), max), r = neighbourSlots(Math.max(0, right), max);
  if (options.vertical) {
    let y = 0;
    const place = (more: number) => {
      const slot = { y, more };
      y += nodeH + gap;
      return slot;
    };
    const leftSlots = l.map(place);
    const centre = place(0).y;
    const rightSlots = r.map(place);
    const height = y - gap;
    const rail = l.length || r.length ? { top: (leftSlots[0]?.y ?? centre) + nodeH / 2, bottom: (rightSlots[rightSlots.length - 1]?.y ?? centre) + nodeH / 2 } : null;
    return { vertical: true, height, centre, left: leftSlots, right: rightSlots, rail };
  }
  const column = (n: number) => (n ? n * nodeH + (n - 1) * gap : 0);
  const height = Math.max(nodeH, column(l.length), column(r.length));
  const centre = (height - nodeH) / 2;
  const mid = centre + nodeH / 2;
  const side = (slots: number[]) => {
    const top = (height - column(slots.length)) / 2;
    return slots.map((more, i) => ({ y: top + i * (nodeH + gap), more }));
  };
  const bus = (slots: NeighbourSlot[]): Span | null =>
    slots.length ? { top: Math.min(mid, slots[0].y + nodeH / 2), bottom: Math.max(mid, slots[slots.length - 1].y + nodeH / 2) } : null;
  const leftSlots = side(l), rightSlots = side(r);
  return { vertical: false, height, centre, left: leftSlots, right: rightSlots, leftBus: bus(leftSlots), rightBus: bus(rightSlots) };
}
