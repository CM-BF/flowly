# Automation/sub-card review hardening

The interrupted Claude workflow was recovered, not restarted. Its resumed run completed 10 reviewers, 252 verification calls and one critic; only synthesis failed at quota. Latest result: 114 confirmed entries, four plausible entries and eight rejected entries. Fifty-four duplicate entries collapse into about 64 concerns. [Recovered plan and complete finding mapping](automation-review/recovered-plan.json).

## Changes

- Role-bound session preparation, distinct implementer/reviewer identities, preserved role sessions across runs, fresh ownership/generation checks before external effects, and serialized sends. Stop/archive/take-over cannot be overwritten by an old decision.
- One durable pending instruction per job with immutable message identity and original payload. Native completed receipts replay safely; unknown receipts pause for a person. Busy sessions and active peer roles defer sends. Stale missing starts recover; missing idle turn outcomes release capacity conservatively without inventing lifecycle facts.
- Human-stopped and failed children require human Run again. Creation has atomic per-card and lineage budgets; signed requests share the normal receipt namespace. Card/link/queue/receipt commits are atomic. Current parent relationship, scope and revisions are rechecked. Link capacities and mixed hierarchy/dependency cycles are checked before workspace creation.
- Parent wake respects enabled/archive/capacity and physical directory ownership. Transitive sibling dependencies can settle for parent acceptance; external prerequisites still hold. Bounded handoffs expose real delivery/workpad/branch/blocker evidence. Rework preserves the parent's note. CLI fallback now supports create-card, update-card and submit-review.
- Consecutive failure counters reset on success; explicit provider limits cool down with a bounded budget and shared provider gating. Actual new delivery events distinguish rework from casual answers. Reviewer-only nudges, accurate verdict/held-blocker signals, available Stop, functional picker updates, narrower drawer subscription, automation Attention, honest memory/summary attribution and translated onboarding.

## Passed

- `npm run typecheck`.
- `npm test`: **980 passed, 65 skipped**, 119 test files passed and 13 skipped. [Output](automation-review/full-tests.txt). The 65 skips predate this work.
- Key added regression cases copied to an isolated checkout of **d143a86**: **25 failed**, as expected before the fix; [output](automation-review/base-regressions.txt). The temporary tree used symlinked dependencies, had no daemon access and was removed.
- Native project inventory before/after offline tests: four projects before and after, no additions/removals. CLI test stubs now fail closed; resolver tests cover executable override, invalid override and app bundle layout. Dispatchers are drained before test stores are deleted.
- Independent read-only audit found stale handoff snapshots, fast creation acknowledgments, provider attribution, unknown receipts, physical ownership after Stop, and lifecycle freshness races; these were fixed before the final test run.

## Live acceptance

Luna validator: `a0c74ff7-e334-4309-9aad-965ea5f93d01`, `codex/gpt-6-luna`, explicitly full-access. Real daemon: `srv_BSheQn5lzdEE`, `127.0.0.1:6767`, Paseo 0.12.0. The installed code revision `0caefa58` passed real project-setting persistence and lane validation, one-child parent orchestration, wait/wake with branch/check handoff, integration/acceptance and real reviewer approval, plus desktop/compact board inspection. [Live report and cleanup](automation-review-live.md). Stop/Run again, project-disable, blocker-reason display and reviewer-changes rework remain live UNRUN; their relevant core paths were checked offline. No physical Android device test is claimed. All fixture resources and the validator were removed or archived; final native inventory was reconciled with the concurrent fixture cleanup.

## Deliberate decisions and limits

- Preserve the accepted independent-card `subCard=false/start=now` behavior; bound the whole creation lineage instead of silently removing it.
- Preserve the spec's Done/Cancelled-only child completion counter. Archived unfinished cards are settled for supervision, not completed work. Optional invalid-parent picker affordances and warnings about existing ordinary sessions remain polish; server validation is authoritative.
- Keep ordinary bounded failure policy for authentication/model-configuration errors; no additional speculative terminal-error classifier was added.
- Paseo 0.12 has no atomic idle-only send. The refreshed busy check plus explicit steer avoids the known default-interrupt path, but the host can fall back to interruption if a new turn races the request and steering is unavailable. This limitation is documented; strict non-interruption needs a host API change.
- When an entire native outcome is absent, idle proves only that execution stopped. Recovery asks a person rather than fabricating success or retrying uncertain paid work.
- A session creation already accepted by the daemon can finish after Stop. The plugin cannot revoke that request and does not interrupt sessions; it rechecks all subsequent effects and never attaches the stale generation to a new job.

