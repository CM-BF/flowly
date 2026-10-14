# Task sidebar redesign verification

**Current result (2026-10-14): PASS** — focused 8/8; corrected normal legacy 43/43 plus 2/2 reduced-motion immediate-close checks; final typecheck PASS. The earlier full suite remains 72 passed / 48 skipped and was not rerun. No implementation source hashes changed. Actual desktop/compact UI and native user-session/message delivery remain UNRUN. Detailed evidence and chronology follow.

## Phase 0 — plan ready (2026-10-14)

Scope is independent verification of the authorized task sidebar redesign in `docs/DRAWER-SPEC.md`. This phase prepared the test plan only. No focused checks, typecheck, full suite, Paseo session, plugin reload, or GUI action has been run. Waiting for the implementation owner to declare source stable.

### Ownership and preservation

- Verification artifacts: this report and new files under `docs/verification/fixtures/drawer/` only.
- Test-only compatibility changes, if needed after source stabilization: minimal public-host `SettingsSelect` and animation mock edits in existing verification mocks, preserving every historical output. No implementation, spec, dependency, or unrelated fixture edits.
- No child agents, native Paseo resources, sessions, prompts/acknowledgements on other sessions, reload/restart, or deletion of pre-existing state.
- The repository status command could not run because this checkout path has no Git metadata (`fatal: not a git repository`). Existing verification files were listed and left unchanged; no baseline source hashes were taken in Phase 0.

### Focused verification after source-stable notice

Use the newly scoped drawer runner and output paths under `docs/verification/fixtures/drawer/`; do not overwrite prior verification outputs. Exercise the actual `TaskDrawer` with synthetic props and callback spies. Source inspection and synthetic component checks are evidence for behavior only, not visual acceptance.

1. **Header and status mutation:** confirm public host `SettingsSelect` is grouped with Edit and Archive/Restore; seven labelled options and current value; no body status chips, width buttons, `onWidthChange`, or workspace navigation action. Same-value choice produces zero writes. Changed value produces exactly one write with the task ID and captured current revision. Pending mutation, archived task/project, and inactive drawer block selection/write. No optimistic value change or revision retry. Success toast appears only after successful completion; failure is shown beside actions and does not toast. Edit/Archive share the pending lock and retain archive resource-preservation behavior.
2. **Details disclosure and data:** new card starts collapsed; Details & workspace appears below Sessions, combining Priority, project root, workspace name/ID/path/status/native owner, created/updated timestamps, and preserved legacy scope directories. Confirm bounded/wrapping selectable paths, visible legacy explanation, and no workspace-open action. Availability/query errors and Refresh details remain available while collapsed; Refresh only re-reads resource state. Activity stays below details with chronological/history behavior.
3. **Disclosure motion/accessibility:** verify measured-height reveal/collapse, opacity/chevron progress, rapid reversal and stale completion handling, hidden/noninteractive exiting content, labelled Pressable, expanded accessibility state and minimum hit target, Reduce Motion behavior, and animation cleanup on unmount. Include content/layout measurement changes while open and verify the JS-driven measured-height path.
4. **State transitions:** Back from session preview and polling preserve disclosure state and session draft/operation state; selecting another card resets disclosure to collapsed; a fully unmounted close/reopen starts collapsed. Polling does not replay navigation or reopen details.
5. **Layout/regression:** check narrow 340-point and compact action wrapping plus bounded long titles/paths. Regress session pane/layout, attention/read behavior, session chips, draft/lock, tail behavior, shared motion, drag/drop feedback, and immediate resize/pointer coordinates with the new runner and new output names. Preserve prior outputs.

### GUI boundary

Actual desktop/compact appearance, native dropdown placement, path wrapping, and gesture/keyboard/animation feel are UNRUN unless the exact non-fullscreen Paseo window can be identified and bound by window ID, title, and geometry. The required target was unavailable in earlier CUA inventory; do not attempt GUI actions without that exact target. No native resources or children are needed for this synthetic verification.

### Final gate and cleanup

After focused checks pass against stable source, run `npm run typecheck`, then exactly one `npm test`. Do not run the final gate before focused success. Record each check as PASS, FAIL, or UNRUN and preserve raw outputs under the new drawer fixture paths. Every unique temporary renderer path created by a runner must be recorded before creation and removed in `finally`; retain cleanup receipts and verify paths are absent. Root owns exact test-session and derived-context cleanup; preserve normal lifecycle history. Do not reload/restart/delete anything. Stop with the report for user review after verification.

## Current result — bounded follow-up, 2026-10-14

The source hashes are unchanged. This verification is running in the active full-access `codex/gpt-6-luna` session; native user-session/UI message delivery remains UNRUN. Root owns reload and exact-session cleanup after this callback.

### PASS

