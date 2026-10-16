export const skillText = `---
name: paseo-ultra-kanban
description: Read the current Paseo Kanban card, report progress and blockers, propose follow-up ideas, and update its business status through scoped MCP tools or the supplied CLI.
---

# Paseo Ultra Kanban

Use this skill when working in the workspace of an attached Ultra Kanban card.

- Read kanban_get_task before starting a work phase and before reporting after long work. The connection identifies your card/session. Do not choose another card or infer the task from cwd, title, or labels.
- Follow scope.repoPaths and scope.directories. New cards work at the native Paseo project root, which may contain child repositories managed by the user. Older cards can retain a read-only legacy scope; follow the listed directories. A worktree isolates the Git project root only. Provider permissions still apply. Report denied access.
- When work actually starts, set the work stage that matches it: design (plans, specs, research), development (implementation) or test (verification). You decide from the instructions whether to start with design or go straight to development. Keep the stage current as the work changes: switch to development as soon as you start changing code, to test when you verify, and back when needed; never deliver implementation work from design. Report checkpoints and individual contributions with kanban_report_progress. A single session finishing its part does not prove the whole card is finished.
- When you need the user to decide or answer something, report kind=question with one clear question (offer options when you can), then end your turn. The card shows "Needs you"; the user's reply starts your next turn. Starting a turn after a user message also moves the card automatically: from in_review to development (review feedback is usually rework), from blocked back to its previous work stage. That stage is only a guess: at the start of every turn, compare it with the work you are about to do (for example, rework of the implementation is development) and set the right stage first if it differs.
- When your work reveals worthwhile next steps the user did not ask for, propose them with kanban_propose_idea, usually when you deliver. Set scope=here for an extension of this card's goal that this card's session can continue with its current context (the user may send it back to this session as an instruction), and scope=new for divergent work that deserves its own card (a bug found on the way, a refactor, a separate feature). Work this card already requires is not an idea; do it. Propose at most 3 per delivery and check ideas in get_task first. Put the files, branches and findings a new card would need in context: its agent cannot see this conversation. Ideas are suggestions only; never start one or create cards yourself.
- Use blocked only when the overall task cannot proceed; otherwise report kind=blocker with its impact and the required input. Resume with the work stage you continue in. Deliver the overall result to in_review, explaining changes, verification, unrun checks and remaining issues. Done/Cancelled/Backlog/Todo are human decisions. The project's lanes define its workflow: only use statuses listed in allowedStatuses, and refer to lanes by their names in lanes.
- Copy revision.task/project and the complete request object into each write. Do not edit signed fields. A progress note does not change task revision; status changes and human edits do. Project edits also invalidate an old context.
- For REVISION_CONFLICT or REQUEST_EXPIRED, re-read and decide whether the intended action is still valid. Never just replace revisions and overwrite the human's work.
- For uncertain timeout/disconnection, repeat the same request and parameters to obtain its receipt. A replay acknowledges the original commit, not that its old status is still current. Never blindly generate a new request to repeat an uncertain write.
- Prefer the MCP tools when present. Otherwise use the supplied absolute CLI/context-file command. Run current --save-request <your-private-snapshot-file>, then status <state> or note with --request-file pointing to that snapshot and a nonempty --note, or idea with --request-file, --title, --detail, --rationale and optional --context/--type/--priority/--scope. After success save a fresh current snapshot before the next write. Do not reuse a snapshot for a different action after it committed.
- If tools are unavailable, explain the limitation in your reply; do not assert that a card transition succeeded. Never edit board.json, tool credentials, global MCP configuration or another session's context file to work around an error.
- Session running/idle/turn completion is independent of card business status. Do not automatically hand off, assign another agent, or complete the project.
`;

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function workingInstructions(
  context: string,
  cliPath: string,
  contextFile: string,
  skillPath: string,
) {
  return `${context}\n\n${skillText}\nRuntime skill: ${skillPath}\nCLI for this session: node ${shellQuote(cliPath)} --context-file ${shellQuote(contextFile)} current\nUse your own snapshot file for --save-request. Read current context before any work/update. Credentials are private; do not copy them into notes or replies.`;
}
