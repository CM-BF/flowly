import { localizedLabels, msg } from "./i18n";
import type { Link, LinkKind, Task } from "./model";

/** How a link reads from one of its cards (CARD-LINKS-SPEC §2.5). */
export const relations = ["blocked_by", "blocks", "follow_up_of", "follow_up", "sub_card_of", "sub_card", "related"] as const;
export type Relation = (typeof relations)[number];

export const relationLabels: Record<Relation, string> = localizedLabels({
  blocked_by: msg("Blocked by"),
  blocks: msg("Blocks"),
  follow_up_of: msg("Follow-up of"),
  follow_up: msg("Follow-up"),
  sub_card_of: msg("Sub-card of"),
  sub_card: msg("Sub-card"),
  related: msg("Related"),
});

export function relationOf(link: Pick<Link, "kind" | "from">, taskId: string): Relation {
  if (link.kind === "related") return "related";
  const outgoing = link.from === taskId;
  if (link.kind === "derived") return outgoing ? "follow_up_of" : "follow_up";
  if (link.kind === "subtask") return outgoing ? "sub_card_of" : "sub_card";
  return outgoing ? "blocks" : "blocked_by";
}

/** The link that, seen from `taskId`, has `relation` toward `otherId`. */
export function linkFor(relation: Relation, taskId: string, otherId: string): { kind: LinkKind; from: string; to: string } {
  switch (relation) {
    case "blocked_by":
      return { kind: "blocks", from: otherId, to: taskId };
    case "blocks":
      return { kind: "blocks", from: taskId, to: otherId };
    case "follow_up_of":
      return { kind: "derived", from: taskId, to: otherId };
    case "follow_up":
      return { kind: "derived", from: otherId, to: taskId };
    case "sub_card_of":
      return { kind: "subtask", from: taskId, to: otherId };
    case "sub_card":
      return { kind: "subtask", from: otherId, to: taskId };
    case "related":
      return { kind: "related", from: taskId, to: otherId };
  }
}

export const otherEnd = (link: Pick<Link, "from" | "to">, taskId: string) => (link.from === taskId ? link.to : link.from);

export const touches = (link: Pick<Link, "from" | "to">, taskId: string) => link.from === taskId || link.to === taskId;

/** Same pair of cards, either direction. */
export const samePair = (link: Pick<Link, "from" | "to">, a: string, b: string) =>
  (link.from === a && link.to === b) || (link.from === b && link.to === a);

export interface LinkView {
  link: Link;
  relation: Relation;
  other: Task | undefined;
}

export function linksOf(board: { links: readonly Link[]; tasks: readonly Task[] }, taskId: string): LinkView[] {
  return board.links
    .filter((l) => touches(l, taskId))
    .map((link) => ({
      link,
      relation: relationOf(link, taskId),
      other: board.tasks.find((t) => t.id === otherEnd(link, taskId)),
    }));
}

/** A blocker no longer holds up its card once Done, Cancelled, archived or gone. */
export const isResolved = (blocker: Pick<Task, "status" | "archivedAt"> | undefined) =>
  !blocker || !!blocker.archivedAt || blocker.status === "done" || blocker.status === "cancelled";

/** The unresolved blockers of `taskId`. */
export function waitingOn(board: { links: readonly Link[]; tasks: readonly Task[] }, taskId: string): Task[] {
  return linksOf(board, taskId)
    .filter((v) => v.relation === "blocked_by" && !isResolved(v.other))
    .map((v) => v.other!);
}

/**
 * The card IDs of the cycle that a new directed `kind` link from → to would
 * close (starting and ending at `from`), or undefined. Related links have no
 * direction and never form cycles.
 */
