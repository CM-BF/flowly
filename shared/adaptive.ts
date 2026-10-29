import type { AutomationSettings } from "./automation-schema";

/**
 * Adaptive mode (AUTOMATION-SPEC §5.6): a card runs like a native agent until its context fills up; then the rest is
 * split over fresh sessions that share one decision record. Pure helpers: prompts, the trigger and progress.md.
 */

export const adaptiveDefaults = { threshold: 0.6, cap: 300_000, maxItems: 8, maxDepth: 2, checkRounds: 2, checkTimeoutSec: 600 } as const;

export const isAdaptive = (settings: Pick<AutomationSettings, "mode"> | null | undefined) => settings?.mode === "adaptive";

/**
 * Two context sizes (§5.6.3). Past `soft` (a share of the window, never above the cap: a 1M window degrades long before
 * 60%) the session may finish if little is left, else it checkpoints; past `hard` (a third more, at most 80% of the
 * window) or at its first automatic compaction it must checkpoint.
 */
export function adaptiveLimits(settings: Pick<AutomationSettings, "adaptive">, max: number) {
  const threshold = settings.adaptive?.threshold ?? adaptiveDefaults.threshold;
  const cap = settings.adaptive?.cap ?? adaptiveDefaults.cap;
  const soft = Math.min(Math.floor(threshold * max), cap);
  return { soft, hard: Math.max(soft + 1, Math.min(Math.floor(0.8 * max), Math.floor((soft * 4) / 3))) };
}

export type Card = { title: string; description: string; comments: readonly string[] };

const cardText = (card: Card) =>
  [`${card.title}\n\n${card.description}`.trim(), card.comments.length ? `Comments on this task:\n${card.comments.map((c) => `- ${c}`).join("\n")}` : ""].filter(Boolean).join("\n\n");

const closing = "Nobody answers questions or permission requests: decide yourself and finish.";

/** The first instruction: the card as the task, as a person would hand it to a native agent. Nothing else. */
export function thinPrompt(card: Card) {
  return [cardText(card), `---\nYou work in your current directory, this task's workspace. ${closing}`].join("\n\n");
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

/**
 * Steered into a running turn when its context crosses a limit or it compacts (§5.6.3). `optional`: past the soft limit
 * the session may simply finish when little is left.
 */
export function checkpointPrompt(path: string, why: string, optional = false) {
  return [
    optional
      ? `[Flowly] ${why} If little work is left, finish the task in this session as usual. Otherwise fresh sessions will continue it: finish the step you are on (do not start anything new), then write ${path} in exactly this format, and end your turn:`
      : `[Flowly] ${why} Fresh sessions will continue this task. Finish the step you are on (do not start anything new), then write ${path} in exactly this format, and end your turn:`,
    progressFormat,
    "List only the work that remains as items, each small enough for one session and as independent of the others as you can make them. Write no item if everything is done.",
  ].join("\n\n");
}

/** flowly_request_split's answer: the same checkpoint, asked for by the session itself. */
export const splitAnswer = (path: string) => checkpointPrompt(path, "You asked to split this task.");

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
export function itemPrompt(card: Card, progress: Progress, index: number, path: string) {
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
  ].filter(Boolean).join("\n\n");
}

/** The last fresh session: put the pieces together and finish the whole task. */
export function integratorPrompt(card: Card, progressText: string, path: string) {
  return [
    cardText(card),
    "---",
    `Earlier sessions did this task in parts; their shared record is ${path}:\n${progressText.slice(0, 30_000)}`,
    `Now finish the whole task: check that the parts fit together, run the full tests, fix what is broken and anything left undone. You work in your current directory, this task's workspace. ${closing}`,
  ].join("\n\n");
}

/** The project's check failed after a delivery: the same session fixes it. */
export function checkFailedPrompt(command: string, exit: number | null, tail: string, round: number, rounds: number) {
  return `[Flowly] The project's check \`${command}\` failed (exit ${exit ?? "timeout"}; rework ${round} of ${rounds}). Its output ends with:\n\n${tail}\n\nFix the cause, check again, and finish. ${closing}`;
}
