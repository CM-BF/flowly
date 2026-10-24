/**
 * Agent-facing rules shared by the generated skill and every live task read. No user data.
 * Implementer-oriented: a reviewer session gets `reviewerChecklist` instead (TURN-CHECKLIST-SPEC, AUTOMATION-SPEC §7).
 */
export const turnChecklist: string[] = [
  "Every turn, including commit/merge/rework/verification follow-ups: read flowly_get_task. Handle unread inputs and unread comments first, then fix setup.missing before work (metadata included).",
  "Use design for research, planning and specs. For implementation (including docs-only changes), set development and define workpad acceptance/checks before editing. Before executing task verification (including workpad or user-requested checks), ensure test. Ordinary inspection does not require test. Keep the stage current.",
  "After running checks: record the actual pass/fail/unrun results, exact commands and tested commit in workpad; use dirty=true for uncommitted changes.",
  "After opening a PR/MR: register every PR/MR URL as an output this turn, even if an earlier turn already delivered.",
  "Before ending a work turn (including the card's research work, task checks and commit/merge follow-ups), update workpad, then obtain a successful receipt: flowly_update_status(in_review) for the card's overall delivery or the user's requested handoff, even if uncommitted; flowly_report_progress(kind=result) for partial work or verification-only follow-ups. A new artifact alone does not mean the whole card is complete. Include outputs and nextMoves; [] when none. Pure conversation or a pause needs no delivery. After a question or blocked report, do not add a result; keep their existing nextMoves rules. Follow explicit stop/wait instructions. Under [Flowly automation] a result never ends the turn: end with in_review (in a worktree workspace, commit on its branch first), a question or blocked.",
  "On WORKPAD_OPEN or SETUP_INCOMPLETE: review and resolve the gaps, then retry with acknowledgeOpen=true only if needed, explaining every remaining gap. Session completion never proves card completion.",
];

/** What a reviewer session reads in flowly_get_task.turnChecklist instead of the implementer rules (AUTOMATION-SPEC §7). */
export const reviewerChecklist: string[] = [
  "You are this card's reviewer: read flowly_get_task, including every comment, and review the delivery against the card, its workpad and the comments.",
  "Inspect and run the relevant checks without changing the card's status, workpad, type, tags, ideas, artifacts or files; never commit or push. setup.missing is the implementer's to fix: report it as a finding when it matters.",
  "Finish the round with flowly_submit_review (approve, or changes with concrete findings), or ask a person with flowly_report_progress kind=question.",
];
