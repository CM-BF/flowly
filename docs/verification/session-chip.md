# Native session chip verification

Status: **TESTED — synthetic and automated checks passed; native UI remains unrun.**

## Scope and safety

- Independent test session: `d380e718-8a0a-42a6-bc1e-cabe0ef8f483`, full-access `codex/gpt-6-luna` (created by the parent agent at the user's request).
- Tester-owned paths: this report and `docs/verification/fixtures/session-chip/` only.
- No edits to implementation, spec, dependencies, unrelated fixtures, or other agents' work.
- No Paseo project, workspace, card, child session, or native UI interaction. No prompt to an existing session; no mark-read/attention mutation.
- CUA cannot identify the required non-fullscreen window by actual window ID/title/geometry. Native chip appearance/focus and desktop/compact navigation remain **UNRUN**.
- Main agent owns plugin reload and deletion of this exact test session.

## Coverage and results

- Source-stable notice received; final `client/session-link.ts`, `index.client.tsx`, `client/board.tsx`, and `client/drawer.tsx` contracts were checked before writing fixtures.
- Fake SDK/RPC/registrations and fake timers: valid/partial/oversized params; fresh card and exact actor resolution; paginated archived directory entries; linked/unlinked sessions; poll removal; lookup failure clearing; poll non-overlap; same-host navigation; new request IDs; competing completion ordering; teardown fencing and owned registration cleanup.
- Chip title truncation retains an emoji at the 28-code-point boundary.
- Synthetic `BoardScreen`: cancels the current board fetch before installing the fresh snapshot; clears search/priority filters; reveals archived/finished target; Close and same-param rerender stay closed; manual task open carries no session entry; a fresh request ID explicitly reopens the exact session.
- Synthetic BoardScreen/TaskDrawer: same request ID with a different session replaces the entry; a stale child's consume callback cannot clear the new target; Drawer consumes a repeated nonce when session changes; Back returns to task details. Existing pane tests additionally cover draft retention, per-session locks, subscription cleanup and exact native navigation callback arguments.
- Older pane/layout/attention fixtures were run read-only; no historical fixture or output was overwritten.

| Check | Result | Evidence |
|---|---|---|
| Session-link helper focused | PASS — 7/7 | `fixtures/session-chip/session-link-output.txt` |
| Synthetic BoardScreen/TaskDrawer focused | PASS — 3/3 | `fixtures/session-chip/focused-renderer-output.txt` |
| Prior pane/layout/attention regressions | PASS — 30/30 across 5 files | `fixtures/session-chip/legacy-regressions-output.txt` |
| Full test suite | PASS — 72 passed, 30 skipped; 13 passed files, 5 skipped | `fixtures/session-chip/full-suite-output.txt` |
| Final typecheck | PASS — `tsc --noEmit` | `fixtures/session-chip/final-typecheck-output.txt` |
| Initial typecheck attempt | FAIL — test fixture omitted required SDK navigation callbacks; fixture corrected and final run passed | Initial error was a synthetic test-props type mismatch, not product code |
| Native chip UI/focus and desktop/compact navigation | UNRUN — window cannot be safely identified | No UI action attempted |
| Fixture native project/workspace/card cleanup | NOT APPLICABLE — none created | Exact parent-created test-session cleanup is recorded below |

## Temporary paths and cleanup

- Focused renderer: `/var/folders/0b/f1crzdg95g5fwbq49s_3pw9c0000gq/T/kanban-session-chip-renderer-s2GQLJ`; removed in `finally`, existence check false (`fixtures/session-chip/focused-renderer-cleanup.txt`).
- Read-only regression renderer: `/var/folders/0b/f1crzdg95g5fwbq49s_3pw9c0000gq/T/kanban-session-chip-regressions-1qPBi6`; removed in `finally`, existence check false (`fixtures/session-chip/legacy-regressions-cleanup.txt`).
- Session-read regression tests own and remove their own temporary stores in `afterEach`; regression checks passed.
- No other temporary paths were created by this test session.

## Delivery boundary

No plugin reload or native session deletion was performed by this verifier. Synthetic tests do not prove the native composer chip's rendered appearance or real desktop/compact focus behavior.

## Parent closeout

- Parent creation explicitly selected `codex/gpt-6-luna`, `settings.modeId: "full-access"`, in existing development workspace `wks_1b4e2fc48dd38d30`; creation returned `currentModeId: full-access`.
- After the final independent typecheck, the parent reloaded only `paseo-ultra-kanban`. Reload and subsequent inventory confirmed enabled/running. The daemon was not restarted. The parent recorded source hashes at reload/closeout; these are a closeout snapshot, not an independent native rendering check.
- Exact native deletion returned `deletedCount: 1` for this test session; subsequent inspection returned `AGENT_NOT_FOUND`. Both renderer directories and all scoped `kanban-session-chip-` / regression `kanban-session-attention-` temporary directories were independently checked absent.
- The parent also checked the derived CLI context file for this exact deleted test actor. Any such file was removed only after matching its agent/workspace identity; no credential content was copied into evidence, and no shared board/read-store/secret file was edited.
- No fixture native project/workspace/card or child was created. The development workspace now belongs to a user-linked card, so the required test actor's normal lifecycle appears in history. Its activity count increased from three at the current-run baseline to four; board SHA-256 changed. This report does not claim globally unchanged board bytes or attribute every possible concurrent board change to the test. Existing two user projects/two cards and all normal history were preserved; no board file was rewritten for cleanup.
- The live read-store SHA-256 stayed identical to baseline and contains no acknowledgement for the test actor. No session was marked read by chip discovery/navigation.
- Evidence: [parent-cleanup-state.json](fixtures/session-chip/parent-cleanup-state.json). Delivery stops for user review. Real native chip appearance, desktop/compact focus and navigation remain UNRUN.
