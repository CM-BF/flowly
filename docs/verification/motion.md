# Board feedback and navigation motion verification

## Verification status

Phase 0 plan was prepared before source stabilization. The authorized source-stable verification is now complete for the checks listed below. No GUI action, plugin operation, Paseo session/resource creation, or fixture resource creation was performed.

The current Paseo UI automation surface does not expose an exact non-fullscreen window ID, title, and geometry. Therefore no Paseo GUI interaction is permitted under the acceptance constraint; actual desktop/compact motion and native toast remain UNRUN unless safe targeting becomes available.

## Scope and ownership

- Test/report ownership: this report and `docs/verification/fixtures/motion/**`, plus the specifically requested motion case in the existing session-layout renderer fixture.
- Compatibility changes: minimal additions to existing verification mocks for React Native `Animated`, `AccessibilityInfo`, `Easing`, and host `useToast`; historical outputs remain preserved.
- No implementation, spec, dependency, package manifest/lockfile, or unrelated verification edits.
- No native projects, workspaces, cards, child sessions, GUI actions, plugin reload/restart, or deletion of preexisting resources. The root agent owns cleanup of the exact testing session.

## Focused test plan

Use deterministic synthetic React Native animation callbacks, explicit completion control, fake timers where relevant, and spies for native toast, subscriptions, timers, navigation, writes, and pointer callbacks. Synthetic tests establish state/contract behavior only; they do not establish real frame rate, gesture feel, or native toast appearance.

| Area | Focused assertions |
|---|---|
| Motion preference | Starts safely in reduced motion before async preference resolves; handles resolved enabled/disabled preference; changed event updates state; query failure stays reduced; listener and animation cleanup on unmount/StrictMode replay. |
| Successful status feedback | Successful action and drop call host `useToast` success exactly once with expected lane-specific text and host default duration; no inline feedback/layout row; later success replaces earlier host toast. |
| Rejected status mutation | Actionable error remains visible; no success toast; no optimistic business-state completion. |
| Selection | Lane labels/counts/hints and card text have selection disabled, including during drag; task details, conversation output, and editable controls retain existing selection behavior. |
| Drawer presence | Enter and faster exit use expected opacity/transform transitions; close immediately disables interaction/subscription/deferred navigation while shell exits; reopen reverses exit; stale completion cannot dismiss a newer target; unmount stops animation work. |
| Session navigation | Preview forward and Back reverse transitions; chip/native target replacement follows the same identity; Back immediately deactivates/unmounts previous preview so delayed membership completion cannot navigate; selection, drafts, operation locks, and one-time chip consumption are unchanged. |
| Drag lifecycle | Pointer coordinates/resizing remain direct; eligible lane emphasis transitions; source card subdued and ghost lifted/faded; cancellation fades noninteractive ghost; a new drag supersedes exiting ghost; committed destination arrival transitions; captured-revision mutation occurs exactly once. |
| Cross-surface regression | Project/status content transition does not replay on streaming updates; composer/follow-tail, attention, and navigation identity behavior continue through the existing session-pane/layout/attention regression harnesses. |

## Execution sequence after source-stable notice

1. Re-read source and the existing renderer fixtures; adapt tests only to stable exports and current host mocks. Do not alter implementation/spec/dependencies.
2. Add a focused motion test file and runner in `fixtures/motion/`. Use a uniquely named OS temp directory for `react-test-renderer`; install with argument-array subprocess invocation, symlink the repository React version, and remove the exact temp directory in `finally`. Write new output/cleanup receipts under the motion fixture directory only.
3. Run the focused motion renderer suite, then the existing session-pane/layout/attention renderer regressions through a new runner and new motion-specific output filenames. Do not overwrite historical outputs or rerun an existing broad suite independently.
4. Run final `npm run typecheck`, then exactly one `npm test` after source stability. Save complete outputs, commands, exit codes, and precise PASS/FAIL/UNRUN counts here or under `fixtures/motion/`.
5. Verify every temp path recorded by this run is absent and report cleanup receipts. Do not reload/restart the plugin or delete the test session; root agent owns both closeout actions.

## Current result classification

- PASS: focused motion renderer checks (8/8), legacy renderer checks (42/42), added real `SessionPreview` exit lifecycle case (10/10 in its layout fixture), final typecheck, and the one full suite run (72 passed / 39 skipped).
- FAIL: 0 implementation behavior failures. Initial attempts had verification fixture issues, corrected before the recorded passing runs below.
- UNRUN: native Paseo UI/gesture/toast appearance and the specific cases listed under Coverage limits.

## Execution results and chronology

