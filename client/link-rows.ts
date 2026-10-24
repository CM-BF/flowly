import { msg } from "../shared/i18n";
import type { Link, Task } from "../shared/model";
import { isResolved, linkFor, samePair, type LinkView, type Relation } from "../shared/links";

/** Drawer groups, in order (CARD-LINKS-SPEC §5.2). "Was waiting on" holds resolved blockers. */
export type Group = "sub_card_of" | "sub_card" | "waiting" | "blocks" | "follow_up_of" | "follow_up" | "related" | "waited";
export const groups: { id: Group; title: string }[] = [
  { id: "sub_card_of", title: msg("Sub-card of") },
  { id: "sub_card", title: msg("Sub-cards") },
  { id: "waiting", title: msg("Waiting on") },
  { id: "blocks", title: msg("Blocks") },
  { id: "follow_up_of", title: msg("Follow-up of") },
  { id: "follow_up", title: msg("Follow-ups") },
  { id: "related", title: msg("Related") },
  { id: "waited", title: msg("Was waiting on") },
];

export const groupOf = (view: Pick<LinkView, "relation" | "other">): Group =>
  view.relation === "blocked_by" ? (isResolved(view.other) ? "waited" : "waiting") : view.relation;

/**
 * `groupOf` for a card whose automation job is queued (and the card is live): a Cancelled or archived
 * blocker holds it (Held, CARD-TREE-SPEC §2.6), so it stays under "Waiting on"; a Done one has been waited on.
 */
export const groupFor = (queued: boolean) => (view: Pick<LinkView, "relation" | "other">): Group =>
  queued && view.relation === "blocked_by" && !!view.other && view.other.status !== "done" ? "waiting" : groupOf(view);

/**
 * Cards `task` can be linked to (CARD-LINKS-SPEC §5.4): same project, live,
 * not itself, title containing `query`. `linked` marks cards the server would
 * refuse as already linked for `relation`.
 */
export function linkCandidates(tasks: readonly Task[], links: readonly Link[], task: Task, relation: Relation, query: string) {
  const needle = query.trim().toLowerCase();
  return tasks
    .filter((t) => t.projectId === task.projectId && t.id !== task.id && !t.archivedAt)
    .filter((t) => !needle || t.title.toLowerCase().includes(needle))
    .map((t) => {
      // Mirrors the server (CARD-LINKS-SPEC §2.3): Related needs no link at all between the
      // cards; Blocks / Follow-up need none of the same kind, in either direction.
      const kind = linkFor(relation, task.id, t.id).kind;
      const linked = links.some((l) => samePair(l, task.id, t.id) && (kind === "related" || l.kind === kind));
      return { task: t, linked };
    });
}