## Source and recovery

Original Flowly source: managed Git installation from `file:///Users/citrine/Projects/flowly-kanban/flowly`, revision `d143a86366e502569aa9b59157b8f8f2cee55946`. Data backup: `/Users/citrine/.paseo/backups/flowly-review-20261022-162621/plugin-data`; source metadata is beside it. The separately installed kanban plugin is untouched. The final installation remains a managed checkout from this stable repository/ref, not a disposable worktree.

To restore the original source: `paseo plugin update flowly --ref d143a86366e502569aa9b59157b8f8f2cee55946`. New create/update-card receipt actions and subtask links require a compatible board when downgrading. Use the saved data only if no later real writes would be lost; otherwise migrate current records first. No automatic data rollback was performed.

## Round 2

A second review of the round-1 fixes on `sw/flowly-automation` (6 reviewers: two fix checks, state machine, sub-cards, client and docs, tests) reported **61 findings**; verification confirmed **59** and rejected **2**. Fix commits: `bf0bd23` to `c9807b0`, the docs pass `d4885a4`, and the follow-up `07e817b`. The behaviour is described in [AUTOMATION-SPEC](../AUTOMATION-SPEC.md), [SUB-CARDS-SPEC](../SUB-CARDS-SPEC.md) and [ONBOARDING-SPEC](../ONBOARDING-SPEC.md) in the sections where it lives.

### Fixed

