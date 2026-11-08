/**
 * Agent-facing rules shared by the generated skill and every live task read. No user data.
 * Implementer-oriented: a reviewer session gets `reviewerChecklist` instead (TURN-CHECKLIST-SPEC, AUTOMATION-SPEC §7).
 */
export const turnChecklist: string[] = [
  "Every turn, including follow-ups: read flowly_get_task and its handoff. Handle unread inputs and unread comments first, then fix setup.missing before work (metadata included).",
  "Use design for research, planning and specs. For implementation (docs-only included), set development and write 3-5 workpad acceptance criteria before editing. Use test for task verification, not for ordinary inspection. Keep the stage current.",
  "Before you start and deliver: check your work against get_task guardrails (project commands, guidelines learned from cards sent back, this card's items); tick the criteria you met. After checks, update flowly_update_handoff.",
  "After opening a PR/MR: register every PR/MR URL as an output this turn, even if an earlier turn already delivered.",
  "Before ending a work turn (research, task checks and commit/merge follow-ups included), update the acceptance list, then get a successful receipt: flowly_update_status(in_review) for the card's overall delivery or the user's requested handoff, even if uncommitted; flowly_report_progress(kind=result) for partial or verification-only work. A new artifact alone does not complete the card. Include outputs and nextMoves; [] when none. Pure conversation or a pause needs no delivery. After a question or blocked report, add no result. Follow explicit stop/wait instructions. Under [Flowly automation] a result never ends the turn: end with in_review (in a worktree workspace, commit on its branch first), a question or blocked.",
  "On SETUP_INCOMPLETE or HANDOFF_STALE: fix the gaps; retry with acknowledgeOpen=true only if needed, explaining what remains. On a [Flowly auto review message: fix what failed and deliver again, or dispute a wrong finding with disputes=[{id, reason}]. Session completion never proves card completion.",
];

/** What a reviewer session reads in flowly_get_task.turnChecklist instead of the implementer rules (AUTOMATION-SPEC §7). */
export const reviewerChecklist: string[] = [
  "You are this card's reviewer: read flowly_get_task, including its handoff and every comment, and review the delivery against the card, its workpad and the comments. Can a fresh agent continue from that record alone: state and commit, decisions and rejected approaches with reasons, next step, running work and outputs? Report up to five omissions in flowly_submit_review handoff.gaps; a contradiction with Git or the workpad is a finding.",
  "Inspect and run the relevant checks without changing the card's status, workpad, type, tags, ideas, artifacts or files; never commit or push. setup.missing is the implementer's to fix: report it as a finding when it matters.",
  "Check every requirement and prohibition in the card's description and comments, not only the workpad, and every added or changed file (no forbidden content, gamed checks or regressions). Finish the round with flowly_submit_review (approve, or changes with concrete findings, including confirmed serious correctness, data safety, security or unbounded-growth findings even when acceptance criteria missed them; unconfirmed risks and optional improvements go in risks). The verdict is yours: ask a person with flowly_report_progress kind=question only for what only they can give, never in an unattended project.",
];
