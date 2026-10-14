# Session input verification

Date: 2026-10-14  
Status: focused verification, parent reload, and exact testing-session cleanup complete; live UI remains UNRUN.

## Scope and boundaries

This is independent testing for the authorized Enter-send follow-up composer in `docs/SESSION-INPUT-SPEC.md`. Test ownership is limited to this report and `docs/verification/fixtures/session-input/**`, plus minimal existing test-mock compatibility edits if required. Do not edit implementation, specs, dependencies, old evidence, or unrelated files. Preserve other agents' work.

No GUI is permitted unless CUA can identify the exact non-fullscreen Paseo window by window ID, title, and geometry; that target is currently unavailable. Do not create native projects/workspaces/cards, extra sessions or children, prompt/ack existing agents, write live Kanban status/progress, reload/restart, or delete resources. Root owns cleanup of the exact testing actor and derived context at closeout.

## Phase 0 planning record

Read `AGENTS.md`, `docs/SPEC-OUTLINE.md`, `docs/SESSION-INPUT-SPEC.md`, `docs/PROGRESS.md`, package scripts and the current `client/session-preview.tsx` structure. Existing renderer fixtures establish a temporary-prefix `react-test-renderer` pattern and environment-variable gates. The checkout path did not expose a `.git` directory, so no Git status was available; no repository state was changed beyond this report.

At planning time the test surface and implementation were treated as unstable. Verification began only after the source-stable notice. Source hashes are recorded below.

## Focused test design

1. Add pure `client/session-input.ts` contract tests for key classification and latest-draft buffer semantics: plain Enter submits once and prevents default; Shift+Enter preserves newline; composing and keyCode 229 never submit/prevent; unrelated modifiers preserve host behavior; repeated held Enter is suppressed. Exercise draft updates before parent render, snapshot clearing only when the submitted draft still matches, and preservation of newer text.
2. Add real `SessionPreview` synthetic React Native callback tests (not a hand-copied component): desktop/web `onKeyPress`, native `onSubmitEditing`, current Steer/Interrupt mode, and a synchronous same-turn operation lock shared by keyboard and button. Assert web ignores the native submit callback to prevent duplicate dispatch.
3. Negative guards: empty/whitespace draft, pending operation, inactive/hidden preview, unavailable task/workspace/provider, archived actor, wrong-workspace/moved actor, and stale saved key callbacks after visibility loss or Back/unmount must not dispatch. Use SDK/RPC/session mocks and send spies; do not contact live resources.
4. Submission outcomes: success sends the exact latest snapshot, clears only that expected draft and resumes follow-tail; failure retains draft and current follow/scroll state and permits explicit retry. Assert one dispatch per accepted Enter and exact target session for both Steer and Interrupt.
5. Copy and regressions: assert the tools section contains plain purpose text; preserve composer bottom placement, bounded multiline sizing, desktop/native hints, and run existing session preview Back/draft/lock, attention, chip, layout and drawer regressions.

Synthetic Shift/IME callbacks cover the specified behavior independently of hardware. Real native hardware Shift/IME, actual focus and message delivery remain separate device/UI checks and are UNRUN under the current window-target restriction.

## Runner and execution sequence

- Keep all new tests/runners/receipts under `docs/verification/fixtures/session-input/`.
- For every renderer run, create a unique OS temp directory, write its timestamped path receipt before installing/using the renderer, use `try/finally`, and write a cleanup receipt proving the path is absent. Do not alter dependency manifests or lockfiles.
- Run focused pure helper tests and SessionPreview synthetic tests first. Report concrete failures/defects with case, expected/actual, and raw output path before considering broad regressions.
- On focused success, run existing regression checks with the correct variables: `SESSION_ATTENTION_RENDERER`, `UIUX_TEST_RENDERER`, `SESSION_CHIP_RENDERER`, `SESSION_LAYOUT_TEST_RENDERER`, `MOTION_TEST_RENDERER`, and `DRAWER_TEST_RENDERER`. Set `MOTION_TEST_REDUCED=true` only for legacy immediate-close assertions.
- Then run final `npm run typecheck`; after source-stable focused success and final typecheck, run exactly one final `npm test`. Preserve timestamped outputs and cleanup receipts. Separate PASS, FAIL, and UNRUN in the final report.
- Do not reload/restart or perform GUI acceptance. Root handles testing actor/context cleanup at closeout; report any exact actor/context evidence needed by root without deleting it.

## Verification results

