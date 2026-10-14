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

export function dropUpdate(
  task: { id: string; revision: number; status: Status },
  target: Status | null,
) {
  return target && target !== task.status
    ? { id: task.id, revision: task.revision, status: target }
    : null;
}
