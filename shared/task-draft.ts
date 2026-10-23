/** A local preview only; the agent writes the final title from the full brief. */
export function taskDraft(brief: string) {
  const first = brief.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  const characters = Array.from(first);
  return { title: characters.length > 100 ? `${characters.slice(0, 99).join("")}…` : first, description: brief, brief };
}