export function wouldCycle(links: readonly Link[], kind: LinkKind, from: string, to: string): string[] | undefined {
  if (kind === "related") return undefined;
  if (from === to) return [from, from];
  const edges = links.filter((l) => l.kind === kind);
  const previous = new Map<string, string>([[to, from]]);
  const queue = [to];
  while (queue.length) {
    const node = queue.shift()!;
    for (const edge of edges) {
      if (edge.from !== node || previous.has(edge.to)) continue;
      previous.set(edge.to, node);
      if (edge.to === from) {
        const path = [from];
        for (let at = node; at !== from; at = previous.get(at)!) path.unshift(at);
        return [from, ...path];
      }
      queue.push(edge.to);
    }
  }
  return undefined;
}

/** Derived links for cards created from an idea, for files written before links existed (CARD-LINKS-SPEC §2.2). */
export function originLinks(tasks: readonly Task[]): Link[] {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks
    .filter((t) => t.origin && ids.has(t.origin.taskId) && t.origin.taskId !== t.id)
    .map((t) => ({
      id: `origin-${t.id}`,
      projectId: t.projectId,
      kind: "derived" as const,
      from: t.id,
      to: t.origin!.taskId,
      ideaId: t.origin!.ideaId,
      createdBy: "system" as const,
      createdAt: t.createdAt,
    }));
}

/** Context lines listing a card's links for a new session (CARD-LINKS-SPEC §4); at most `limit` per relation. */
export function linkContextLines(
  views: readonly LinkView[],
  laneOf: (task: Task) => string,
  limit = 10,
): string[] {
  const order: Relation[] = ["sub_card_of", "sub_card", "follow_up_of", "blocked_by", "blocks", "follow_up", "related"];
  return order.flatMap((relation) => {
    const list = views.filter(
      (v) => v.relation === relation && v.other && (relation !== "blocked_by" || !isResolved(v.other)),
    );
    return [
      ...list.slice(0, limit).map((v) => `${relationLabels[relation]}: ${v.other!.title} (${v.other!.id}) [${laneOf(v.other!)}]`),
      ...(list.length > limit ? [`${relationLabels[relation]}: …and ${list.length - limit} more`] : []),
    ];
  });
}

/** Sub-cards (SUB-CARDS-SPEC §2): a card has at most one parent, and a tree is at most this many levels below its root. */
export const subCardLimits = { depth: 3, perParent: 20 } as const;

/** The parent of `taskId`, if it is a sub-card. */
export const parentOf = (links: readonly Link[], taskId: string) => links.find((l) => l.kind === "subtask" && l.from === taskId)?.to;

/** The direct sub-cards of `taskId`, in link order. */
export const childrenOf = (links: readonly Link[], taskId: string) => links.filter((l) => l.kind === "subtask" && l.to === taskId).map((l) => l.from);

/** How many parents `taskId` has above it (0 for a top-level card). */
export function depthOf(links: readonly Link[], taskId: string) {
  let depth = 0;
  const seen = new Set([taskId]);
  for (let at = parentOf(links, taskId); at && !seen.has(at); at = parentOf(links, at)) {
    seen.add(at);
    depth++;
  }
  return depth;
}

/** How many levels of sub-cards `taskId` has below it (0 for a leaf). */
export function heightOf(links: readonly Link[], taskId: string, seen = new Set<string>()): number {
  if (seen.has(taskId)) return 0;
  seen.add(taskId);
  return Math.max(0, ...childrenOf(links, taskId).map((c) => 1 + heightOf(links, c, seen)));
}

/** Why `childId` can't become a sub-card of `parentId`, or "" (SUB-CARDS-SPEC §2). */
export function subCardProblem(links: readonly Link[], parentId: string, childId: string) {
  if (parentOf(links, childId)) return "This card is already a sub-card of another card.";
  if (childrenOf(links, parentId).length >= subCardLimits.perParent) return `A card can have at most ${subCardLimits.perParent} sub-cards.`;
  if (depthOf(links, parentId) + 1 + heightOf(links, childId) > subCardLimits.depth)
    return `Sub-cards go at most ${subCardLimits.depth} levels deep.`;
  return "";
}