1. Focused motion renderer run: **PASS**, 3 files / 8 tests. Output: [focused renderer](fixtures/motion/focused-renderer-output.txt). The runner's exact temporary renderer path is recorded in [cleanup receipt](fixtures/motion/focused-renderer-cleanup.txt); absent after `finally` cleanup.
2. Legacy renderer run: **PASS**, 8 files / 42 tests (session pane, layout, attention, chip entry, whole-card drag, and related attention logic). Output: [legacy regressions](fixtures/motion/legacy-regressions-output.txt). Temporary renderer absent per [cleanup receipt](fixtures/motion/legacy-regressions-cleanup.txt).
3. Final full suite was run exactly once at 13:46:26, before the additional retained-preview lifecycle case was added: **PASS**, 13 files passed / 8 skipped; 72 tests passed / 39 skipped. The 8 skipped files require the temporary renderer and are covered by the renderer runs above. Preserved output: [full npm test](fixtures/motion/final-npm-test-output.txt). This full suite was not repeated after adding the retained-preview case.
4. Additional real `SessionPreview` exit lifecycle case, latest run at 13:53:06 using the existing layout mock harness: **PASS**, 10 tests in that fixture including the new case. While the parent presence shell remained mounted with its 160 ms exit completion held, the real preview remained mounted and its timeline subscription was disposed immediately; agent/timeline/tools/access queries became disabled. After the already-started native membership lookup resolved, `openAgent` was not called, the open control remained disabled, the composer input was non-editable, and send was disabled. Output: [preview exit focused run](fixtures/motion/preview-exit-focused-output.txt). Temporary renderer absent per [cleanup receipt](fixtures/motion/preview-exit-focused-cleanup.txt).
5. Final `npm run typecheck` after the latest fixture assertion: **PASS**, exit code 0. Recorded output: [final typecheck](fixtures/motion/final-typecheck-output.txt).

The first focused attempt exposed fixture setup errors (missing host tags and unwrapped renderer unmount); those were corrected before the passing focused run. The first legacy attempt used a normal-motion preference where pre-motion assertions expected immediate close and had an incorrect subscription-list assertion in the newly added test; the legacy-only mock now opts into reduced motion, and the test checks the unsubscribe callback. These were verification-harness issues, not source defects. No implementation defect was found in these checks.

## Coverage limits

- **UNRUN:** actual Paseo desktop/compact UI, native toast appearance, selection feel, smoothness/frame rate, and native-platform driver behavior; no safely identifiable non-fullscreen window target was available.
- **UNRUN:** explicit 2,200 ms toast duration assertion, replacement of one success toast by another, and status action-menu success path. The tested drop path verified success toast arguments, no inline row, and rejected mutation error/no success toast.
- **UNRUN:** task-detail/conversation text preserving selection; lane and card labels were checked as non-selectable, and legacy card regression checked card text selection.
- **UNRUN:** StrictMode replay, preference listener cleanup after a late promise settles post-unmount, animation stop assertion on unmount, compact drawer sizing/transition, actual drawer enter duration, preview/chip forward/Back animation identity, and read/tool action controls during preview exit. The retained preview lifecycle verified disabled open/send and non-editable composer input while exit remained active.
- **UNRUN:** LaneAccent transition, drag ghost fade/completion/replacement, committed destination arrival transition, and native gesture rendering. Synthetic tests did verify exact ghost coordinates, no coordinate easing, cancellation with no drop, and legacy exactly-once captured-revision drop.

## Cleanup and artifact hashes

All three renderer temporary directories were absent after their runner `finally` blocks. No native Paseo resources, GUI, plugin lifecycle, or sessions were touched by this verifier. The full-suite evidence file remains the original single run described above.

SHA-256 at closeout:

| Artifact | SHA-256 |
|---|---|
| `client/motion.tsx` | `0f51c37c40ae2184c3d541cd15c75e9d41b61bae77374264291dd4bbb71656e0` |
| `docs/MOTION-SPEC.md` | `691ddb0b87e6866dfc4682665b38d6b87b9ef0f90de5d8c4f39e97e53c6bd898` |
| `package.json` | `5bb1acabd3ff1a972121b2813416fd9845f8b4916fd636847b7eae6e617896da` |
| `package-lock.json` | `0852d1e9dd541d425a9e3e1ebcd680b121652f64ffcb0d7da2eaa72ec28f1295` |
| Final typecheck output | `f7555ff50055aa54dad8e533c15dc57332bb0d448b57d3e41dd4638e20fff3e9` |
| Focused output | `8cd94bef5a0ec0b343e0ac23fcf04b68e273c36d63e1e01196bd452615324161` |
| Legacy output | `4e6c6d6053786b1c6265c2b95ead389c25644dd26530625a5601e983eda0bb7b` |
| Full-suite output | `105ebb0f63cec124653b972245f6ec6323d87f0cb7a0b009be3630989b5839be` |
| Preview-exit output | `168a660702ef1dd48dc0763f5d1ee162ac41fae2dc19f161c7be5a80c7ae84ab` |


## Parent runtime and resource closeout

Test session `363ff97e-8a55-491a-bdfe-34d9e73c934b` was created in existing workspace `wks_1b4e2fc48dd38d30` with `codex/gpt-6-luna` and `modeId=full-access`. After independent verification, parent reloaded only `paseo-ultra-kanban`; inventory confirms enabled/running. Daemon was not restarted. Parent hard-deleted that exact test session (deletedCount 1); inspection returned AGENT_NOT_FOUND. Its exact derived CLI context was removed without logging its contents.

No test project/workspace/card was provisioned. Existing board remains two projects/two cards. Testing produced eight normal lifecycle entries on the user-linked development card; those entries were preserved, so board hash/revision changed. Read-state hash stayed identical and there are zero test-agent receipts. All recorded renderer paths, including the earlier focused path observed by parent, are absent; current `kanban-motion-*` temporary directory inventory is empty. Evidence: [parent closeout](fixtures/motion/parent-closeout.json), [baseline](fixtures/motion/parent-baseline.json), [window boundary](fixtures/motion/parent-window-boundary.txt). Real UI and the listed unexercised criteria remain UNRUN.
