import type { AutomationSettings } from "./automation-schema";

/**
 * Adaptive mode (AUTOMATION-SPEC §5.6): a card runs like a native agent until its context fills up; then the rest is
 * split over fresh sessions that share one decision record. Pure helpers: prompts, the trigger and progress.md.
 */

export const adaptiveDefaults = { threshold: 0.6, cap: 300_000, maxItems: 8, maxDepth: 2, maxSessions: 20, checkRounds: 2, checkTimeoutSec: 600 } as const;

export const isAdaptive = (settings: Pick<AutomationSettings, "mode"> | null | undefined) => settings?.mode === "adaptive";

/** The context size at which a session is reminded it may split (§5.6.3): a share of the window, never above the cap. */
export function adaptiveLimit(settings: Pick<AutomationSettings, "adaptive">, max: number) {
  const threshold = settings.adaptive?.threshold ?? adaptiveDefaults.threshold;
  const cap = settings.adaptive?.cap ?? adaptiveDefaults.cap;
  return Math.min(Math.floor(threshold * max), cap);
}

export type Card = { title: string; description: string; comments: readonly string[] };

const cardText = (card: Card) =>
  [`${card.title}\n\n${card.description}`.trim(), card.comments.length ? `Comments on this task:\n${card.comments.map((c) => `- ${c}`).join("\n")}` : ""].filter(Boolean).join("\n\n");

const closing = "Nobody answers questions or permission requests: decide yourself and finish.";

/**
 * The one line about splitting (§5.6.1). Codex keeps MCP tools behind its tool search, so a tool nobody mentions is
 * never found; the decision to use it stays with the agent.
 */
export const splitLine = "If this task is too large to finish well in one session, the tool flowly_split hands the remaining work to fresh sessions: you pass a short plan (what is done, the decisions made, and the remaining items), and after your turn each item gets its own fresh session, then a final one integrates. Use it only when you need it.";

/** The first instruction: the card as the task, as a person would hand it to a native agent, and the split line. */
export function thinPrompt(card: Card, canSplit = true) {
  return [cardText(card), `---\nYou work in your current directory, this task's workspace. ${closing}${canSplit ? `\n\n${splitLine}` : ""}`].join("\n\n");
}

export const progressFormat = [
  "## Done",
  "What is finished, with its files.",
  "## Decisions",
  "Interfaces, conventions, data formats, names, and approaches you ruled out (and why).",
  "## How to test",
  "The commands that check the work.",
  "## Item 1: <short title>",
  "Files: <the files this item touches>",
  "Depends on: <earlier item numbers, or none>",
  "Acceptance: <how to tell it is done>",
  "<what to do>",
  "## Item 2: …",
].join("\n");

/** Steered into a running turn once, when its context crosses the limit or first compacts (§5.6.3): information, not an order. */
export function reminderPrompt(why: string) {
  return `[Flowly] ${why} If much work is left, you can use flowly_split to hand it to fresh sessions; if you are nearly done, just finish.`;
}

/** flowly_split's answer once the plan is recorded. */
export const splitRecorded = (count: number) =>
  `Recorded ${count} item${count === 1 ? "" : "s"}. Finish the step you are on and end your turn; fresh sessions do the items in order, then one integrates.`;

export type ProgressItem = { title: string; body: string };
export type Progress = { done: string; decisions: string; howToTest: string; items: ProgressItem[] };

/** Reads progress.md; items beyond `maxItems` are merged into the last one so a split never gets too fine. */
export function parseProgress(text: string, maxItems: number = adaptiveDefaults.maxItems): Progress {
  const sections = new Map<string, string>();
  const items: ProgressItem[] = [];
  const parts = text.split(/^##\s+/m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const head = (newline < 0 ? part : part.slice(0, newline)).trim();
    const body = newline < 0 ? "" : part.slice(newline + 1).trim();
    const item = /^item\s*\d+\s*[:.-]?\s*(.*)$/i.exec(head);
    if (item) items.push({ title: (item[1] || `Item ${items.length + 1}`).trim().slice(0, 200), body });
    else sections.set(head.toLowerCase(), body);
  }
  const kept = items.slice(0, Math.max(1, maxItems));
  if (items.length > kept.length) {
    const last = kept[kept.length - 1]!;
    kept[kept.length - 1] = { title: `${last.title} (and ${items.length - kept.length} more)`, body: [last.body, ...items.slice(kept.length).map((i) => `### ${i.title}\n${i.body}`)].join("\n\n") };
  }
  return { done: sections.get("done") ?? "", decisions: sections.get("decisions") ?? "", howToTest: sections.get("how to test") ?? "", items: items.length ? kept : [] };
}

/** One remaining item, for a fresh session: the card, the shared decisions in full, what is done and its own item. */
export function itemPrompt(card: Card, progress: Progress, index: number, path: string, canSplit = false) {
  const item = progress.items[index]!;
  return [
    cardText(card),
    "---",
    `Earlier sessions did part of this task and split the rest; you do item ${index + 1} of ${progress.items.length} only. Later items and a final integration follow in other sessions.`,
    progress.done ? `Done so far:\n${progress.done}` : "",
    progress.decisions ? `Decisions so far (follow them):\n${progress.decisions}` : "",
    progress.howToTest ? `How to test:\n${progress.howToTest}` : "",
    `Your item — ${item.title}:\n${item.body}`,
    `When you make a decision the other sessions must know (an interface, a name, a format), add it under "## Decisions" in ${path}. You work in your current directory, this task's workspace. ${closing}`,
    canSplit ? splitLine.replace("this task", "your item") : "",
  ].filter(Boolean).join("\n\n");
}

/** The last fresh session: put the pieces together and finish the whole task. */
export function integratorPrompt(card: Card, progressText: string, path: string, canSplit = false) {
  return [
    cardText(card),
    "---",
    `Earlier sessions did this task in parts; their shared record is ${path}:\n${progressText.slice(0, 30_000)}`,
    `Now finish the whole task: check that the parts fit together, run the full tests, fix what is broken and anything left undone. You work in your current directory, this task's workspace. ${closing}`,
    canSplit ? splitLine : "",
  ].filter(Boolean).join("\n\n");
}

/** The project's check failed after a delivery: the same session fixes it. */
export function checkFailedPrompt(command: string, exit: number | null, tail: string, round: number, rounds: number) {
  return `[Flowly] The project's check \`${command}\` failed (exit ${exit ?? "timeout"}; rework ${round} of ${rounds}). Its output ends with:\n\n${tail}\n\nFix the cause, check again, and finish. ${closing}`;
}