- PASS: pure helper and actual `SessionPreview` renderer tests, 17/17. Coverage includes Enter/Shift/IME/229/modifiers/repeat, web preventDefault and ignored submit callback, native Send configuration/callback, latest `onChangeText` before rerender, newer draft preservation, shared keyboard/button synchronous lock, retry after failure, tail resume on success, pending/unavailable/moved/hidden/unmounted guards, archived/provider-unavailable/empty guards, Steer/Interrupt target, and tools purpose/status copy.
- PASS: existing pane/layout/attention/chip/drawer/motion/card responder renderer regressions, 46/46 across 8 files. `MOTION_TEST_REDUCED=false` for the motion suite; the drawer's immediate-close case sets reduced mode internally.
- PASS: final `npm run typecheck` (`fixtures/session-input/typecheck-2026-10-14T06-45-10Z.txt`).
- PASS: exactly one final `npm test`: 14 files passed / 10 renderer-only skipped; 83 tests passed / 54 skipped (`fixtures/session-input/npm-test-2026-10-14T06-45-18Z.txt`).
- Compatibility-only test adjustment: `fixtures/session-layout/session-layout-components.test.tsx` now supplies a new explicit retry draft after the successful send, matching the new draft buffer contract. No product defect found.
- Initial exploratory attempts and their raw timestamped outputs are retained. The 5 initial preview failures were harness issues (unwrapped rerenders and an absent composer for a moved actor); corrected focused run passed. An initial broad regression run set reduced-motion globally and failed motion assumptions; corrected normal-motion run passed. The old layout failure was a missing parent retry-draft update; the fixture was adjusted and all regressions passed.
- Renderer temporary paths were recorded before installation and removed in `finally`; timestamped cleanup receipts report `renderer_temp_exists_after_cleanup=false` for focused and regression runs.
- Source SHA-256 at closeout: `client/session-input.ts` `7089462453f4bb96f99405307a7d52e8771fa565238cf3459f04c1b48b4d2726`; `client/session-preview.tsx` `d5d9940549983ea682eae077c6c039927d8e69c8528dd89f31619b68f0ff1b67`.
- UNRUN: native hardware Shift/IME, actual keyboard focus and message delivery, and desktop/compact visual UI. The exact non-fullscreen Paseo window identity/geometry is unavailable; no GUI action was attempted. Synthetic callbacks do not establish device behavior.
- The verifier created no additional native project, workspace, card, or child session, and made no live Kanban write. At this point in the chronology, the testing actor and derived-context cleanup remained with root; the verifier performed no reload/restart.

## 2026-10-14 incremental wire-contract follow-up

Root reported a source-stable change in `client/session.ts`: fresh actor refresh and task-context authorization remain, while `agent.send` now receives the exact user instruction plus the existing Steer/Interrupt options, without scope context or generated labels. `docs/SESSION-INPUT-SPEC.md` now states this wire contract, and root updated the existing `client/session.test.ts` expectation. No other production source changed after the prior verification.

- PASS: targeted `client/session.test.ts` plus a new multiline byte-exact fixture, 4/4 (`fixtures/session-input/wire-focused-output-2026-10-14T06-48-31.949Z.txt`). The fixture verifies exact raw newline/tab content, interrupt options, fresh actor refresh, latest context read, and absence of the old preamble/label.
- PASS: final typecheck after this source change (`fixtures/session-input/typecheck-wire-2026-10-14T06-48-38Z.txt`).
- Not rerun by instruction: the broad full suite. Prior 17 focused composer checks, 46 UI regressions, and full suite 83 passed / 54 skipped were completed before this bounded wire-payload update and are retained above as historical pre-update evidence.
- No product defect found. No live message, GUI, Paseo resource, reload, or Kanban write was performed. Root retains testing-actor/derived-context cleanup ownership.
- Post-update SHA-256: `client/session.ts` `e4c59a322b4001cf6e44337598cbfd1cd62f0b7242bc9a94bc2f846f7fa1946e`; `client/session.test.ts` `cf8fefe11bf44aef5defe9f14191ffbee3ed5ce9054e2e666892dc784bf3ae88`; `docs/SESSION-INPUT-SPEC.md` `0ef02c6b0bc244a5bb156a3a19ce7ee0141e119554a198caecd4cb868daddf10`. Unchanged composer sources remain `client/session-input.ts` `7089462453f4bb96f99405307a7d52e8771fa565238cf3459f04c1b48b4d2726` and `client/session-preview.tsx` `d5d9940549983ea682eae077c6c039927d8e69c8528dd89f31619b68f0ff1b67`.

## Parent closeout

- PASS: `paseo plugin reload paseo-ultra-kanban` exited 0; subsequent plugin inventory reports the directory installation enabled and `running`. No daemon restart or other plugin action was performed.
- PASS: deleted only the testing session `6cbf1980-bcac-4b6b-9693-2731c7b611c4` (`deletedCount: 1`, exact ID); subsequent native inspection returned `AGENT_NOT_FOUND`. Its exact derived CLI context file was removed and verified absent.
- PASS: all seven recorded renderer temp paths are absent, and the current `kanban-session-input-*` temp inventory is empty.
- PASS: board remains two projects and two cards. Six standard testing-session lifecycle events (three `agent.turn_started`, three `agent.turn_ended`) remain in history, explaining the revision increase from 146 to 158. There are zero test-agent write receipts. Session read-state SHA-256 is unchanged from baseline, with zero test-agent ID mentions. The board was not restored or edited for cleanup.
- UNRUN: real non-fullscreen Paseo desktop/compact UI, hardware Shift/IME, focus, and live message delivery; CUA could not bind the required window by ID, title and geometry. Synthetic callbacks and the wire-level unit fixture are not live delivery evidence.
- Machine-readable baseline and closeout: `fixtures/session-input/parent-baseline.json` and `fixtures/session-input/parent-closeout.json`. The test reports above retain pre-correction full-suite evidence separately from the post-correction bounded wire check.
