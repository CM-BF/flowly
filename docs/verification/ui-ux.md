# UI/UX verification — 2026-10-14

**Test session:** `c8bfb6b3-40c8-40ec-8a0c-82a1909abe04` (`codex/gpt-6-luna`, `full-access`). Test session only; no child sessions or native Paseo resources were created.

## PASS

- **Responder focused checks:** 4/4 synthetic React renderer checks passed against the final component source. Card body press opens details without starting drag; only the enabled handle receives responder callbacks; handle grant/move/release reaches the drag callbacks; responder termination cancels; one cross-column release invokes `onDrop` once with the captured task revision/status; pending/disabled state blocks a drag; resize grip moves emit widths based on the captured initial width. This is component callback evidence, not real mouse/touch acceptance. Output: [card-responder-output.txt](fixtures/ui-ux/card-responder-output.txt).
- **Default regression suite:** final `npm test` with `UIUX_TEST_RENDERER` unset passed 49 tests; 4 renderer-only checks were intentionally skipped in this environment (8 files passed, 1 file skipped). The migration fixture cleanup change was included in this final run. Output: [npm-test-output.txt](fixtures/ui-ux/npm-test-output.txt).
- **Typecheck:** final `npm run typecheck` passed with the evidence fixture included. Output: [typecheck-output.txt](fixtures/ui-ux/typecheck-output.txt).
- **Default test discovery:** the responder fixture exits successfully without `UIUX_TEST_RENDERER`; renderer-only checks skip instead of requiring a temp package. Output: [default-no-renderer-output.txt](fixtures/ui-ux/default-no-renderer-output.txt).
- **Geometry/layout checks:** the full regression suite includes the geometry tests for scroll-offset hit testing, invalid drop bounds, one-root status update payload, edge-scroll bounds, drawer width clamps and the 760-point/native compact breakpoint.
- **Temporary files/resources:** renderer dependency was installed only under `/var/folders/0b/f1crzdg95g5fwbq49s_3pw9c0000gq/T/kanban-uiux-final-renderer-Eti4ED` and removed in `finally`; cleanup confirmed `exists=false`. An earlier empty temp directory `/tmp/kanban-ui-ux-renderer.XXXXXX` was also removed and confirmed absent. See [temp-cleanup.txt](fixtures/ui-ux/temp-cleanup.txt). This session created no Paseo project, workspace, card, or agent session.
- **Plugin reload state:** parent agent reported the final `paseo plugin reload paseo-ultra-kanban` returned `running` at approximately 10:44 SGT. This is a reload/runtime state report, not UI acceptance.

## FAIL

- **Initial review finding, fixed by the implementation owner:** the first reviewed `TaskCard` attached its threshold responder to the whole card, so vertical movement and movement beginning on Actions could be captured as a drag. The owner moved the responder to a dedicated 44×44 handle. The final synthetic checks verify that the card body and Actions have no responder handlers. No additional concrete source-level failure was found in the reviewed paths.

## UNRUN

- **Real Paseo desktop UI, mouse drag, edge scrolling, drawer resize, and appearance checks:** CUA `getState` exposed app names without window IDs, titles, or geometry, so the non-fullscreen Paseo window could not be identified safely. No Paseo window was operated.
- **Real phone UI, touch gestures, long-list scrolling, mobile detail/forms, and keyboard behavior:** no physical/simulator phone interaction was performed. Geometry helper checks and a synthetic renderer do not establish device behavior.
- **Live CAS rejection behavior:** the synthetic test verifies one captured-revision `onDrop` call and that pending/disabled state blocks a second drag. A server-side stale-revision rejection and rendered error/no-retry behavior were not exercised against the running plugin; those outcomes were source-reviewed only.
- **Human-visible post-reload UI/persistence:** reload returning `running` does not establish rendered UI behavior or persisted user interactions.

## Parent closeout and resource cleanup

- The parent created this one Luna test session in the existing development workspace. After the finish notification, it hard-deleted exactly `c8bfb6b3-40c8-40ec-8a0c-82a1909abe04`; native inspection returned `AGENT_NOT_FOUND`. The development workspace was retained. No native test project/workspace or board card was created.
- The earlier full-suite runs at 10:36:57 and 10:44:40 left two migration directories because the historical verification fixture lacked cleanup. The parent added `afterEach` cleanup to that test without changing migration assertions and removed only those two current-run directories after verifying creation times and exact fixture contents. Pre-existing historical migration directories were retained. Evidence: [migration-cleanup.json](fixtures/ui-ux/migration-cleanup.json).
- Final filtered runtime/registry and board checks confirm plugin `running`, test agent absent, current-run temporary directories absent, and board project/task/event/receipt counts all zero. Evidence: [final-cleanup-state.json](fixtures/ui-ux/final-cleanup-state.json). No daemon restart or unrelated resource deletion occurred.