- Review cycles and verdicts: fixcheck-a-1 / client-docs-1 / statemachine-2 (feedback starts a new review cycle, so reworked code after a last-round approval is reviewed again; `reviewedEvent`), statemachine-5 (a casual implementer turn during a review reopens it as round 1 instead of settling unreviewed), fixcheck-a-3 / statemachine-3 / tests-9 (moving a delivered card between work stages keeps it delivered), fixcheck-a-4 / statemachine-4 / tests-11 (the job's own reviewer outside its round changes nothing and stays exempt from A1).
- Turn handling: fixcheck-a-6 (a person's turn during `retry_wait` replaces the stale retry), statemachine-13 and tests-1 / tests-3 (every supervised turn end runs the dispatcher, so held review changes reach the implementer at once; peer-role deferral tested), fixcheck-a-2 and tests-4 (lost turns of errored or closed sessions; stale `starting` recovery), fixcheck-a-7 (unknown create/send outcomes and an exhausted cooldown budget at start wait for a person and keep nothing to re-send).
- Parents and sub-cards: statemachine-1 / client-docs-2 (a sub-card waiting for a person still counts as moving), subcards-1 / tests-5 (blockers are followed recursively; no cross-branch deadlock), statemachine-6 (`:moving`/`:held` in the wake signature), tests-6 and tests-8 (wake guards; ancestor cancel/archive stops descendants), statemachine-9 (a card whose workspace is gone settles as `session_unavailable`).
- Dispatch: fixcheck-a-9 / statemachine-10 (cooldown gating only for known, matching providers), statemachine-11 / client-docs-8 (cooldown log and retry wording), statemachine-12 and tests-2 (directory ownership only for cards still in play, now testable), client-docs-5 (projects without In review are frozen), statemachine-8 (settings saves and archive/unarchive no longer wait for dispatch).
- Sub-card tools: fixcheck-a-5 (agent restarts of a sub-card bounded at 2), fixcheck-b-5 / subcards-5 / tests-7 (a note for a live sub-card is refused, not dropped), fixcheck-a-10 (retried updates replay after the parent finished), fixcheck-b-3 (get_task part: parent branch on `sub_card_of`; start-prompt part: "Parent integration branch" in dependency-ready starts), fixcheck-b-1 / subcards-2 (create_card checks revisions once; a refusal after provisioning names the workspace and a retry reuses it), subcards-4 (`ANCESTOR_FINISHED` for card creation), subcards-6 (`start=now` refused before provisioning when In review is off), subcards-3 (bounded get_task handoffs, none in write results), subcards-7 (CLI no longer drops `--note`/`--kind`), tests-10, tests-12 and tests-13 (regression tests that guard their fixes; CLI test teardown always cleans up).
- Follow-up `07e817b`: subcards-1, second suggestion (the result for `subCard=false start=later` says a person starts it with Run with agent); subcards-4 (`flowly_update_card action=start` refuses under a cancelled or archived ancestor with `ANCESTOR_FINISHED`, while accept and cancel stay allowed). The shared automation guard already checks ancestors independently.
- Client: fixcheck-b-2 / client-docs-10 (Run with agent disabled in the board menu and phone sheet when the workspace is missing), client-docs-12 / client-docs-4 (drawer reason lines per state), client-docs-7 (automation entries in Needs attention follow the automation switch and clear for handled failures).
- Docs (this pass): fixcheck-b-6 / client-docs-9 (ONBOARDING-SPEC priority list, tip table and More features list include `sub-cards`, `agent-automation` and `task-intake`), client-docs-6 (AUTOMATION-SPEC statements made false by round 1: CLI `submit-review`, the skill's sub-card exception, delivered cards and moves), client-docs-11 (README and README.zh-CN say automation never *deliberately* interrupts, with the idle-only send limit), fixcheck-b-4 (the shared-directory guard only covers automation sessions; ordinary sessions in a shared directory are the user's to coordinate; AUTOMATION-SPEC §10, SUB-CARDS-SPEC §8 and both READMEs).

### Rejected

- fixcheck-a-8: the plugin worker runs one hook message's handlers in order, so the drained follow-up turn cannot be recorded before the delivery turn's end; a replay of the hook mutations reached review, not a nudge.
- statemachine-7: `create()` records the session id before the request and `exists()` runs before any re-creation, so the blind re-create did not happen. The latent path (stale recovery of a paused job) was closed anyway by fixcheck-a-7: recovery now applies only to starting, working and reviewing jobs.

### Not fixed

- fixcheck-b-4, code: the guard itself was not widened to ordinary sessions; only the documentation was corrected (see Fixed).
- client-docs-3, left for the owner's decision: automation's *Full access* loses to a Permissions choice on the same-provider project default model (the TASK-INTAKE-SPEC precedence from the task-intake work), but the toggle copy still promises no-approval runs. Either let Full access beat an inherited project mode, or change the toggle text and show the effective mode. AUTOMATION-SPEC §2 now states the current precedence.
- Left for the owners of those files: the `TipFacts` comments in `client/onboarding-logic.ts` still cite AUTOMATION-SPEC §7 and SUB-CARDS-SPEC §7 (the tips are in §6 of each); the skill's get_task line (`skills/flowly/SKILL.md` and `server/skill-source.ts`, "direct sub-cards and blockers also include a bounded read-only handoff…") does not yet say that handoffs appear only for In review or settled cards, within a 16,000-character budget, and that `sub_card_of` carries the parent's `branch`; its CLI parity line does not show `update-card --note`. Flowly `AGENTS.md` still says automation "never … interrupts sessions" without the host limit.

### Checks

- `npx tsc --noEmit`: passed.
- `npx vitest run` after this docs pass: **134 test files passed, 13 skipped; 1105 tests passed, 65 skipped** (the 65 skips predate this work).
- The round-2 fix batches added behaviour tests, each required to fail before its fix (new files such as `server/automation-review-cycle.test.ts`, `server/automation-recovery.test.ts`, `server/automation-parents.test.ts`, `server/automation-occupancy.test.ts`, `server/sub-cards-round2.test.ts`, `server/sub-cards-create-round2.test.ts`, `server/get-task-handoffs.test.ts`, `shared/automation-round2.test.ts`, `client/automation-round2.test.ts`). Tests use the in-memory fakes and never reach the daemon.
- Round 2 was not installed on the real daemon and not checked in the Web UI: **UNRUN**. This docs pass did not touch the daemon or its installed source.

## Round 3

The 15 confirmed findings and the integration gaps exposed while fixing them are covered through `921f336`. The final independent review found no new issues. Fixed-commit Luna verification at `43efb13` passed typecheck and three complete runs of 1,160 tests (65 skipped); installation and fresh live acceptance remain gated on the user pipeline becoming idle. [Finding mapping, regression evidence and current validation/install status](automation-review-round3.md). Earlier live results above remain evidence for their recorded versions only.
