import { msg } from "./i18n";
import type { BoardEvent, Task } from "./model";

/** How cards are ordered inside each column. Manual is the drag order. */
export const boardSorts = ["manual", "activity", "priority", "created", "title"] as const;
export type BoardSort = (typeof boardSorts)[number];

export const boardSortText: Record<BoardSort, { label: string; detail: string }> = {
  manual: { label: msg("Manual"), detail: msg("Your drag order") },
  activity: { label: msg("Recent activity"), detail: msg("Latest finished session turn first") },
  priority: { label: msg("Priority"), detail: msg("Urgent first, then manual order") },
  created: { label: msg("Newest"), detail: msg("Most recently created first") },
  title: { label: msg("Title"), detail: msg("A to Z") },
};

const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
const time = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0);
const manual = (a: Task, b: Task) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);

/**
 * Recent activity moves a card once per finished turn, not on every streamed
 * message or mid-turn card write. Kanban-managed sessions record
 * `agent.turn_ended`: the latest per task, and the sessions that recorded one.
 */
export function latestTurnEnds(events: readonly BoardEvent[]) {
  const byTask = new Map<string, string>();
  const agents = new Set<string>();
  for (const e of events) {
    if (e.action !== "agent.turn_ended") continue;
    if (e.agentId) agents.add(e.agentId);
    if ((byTask.get(e.taskId) || "") < e.at) byTask.set(e.taskId, e.at);
  }
  return { byTask, agents };
}

/**
 * Task ID → latest turn end: its recorded turn ends, or `settled` (workspace ID →
 * when its other sessions last went idle), whichever is newer.
 */
export function turnEndActivity(
  tasks: readonly Task[],
  ended: ReadonlyMap<string, string>,
  settled: ReadonlyMap<string, string> = new Map(),
) {
  const activity = new Map<string, string>();
  for (const t of tasks) {
    const a = ended.get(t.id) || "", b = settled.get(t.workspaceId) || "";
    if (a || b) activity.set(t.id, time(b) > time(a) ? b : a);
  }
  return activity;
}

/**
 * Sorted copy of a column. `activity` maps a task ID to its latest turn end
 * (ISO time, see turnEndActivity); a card without one counts from its creation.
 */
export function sortTasks(tasks: readonly Task[], mode: BoardSort, activity: ReadonlyMap<string, string> = new Map()) {
  const latest = (t: Task) => Math.max(time(t.createdAt), time(activity.get(t.id)));
  const compare: Record<BoardSort, (a: Task, b: Task) => number> = {
    manual,
    activity: (a, b) => latest(b) - latest(a) || manual(a, b),
    priority: (a, b) => rank[a.priority] - rank[b.priority] || manual(a, b),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt) || manual(a, b),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) || manual(a, b),
  };
  return [...tasks].sort(compare[mode]);
}
