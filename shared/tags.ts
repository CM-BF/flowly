import type { Task, TaskTag } from "./model";
import { tagLimits } from "./model";

/** Card tags (CARD-TAGS-SPEC §2.2): one normalized form for clients, the daemon and agents. */
export function normalizeTag(raw: string): string {
  const tag = raw
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/^#+/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/]+|[-/]+$/g, "");
  if (!tag) throw new Error("A tag can't be empty.");
  if (!/^[\p{L}\p{N}\-./]+$/u.test(tag))
    throw new Error('Tags can only use letters, numbers, "-", "." and "/".');
  if ([...tag].length > tagLimits.length) throw new Error(`Tags can be at most ${tagLimits.length} characters.`);
  return tag;
}

/** Normalizes and de-duplicates, keeping the first occurrence's order. Throws on the first invalid value. */
export function normalizeTags(list: readonly string[]): string[] {
  return [...new Set(list.map(normalizeTag))];
}

/** Splits typed or pasted text (commas, spaces) into tag candidates. */
export function splitTagInput(text: string): string[] {
  return text.split(/[,，、\s]+/u).filter((part) => part.replace(/^#+/, "").trim());
}

export const tagValues = (task: Pick<Task, "tags">) => (task.tags || []).map((t) => t.tag);

export type TagChange = {
  tags: TaskTag[];
  added: string[];
  removed: string[];
};

/**
 * Adds and removes already-normalized tags. An agent may only remove tags an agent
 * added; adding an existing tag keeps its origin; removing a missing tag does nothing.
 */
export function changeTags(
  current: readonly TaskTag[],
  change: { add?: readonly string[]; remove?: readonly string[] },
  by: { actor: "human" | "agent"; agentId?: string; at: string },
): TagChange {
  const add = change.add || [],
    remove = new Set(change.remove || []);
  if (add.some((t) => remove.has(t))) throw new Error("A tag can't be both added and removed.");
  const removed: string[] = [];
  const kept = current.filter((t) => {
    if (!remove.has(t.tag)) return true;
    if (by.actor === "agent" && t.by === "human") throw new Error("Only the user can remove tags they added.");
    removed.push(t.tag);
    return false;
  });
  const have = new Set(kept.map((t) => t.tag)),
    added: string[] = [];
  for (const tag of add) {
    if (have.has(tag)) continue;
    have.add(tag);
    added.push(tag);
    kept.push({ tag, by: by.actor, ...(by.actor === "agent" && by.agentId ? { agentId: by.agentId } : {}), at: by.at });
  }
  if (kept.length > tagLimits.perTask) throw new Error(`A card can have at most ${tagLimits.perTask} tags.`);
  return { tags: kept, added, removed };
}

/**
 * A form save (§2.5): applies what the form changed relative to what it opened with,
 * so tags added meanwhile (by an agent) are kept and tags the person removed stay removed.
 */
export function mergeTagEdit(
  current: readonly TaskTag[],
  base: readonly string[],
  next: readonly string[],
  at: string,
): TagChange {
  const baseSet = new Set(base),
    nextSet = new Set(next);
  return changeTags(
    current,
    { add: next.filter((t) => !baseSet.has(t)), remove: base.filter((t) => !nextSet.has(t)) },
    { actor: "human", at },
  );
}

/** Activity note for a change: "+drawer +performance −old-tag". */
export const tagChangeNote = (c: Pick<TagChange, "added" | "removed">) =>
  [...c.added.map((t) => `+${t}`), ...c.removed.map((t) => `−${t}`)].join(" ");

export type TagStat = { tag: string; count: number; lastUsedAt: string };

/** The project's vocabulary (§2.3): tags on its unarchived cards, most used first, then most recent. */
export function projectTagStats(tasks: readonly Task[], projectId: string, limit: number = tagLimits.suggestions): TagStat[] {
  const stats = new Map<string, TagStat>();
  for (const task of tasks) {
    if (task.projectId !== projectId || task.archivedAt) continue;
    for (const t of task.tags || []) {
      const s = stats.get(t.tag);
      if (!s) stats.set(t.tag, { tag: t.tag, count: 1, lastUsedAt: t.at });
      else {
        s.count++;
        if (t.at > s.lastUsedAt) s.lastUsedAt = t.at;
      }
    }
  }
  return [...stats.values()]
    .sort((a, b) => b.count - a.count || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.tag.localeCompare(b.tag))
    .slice(0, limit);
}

/** A filter value ending in "/" matches by prefix (`module/` matches `module/drawer`). */
export const tagMatches = (tag: string, filter: string) =>
  filter.endsWith("/") ? tag.startsWith(filter) : tag === filter;

/** Splits a search into free text and `#tag` terms (§6.4). Invalid `#` terms stay free text. */
export function parseTagSearch(search: string): { text: string; tags: string[] } {
  const tags: string[] = [],
    text: string[] = [];
  for (const word of search.split(/\s+/u)) {
    if (!word) continue;
    if (word.startsWith("#") && word.length > 1) {
      try {
        const prefix = word.endsWith("/");
        tags.push(normalizeTag(word) + (prefix ? "/" : ""));
        continue;
      } catch {
        // Not a valid tag: search for it as text.
      }
    }
    text.push(word);
  }
  return { text: text.join(" "), tags };
}

/** Board search (§6.4): text matches title, description or a tag; every `#tag` term must match a tag. */
export function taskMatchesSearch(task: Pick<Task, "title" | "description" | "tags">, search: string) {
  const { text, tags } = parseTagSearch(search);
  const values = tagValues(task);
  if (!tags.every((f) => values.some((t) => tagMatches(t, f)))) return false;
  if (!text) return true;
  const needle = text.toLowerCase();
  return `${task.title}\n${task.description}\n${values.join(" ")}`.toLowerCase().includes(needle);
}

/** Board tag filter: any selected value matches (OR); none selected shows every card. */
export const taskMatchesTagFilter = (task: Pick<Task, "tags">, filters: readonly string[]) =>
  !filters.length || tagValues(task).some((t) => filters.some((f) => tagMatches(t, f)));

/** Prefix options (`module/`) offered next to hierarchical tags in the filter. */
export function tagPrefixes(tags: readonly string[]): string[] {
  const prefixes = new Set<string>();
  for (const tag of tags) {
    const i = tag.lastIndexOf("/");
    if (i > 0) prefixes.add(tag.slice(0, i + 1));
  }
  return [...prefixes].sort();
}
