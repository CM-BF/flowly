# Automation review: round 3

The interrupted `flowly-round3-fixes` workflow was recovered from its saved output and commits. Its first batch completed five commits through `89ec5c3`; the other implementation batch and final check had no tool calls before quota exhaustion. Completed work was retained. [Original 15 confirmed findings](automation-review-round3/findings.json); `r3-client-cross-2` duplicates `r3-machine-1`.

## Finding coverage

| Finding | Result and commits |
| --- | --- |
| machine-1 / client-cross-2 | Durable delivery identity preserves an existing verdict after the bounded history is pruned. `4a6a636`; the same-turn pruning gap was then closed in `1b73ca1`. |
| machine-2 | A session whose creation is unconfirmed stays waiting rather than being declared lost. `d9e312f`. The reviewer/casual-turn combination is bound to its original session and waiting state in `921f336`. |
| machine-3 | Snapshot-wide sub-card motion computation avoids enumerating dependency paths. `89ec5c3`. |
| machine-4 | A casual implementer turn preserves the ongoing review round and its verdict. `4ee5a7d`; pending operations and review delivery identity were hardened in `87daeab` and `579dcf4`. |
| tools-1 | A reserved creation passed freshness when claimed; retrying the same decision after 15 minutes can recover its workspace. New stale decisions remain rejected. `b00eb82`. |
| tools-2 | One card contributes handoff evidence once even when it has two link relations; the response also emits that evidence once. `737564e`, `3cad02f`. |
| tools-3 | A potentially busy parent's integration branch uses its saved branch or one `rev-parse`, without `git status`. `d0ae4e2`. |
| tools-4 | The complete workspace creation plan is persisted before provisioning and reused after a root-branch change or service restart. Legacy orphan receipts without a plan retain their workspace notice and require human reconciliation. `5a83062`. |
| tools-5 / tools-6 | Tool text distinguishes parked direct sub-cards from separate cards; the round-2 report correctly records the `07e817b` fixes. `d25ddc2`. |
| client-cross-1 | A failed card taken back by a person stays out of Needs attention after history pruning. `dd4c3ac`; immediate transaction durability was added in `1b73ca1`. |
| client-cross-3 | A resource snapshot older than a newly created card cannot establish that its workspace is missing. `816edb4`. |
| client-cross-4 | Workspace loss, session take-over and an abandoned ancestor have distinct persisted codes, translated reasons and activity. `826ca5c`. |
| client-cross-5 | Each occupancy attempt shares one paginated workspace snapshot and filters inactive jobs before directory checks. `8ecf42e`, fixture parity in `52b4b95`. |

## Integration checks

Independent read-only reviews of `e70cf7b` found additional interactions, all reproduced through behavior tests:

- A reviewer preparation or send suspended by a casual implementer turn must resume the same pending operation. Covered for preparation, provider features, creation and sending (`87daeab`).
- A new delivery must reject an old reviewer's verdict until that delivery's review instruction has reached it (`579dcf4`).
- A new delivery can itself leave the 100-event window before its turn ends. Its identity is now recorded in the event's transaction, so the old approval cannot cover the new work (`1b73ca1`).
- A failed card's take-back can also leave history before the next dispatcher pass. Its acknowledgment is now recorded in the move's transaction (`1b73ca1`).
- An unconfirmed reviewer creation followed by a casual implementer turn preserves its original session, wait reason and review identity (`921f336`). Late reviewers remain supervised; new work first receives a new review instruction.
- Create/send failures that return while an implementer temporarily owns the job retain their own outcome and budget. Known rejection clears delivery evidence; an unknown send waits without resending. A casual implementer answer also preserves a reviewer’s unanswered question (`921f336`).

The client review also checked expired reservations and manual orphan adoption: an expired request cannot provision again after receipt cleanup, and a manually adopted workspace remains uniquely bound. Seven client mutations were all caught by the regression tests. [Mutation results](automation-review-round3/client-mutation-results.json), [81-test baseline](automation-review-round3/client-baseline.log), [typecheck](automation-review-round3/client-typecheck.log).

