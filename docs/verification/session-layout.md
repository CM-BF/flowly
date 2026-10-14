# Session preview layout verification

Date: 2026-10-14. Scope: focused component callbacks, full test-suite verification,
and final typecheck after the implementation owner declared the source stable.
Following the test-only legacy fixture compatibility update, the combined
focused renderer covered the new 13 checks plus the old 7 session-pane checks.
This verifier changed only this report and files under
`docs/verification/fixtures/session-layout/`.

## PASS

- Combined focused renderer, existing pure session-state tests, and legacy
  session-pane checks: **20/20 passed** across 3 test files.
  This includes Markdown blocks/partial fences/table cells; composer sibling
  placement and 72–120 pt input bounds; long metadata; an imperative mocked
  ScrollView ref verifying `scrollToEnd` on initial/content/layout and same-row
  text growth; 64 pt pause/resume and Jump; draft lock and successful/failed
  send behavior; membership/Back/unmount cleanup; 250 ms coalescing; and
  sequence/tool summary handling including malformed no-name calls.
- The timeline payload-error regression now passes: a payload `error` is
  rejected by the query function; an error with no output shows the error
  without “No text output yet.”
- Final `npm run typecheck`: **PASS**.
- Final full `npm test`: **PASS** — 10 test files passed, 2 skipped; 55 tests
  passed, 23 skipped.
- Temporary renderer cleanup: **PASS**. The unique renderer directory was
  removed in `finally`; see
  [cleanup receipt](fixtures/session-layout/session-layout-renderer-rerun-cleanup.txt).

## Prior failure, resolved

- The first focused pass found a product error-state defect: a failed timeline
  read with no entries also rendered “No text output yet.” The main agent fixed
  the conditional rendering and added a stale-output explanation when cached
  entries exist. The final focused payload-error regression passes.
- The earlier full-suite attempt failed at collection because the legacy
  `session-pane` mock lacked React Native exports now used by the renderer. The
  main agent updated that test mock; the focused legacy checks and final full
  suite now pass. The original raw output remains preserved at
  [first full npm test output](fixtures/session-layout/full-npm-test-output.txt).

## UNRUN

- Actual Paseo desktop/compact rendering, native keyboard placement, real
  scrolling/gestures, native focus and message delivery remain UNRUN. No Paseo
  window, session prompt or resource was used. Synthetic callbacks do not
  establish native UI behavior.
- No reload or Paseo-resource operation was performed by this verifier. The
  parent's runtime and cleanup confirmation is recorded below; it does not
  establish real UI behavior.

## Parent closeout

- Test session `1ea62ff1-6a08-4e88-bd17-1873cd76e53b` was created with
  `codex/gpt-6-luna`, `settings.modeId: "full-access"`, in existing workspace
  `wks_1b4e2fc48dd38d30`. No new project, workspace, card or child session was
  created; existing resources were preserved.
- After the final independent typecheck, the parent reloaded only
  `paseo-ultra-kanban`; reload and subsequent inventory confirmed running and
  enabled. The daemon was not restarted. The implementation SHA-256 values
  below still matched at closeout.
- The parent deleted the exact test session (`deletedCount: 1`), then confirmed
  native inspection returns `AGENT_NOT_FOUND`. Both recorded renderer temporary
  directories were checked absent. Downloaded documentation temporary files
  were also removed.
- The board remained one project / one task, with exactly the same SHA-256 as
  the current-run baseline and zero events for this test session. Runtime and
  cleanup proof: [parent-cleanup-state.json](fixtures/session-layout/parent-cleanup-state.json).
- Implementation and verification are closed for user review. Actual desktop
  and phone rendering, keyboard positioning, gestures and message delivery
  remain UNRUN.

## Evidence

- Focused output:
  [session-layout-components-rerun-output.txt](fixtures/session-layout/session-layout-components-rerun-output.txt)
- First full test output (preserved):
  [full-npm-test-output.txt](fixtures/session-layout/full-npm-test-output.txt)
- Final full test output:
  [full-npm-test-rerun-output.txt](fixtures/session-layout/full-npm-test-rerun-output.txt)
- Final typecheck output:
  [final-typecheck-rerun-output.txt](fixtures/session-layout/final-typecheck-rerun-output.txt)
- Renderer cleanup:
  [session-layout-renderer-rerun-cleanup.txt](fixtures/session-layout/session-layout-renderer-rerun-cleanup.txt)

### Source SHA-256

Captured after the focused/full-suite/typecheck runs; implementation source was
not modified by this verifier.

| File | SHA-256 |
| --- | --- |
| `client/session-follow.ts` | `1fa3e398167ebce46583cca99daa873892328690647880ff0ca6a01536fde105` |
| `client/session-markdown.ts` | `bff425a5f07738e9fd9f6237d63a725aebdd85b45a3bd4d86a6f338205598a1c` |
| `client/session-content.tsx` | `a8916f8c3437e2af673c906532d65001f1e88462b1ad441b5a381c13fe9984ae` |
| `client/session-preview.tsx` | `98a9e8b13bc9c68feab79a504cfa7055f27d9d2a374c947234ef00400756c0b8` |
| `client/session-state.ts` | `41344879d394c4cdc2fd9efb9b54ad571e1387af45b9295aa764e152b2e06b60` |