- Final focused drawer checks: 8/8. They include the explicit stale-exit callback sequence: hold the closing animation completion, reopen, force the old completion with `finished=true`, assert the body remains mounted and expanded, then close and finish the current exit to assert cleanup. The archived-project selector guard and inactive `SessionCreate` props (`open=false`, `unavailable=true`) are asserted too. Evidence: [final focused output](fixtures/drawer/focused-output-2026-10-14T06-22-43-217Z.txt).
- Corrected normal legacy regressions: 43/43 across 9 files, including attention, `ui-ux/card-responder`, and `session-chip/board-entry` coverage (the latter is run separately below). Evidence: [legacy output](fixtures/drawer/legacy-regression-output-2026-10-14T06-22-43-217Z.txt).
- Legacy immediate-close check: 2/2 with `MOTION_TEST_REDUCED=true`, isolated to the board-entry fixture. Evidence: [reduced-motion output](fixtures/drawer/legacy-immediate-close-output-2026-10-14T06-22-43-217Z.txt). Focused drawer tests explicitly run with normal motion; the focused reduced-motion test controls its own setting.
- Final typecheck: PASS. Evidence: [follow-up typecheck](fixtures/drawer/typecheck-final-followup-2026-10-14T0623Z.txt).
- The earlier single full-suite result remains 72 passed / 48 skipped across 22 files in [full-suite output](fixtures/drawer/full-suite-output.txt). It was not rerun, as requested, because this follow-up changed only verification fixtures and mocks.
- The follow-up source hashes in [source hashes](fixtures/drawer/source-hashes-2026-10-14T06-22-43-217Z.json) match the final on-disk implementation hashes. No implementation/spec/dependency files changed.
- The latest unique renderer path `/var/folders/0b/f1crzdg95g5fwbq49s_3pw9c0000gq/T/paseo-drawer-renderer-yWJcmW` is absent; see [cleanup receipt](fixtures/drawer/renderer-cleanup-2026-10-14T06-22-43-217Z.txt). Earlier retry paths are also absent and each has its own receipt.

### Chronology

- 14:20: The first expanded legacy invocation applied `MOTION_TEST_REDUCED=true` to the whole regression set. That invalidated normal-animation timing expectations in motion primitives and session-layout (5 failures plus an unhandled deferred-preference error); no implementation defect was indicated. The preserved output is [here](fixtures/drawer/legacy-regression-output-2026-10-14T06-20-35-334Z.txt).
- 14:21: Split legacy execution: ordinary regressions use normal motion; only board-entry immediate-close checks use reduced motion. Corrected `SESSION_ATTENTION_RENDERER`; added card-responder and board-entry coverage. This passed 43 + 2 checks.
- 14:22: Added inactive `SessionCreate` assertion. One attempt attached its `unavailable=true` expectation to the archived-task case, which correctly reported resource availability; corrected it to apply only to inactive drawer. Final focused, normal legacy, and immediate-close runs all passed. The failed fixture-only attempt is preserved at [focused output](fixtures/drawer/focused-output-2026-10-14T06-22-27-764Z.txt).
- Final follow-up typecheck passed. No full-suite rerun, GUI action, native resource/session creation, child delegation, plugin reload, or restart occurred.

### UNRUN / limits

- Desktop/compact visual layout, real dropdown/sheet placement, on-screen long-path wrapping, and keyboard/gesture/animation feel remain UNRUN because there is no safely identified non-fullscreen Paseo window target.
- Synthetic renderer checks establish callback/component behavior, not native host `SettingsSelect` rendering or platform animation feel. Native user-session/message delivery remains UNRUN.

### Earlier verification chronology

The original focused/legacy pass and full suite are documented above in the historical outputs. Earlier fixture loader/mocking corrections and the first typecheck's nullable animation-value correction are retained in their respective timestamped outputs. None identified a product defect.


## Parent runtime and resource closeout

Verification used actual Paseo session `5a68229e-51a2-4b3c-8d66-d20a373d5374`, created with `codex/gpt-6-luna` and `modeId=full-access` in existing development workspace `wks_1b4e2fc48dd38d30`. No fixture project/workspace/card or additional child was created. After the final callback and typecheck, parent reloaded only `paseo-ultra-kanban`; inventory confirms enabled/running. The daemon was not restarted.

Parent deleted that exact test session (deletedCount 1), and subsequent native inspection returned AGENT_NOT_FOUND. Its exact derived CLI context was removed without logging contents. All six recorded renderer paths are absent; current scoped temporary directory inventory is empty. Current implementation hashes match the verifier's final snapshot. Project/card counts remain 2/2. Six normal lifecycle events for the testing session were preserved on the user-linked card; board bytes/revision changed, so an unchanged board hash is not claimed. Live read-state hash is unchanged and there are zero receipts for the test actor.

Evidence: [parent closeout](fixtures/drawer/parent-closeout.json), [baseline](fixtures/drawer/parent-baseline.json), [fresh window boundary](fixtures/drawer/parent-window-boundary.txt). Actual desktop/compact appearance, native selector placement/keyboard/path wrapping and gesture/motion feel remain UNRUN. Implementation is delivered for user review.
