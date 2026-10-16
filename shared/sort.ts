import { msg } from "./i18n";
import type { Task } from "./model";

/** How cards are ordered inside each column. Manual is the drag order. */
export const boardSorts = ["manual", "activity", "priority", "created", "title"] as const;
export type BoardSort = (typeof boardSorts)[number];

export const boardSortText: Record<BoardSort, { label: string; detail: string }> = {
  manual: { label: msg("Manual"), detail: msg("Your drag order") },
  activity: { label: msg("Recent activity"), detail: msg("Latest task or session change first") },
  priority: { label: msg("Priority"), detail: msg("Urgent first, then manual order") },
  created: { label: msg("Newest"), detail: msg("Most recently created first") },
  title: { label: msg("Title"), detail: msg("A to Z") },
};

const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
const time = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0);
const manual = (a: Task, b: Task) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);

/**
 * Sorted copy of a column. `activity` maps a task ID to its latest session
 * activity (ISO time); the task's own `updatedAt` also counts.
 */
export function sortTasks(tasks: readonly Task[], mode: BoardSort, activity: ReadonlyMap<string, string> = new Map()) {
  const latest = (t: Task) => Math.max(time(t.updatedAt), time(activity.get(t.id)));
  const compare: Record<BoardSort, (a: Task, b: Task) => number> = {
    manual,
    activity: (a, b) => latest(b) - latest(a) || manual(a, b),
    priority: (a, b) => rank[a.priority] - rank[b.priority] || manual(a, b),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt) || manual(a, b),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) || manual(a, b),
  };
  return [...tasks].sort(compare[mode]);
}
