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
  return hostCompact || platform !== "web" || (width > 0 && width < 760);
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
