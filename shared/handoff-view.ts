import { emptyHandoff, handoffEntrySections, handoffLimits, handoffOpenIds, type CardHandoff, type HandoffEntry, type HandoffEntrySection } from "./handoff";

export interface HandoffView {
  revision: number;
  record: CardHandoff;
  openIds: string[];
  openIdsTotal: number;
  complete: boolean;
  omitted: number;
  truncatedIds: string[];
  fullRead: string;
}

const encode = (value: unknown) => JSON.stringify(value);
/** Derived previews do not replace the durable original or its full-read identity. */
function preview(entry: HandoffEntry, section: HandoffEntrySection, limit: number) {
  const result = JSON.parse(encode(entry)) as Record<string, unknown>;
  let truncated = false;
  for (const field of ["text", "summary"] as const) {
    if (typeof result[field] === "string" && result[field].length > limit) {
      result[field] = result[field].slice(0, limit);
      truncated = true;
    }
  }
  if (section === "ledger") {
    // Observation internals are not needed to read the card's session history.
    delete result.through;
    result.turns = [];
    result.live = [];
  }
  if (section === "reviews") {
    // Findings keep their full allowed text; their count still consumes the shared budget below.
    const delivery = result.delivery as { text?: string } | undefined;
    if (delivery?.text && delivery.text.length > limit) {
      delivery.text = delivery.text.slice(0, limit);
      truncated = true;
    }
  }
  return { value: result as HandoffEntry, truncated };
}

/** One shared budget, with original inputs and unresolved requirements before agent recap. */
export function handoffView(record: CardHandoff, options: { reviewer?: boolean; max?: number } = {}): HandoffView {
  const max = options.max ?? (options.reviewer ? handoffLimits.reviewerCharacters : handoffLimits.defaultCharacters);
  const view = emptyHandoff(record.taskId, record.projectId);
  Object.assign(view, { revision: record.revision, updatedAt: record.updatedAt, updatedBy: record.updatedBy });
  const allOpen = handoffOpenIds(record);
  const open = new Set(allOpen);
  const result: HandoffView = {
    revision: record.revision, record: view, openIds: allOpen.slice(0, 40), openIdsTotal: allOpen.length,
    complete: true, omitted: 0, truncatedIds: [],
    fullRead: "Read every handoff:'full' page (follow nextCursor) before acknowledging; previews and the first page are not the full record.",
  };
  let used = encode(result).length;
  const take = (section: HandoffEntrySection, original: HandoffEntry) => {
    const item = preview(original, section, section === "inputs" || section === "questions" ? 1600 : 2400);
    const size = encode(item.value).length + 2;
    if (used + size > max) { result.omitted++; result.complete = false; return; }
    (view[section] as HandoffEntry[]).push(item.value);
    used += size;
    if (item.truncated || (section === "inputs" && "textRef" in original && original.textRef)) {
      result.truncatedIds.push(original.id);
      result.complete = false;
    }
  };
  const pending = (entry: HandoffEntry) => open.has(entry.id) || ("standing" in entry && !!entry.standing);
  ["inputs", "questions", "reviews", "gaps", "notes"].forEach((name) => {
    const section = name as HandoffEntrySection;
    const entries = [...record[section]] as HandoffEntry[];
    entries.sort((a, b) => Number(pending(b)) - Number(pending(a)) || b.at.localeCompare(a.at));
    entries.forEach((entry) => take(section, entry));
  });
  if (record.state && used + encode(record.state).length < max) {
    view.state = record.state;
    used += encode(record.state).length;
  } else if (record.state) { result.omitted++; result.complete = false; }
  ["next", "pitfalls", "running", "decisions", "ruledOut", "problems", "done", "where", "env", "ledger"].forEach((name) => {
    const section = name as HandoffEntrySection;
    // Next steps remain ordered; historical sessions are newest first.
    const entries = name === "ledger" ? [...record.ledger].reverse() : record[section];
    entries.forEach((entry) => take(section, entry));
  });
  for (const repo of record.git) {
    const size = encode(repo).length + 2;
    if (used + size > max) { result.omitted++; result.complete = false; }
    else { view.git.push(repo); used += size; }
  }
  result.omitted += record.overflow.length;
  if (record.overflow.length || allOpen.length > result.openIds.length) result.complete = false;
  // Flags and counters grow as items are added; keep the declared limit strict even at tiny test budgets.
  while (encode(result).length > max) {
    const section = [...handoffEntrySections].reverse().find((name) => view[name].length);
    if (!section) {
      result.openIds = [];
      result.truncatedIds = [];
      delete view.state;
      view.git = [];
      result.complete = false;
      break;
    }
    view[section].pop(); result.omitted++; result.complete = false;
  }
  return result;
}