Reverting only the durable history-marker change in an isolated export made both new history regressions fail, as expected. [Mutation output](automation-review-round3/history-marker-mutation.log).

An early full-suite run during shared-checkout edits exposed fixed-delay races in historical digest and summary timeline tests. They now await observable completion (`e70cf7b`); the focused suites pass. That moving-checkout run is not presented as final validation.

## Final validation and installation

Runtime code is frozen at `921f33686c1e03f6b6fff9b8a6ef4a5372d0fc82`; the final validation target is `43efb13c5ed28f483a91e018787599bedbb16233`, which adds isolated Git-stats and bounded-history test setup without changing product code. The final implementation check passed 11 automation suites (92 tests), typecheck and diff whitespace checks. [Code readiness and red-before-green record](automation-review-round3/code-ready.json). The final independent review found no new issues and passed 20 tests across four files, including the previously failing paused-RPC probes. [Independent result](automation-review-round3/independent-review.json), [probe source](automation-review-round3/independent-probes.ts.txt). The first fixed-export validation passed typecheck but failed the same Git-stats test in all three runs: it used `process.cwd()` and assumed the test checkout contained `.git`, so repository discovery never called the injected runner in a source archive. [Original failed results](automation-review-round3/pre-fixture-fix/final-evidence.json). `b095a7a` makes the test own a temporary repository marker and also verifies the empty non-repository case. An independent reviewer reproduced the environment dependency and confirmed the existing product behavior. The next fixed-export run passed twice but timed out in two history-regression tests during its first pass. [Complete results](automation-review-round3/pre-history-batching/final-evidence.json). Those fixtures filled history through hundreds of separate disk commits. `43efb13` batches unrelated history writes through the real event writer and retains real lifecycle transitions and explicit pruning assertions. The focused 10-test run passed, and three mutations independently showed that take-back durability, approval preservation and new-work review are still guarded. [Mutation results](automation-review-round3/history-test-mutations.json). Final full-access Luna verification of `43efb13` passed typecheck and all three full-suite runs: each run passed 144 files and 1,160 tests, with 13 files / 65 existing tests skipped. [Final summary](automation-review-round3/final-evidence.md), [structured results](automation-review-round3/final-evidence.json). Current-version Web UI acceptance remains pending. The real daemon remains `srv_BSheQn5lzdEE`, Paseo `0.12.0`, with Flowly `856c8718a57f2c3f6a4481eb84c06c2204364108` from the managed Git source `file:///Users/citrine/Projects/flowly-kanban/flowly`. No update, reload or daemon restart was performed during these repairs because a nonfixture card is still running.

Existing live evidence is version-specific: [previous automation run](automation-review-live.md) and [task-intake verification with remaining retests](task-intake.md). It does not verify these new commits. Remaining live scenarios include direct metadata organization, automated image input and launch overrides, Stop/Run again, project disable, blocker reasons and reviewer changes/rework.

No new onboarding tour or tip is needed: these fixes preserve the existing workflow and correct recovery, identity, menu availability and reason text.

## Cleanup and remaining gate

The final fixed export and independent review scratch copies were removed after their results were retained. Native test agents `91e6d4cd-e367-4244-ad36-51f224408d7c`, `9294a850-8b3d-4c55-8602-62a8411fb61b` and `a0c74ff7-e334-4309-9aad-965ea5f93d01` were confirmed idle and task-owned, then archived. No live fixture project, card or workspace was created in this round. [Cleanup record](automation-review-round3/cleanup.json).

The read-only install monitor continues until all Flowly user jobs and native card sessions stay idle for two minutes. The latest immediate check was not clear: the user pipeline still had working/reviewing/waiting jobs. Installation must recheck immediately, back up current state, then update the managed checkout to the exact tested SHA `43efb13`; no daemon restart is needed. The six pending live paths listed above must be exercised on dedicated fixtures and cleaned up before claiming overall acceptance.
