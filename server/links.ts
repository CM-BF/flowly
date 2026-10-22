import { randomUUID } from "node:crypto";
import { linkLimits, type Board, type Link, type LinkInput } from "../shared/model";
import { otherEnd, relationLabels, relationOf, samePair, subCardProblem, touches, wouldCycle } from "../shared/links";
import type { BoardStore } from "./store";

/** One line from `taskId`'s side, e.g. "Blocked by: <title>" (CARD-LINKS-SPEC §2.4). */
export const linkNote = (board: Board, link: Pick<Link, "kind" | "from" | "to">, taskId: string) =>
  `${relationLabels[relationOf(link, taskId)]}: ${board.tasks.find((t) => t.id === otherEnd(link, taskId))?.title ?? "a deleted card"}`;

/**
 * Validates a new link against CARD-LINKS-SPEC §2.3 and adds it to `board`.
 * Returns the existing identical link instead when there is one. Throws
 * without changing anything when the link is not allowed.
 */
export function addLink(
  store: BoardStore,
  board: Board,
  input: LinkInput & { ideaId?: string; createdBy?: Link["createdBy"]; actor?: { kind: "agent"; agentId: string } },
  /** `archived`: allow an archived card (a card created from an idea whose source is archived, IDEAS-INBOX-SPEC §2.2). */
  options: { events?: boolean; limit?: boolean; archived?: boolean } = {},
): { link: Link; created: boolean } {
  const from = board.tasks.find((t) => t.id === input.from),
    to = board.tasks.find((t) => t.id === input.to);
  if (!from || !to) throw new Error("Task not found.");
  if (from.id === to.id) throw new Error("A card can't be linked to itself.");
  if (from.projectId !== to.projectId) throw new Error("Cards in different projects can't be linked.");
  const project = board.projects.find((p) => p.id === from.projectId);
  if (!project || project.archivedAt) throw new Error("The project is archived.");
  if (!options.archived && (from.archivedAt || to.archivedAt)) throw new Error("Archived cards can't get new links.");
  const between = board.links.filter((l) => samePair(l, from.id, to.id));
  const same = between.find(
    (l) => l.kind === input.kind && (input.kind === "related" || (l.from === from.id && l.to === to.id)),
  );
  if (same) return { link: same, created: false };
  if (input.kind === "related" ? between.length : between.some((l) => l.kind === input.kind))
    throw new Error("These cards are already linked.");
  if (input.kind === "subtask") {
    const problem = subCardProblem(board.links, to.id, from.id);
    if (problem) throw new Error(problem);
  }
  const cycle = wouldCycle(board.links, input.kind, from.id, to.id);
  if (cycle)
    throw new Error(
      `This would make a cycle: ${cycle.map((id) => board.tasks.find((t) => t.id === id)?.title ?? id).join(" → ")}.`,
    );
  if (input.kind === "blocks" || input.kind === "subtask") {
    const dependencies = board.links.filter((l) => l.kind === "blocks" || l.kind === "subtask").map((l) => ({ ...l, kind: "blocks" as const }));
    if (wouldCycle(dependencies, "blocks", from.id, to.id)) throw new Error("This dependency would make a parent wait on its own descendant or a card wait on its ancestor.");
  }
  // A more specific link replaces a plain Related one between the same cards.
  const replaced = between.filter((l) => l.kind === "related");
  if (options.limit !== false)
    for (const task of [from, to]) {
      const count = board.links.filter((l) => touches(l, task.id) && !replaced.includes(l)).length;
      if (count >= linkLimits.perTask) throw new Error(`A card can have at most ${linkLimits.perTask} links.`);
    }
  board.links = board.links.filter((l) => !replaced.includes(l));
  const link: Link = {
    id: randomUUID(),
    projectId: from.projectId,
    kind: input.kind,
    from: from.id,
    to: to.id,
    ...(input.ideaId ? { ideaId: input.ideaId } : {}),
    createdBy: input.createdBy ?? "human",
    createdAt: new Date().toISOString(),
  };
  board.links.push(link);
  if (options.events !== false)
    for (const id of [from.id, to.id])
      store.event(board, {
        taskId: id,
        actor: input.actor ? "agent" : "human",
        ...(input.actor ? { agentId: input.actor.agentId } : {}),
        action: "linked",
        note: linkNote(board, link, id),
      });
  return { link, created: true };
}

export function createLink(store: BoardStore, input: LinkInput) {
  return store.transaction((board) => {
    const { link, created } = addLink(store, board, input);
    return { value: link, changed: created };
  });
}

export function deleteLink(store: BoardStore, input: { id: string }) {
  return store.transaction((board) => {
    const link = board.links.find((l) => l.id === input.id);
    if (!link) throw new Error("This link no longer exists.");
    board.links = board.links.filter((l) => l !== link);
    for (const id of [link.from, link.to])
      if (board.tasks.some((t) => t.id === id))
        store.event(board, { taskId: id, actor: "human", action: "unlinked", note: linkNote(board, link, id) });
    return { value: { id: link.id }, changed: true };
  });
}
