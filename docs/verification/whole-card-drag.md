# Whole-card drag verification — 2026-10-14

**Paseo test agent:** `2fdbb024-4ddb-4793-bad5-d281470910ae`  
**Runtime session:** `01a1385f-6762-7af2-b6f9-5bfeedbaeb93`  
**Provider/model/mode:** `codex/gpt-6-luna`, `full-access` (confirmed from the live agent status).  
**Scope:** Verification fixture and evidence only. No client implementation, spec, dependency manifest/lockfile, Paseo project/workspace/card, or child session was created or changed. The existing `docs/verification/ui-ux.md` remains historical.

## PASS

- **Whole-card root pointer gating:** synthetic render confirmed only a primary mouse pointer arms drag; touch, pen, and secondary mouse button do not pass the movement capture gate. The 8-point threshold is checked.
- **Actions isolation:** the Actions wrapper clears the armed state and stops propagation; a subsequent root move cannot capture.
- **Click and drag callbacks:** ordinary card body click opens the card. A primary mouse drag calls start/move/end once and suppresses the release click.
- **Cancellation and disabled state:** pointer cancel and responder termination cancel an active drag once; disabled cards have no responder capture and do not start drag.
- **Text selection:** every rendered card Label explicitly passes `selectable={false}`. The actual `client/ui.Label` render passes `selectable={false}` to the host Text and sets `style.userSelect` to `none`; a source contract check also confirms that mapping.
- **Existing focused interactions:** cross-column release sends one update with the captured task revision/status; pending state disables drag. Resize grip behavior remains covered.
- **Default renderer-free test discovery:** `npm test` with `UIUX_TEST_RENDERER` absent passes and skips the seven renderer-only checks. Output: [default-no-renderer-output.txt](fixtures/whole-card-drag/default-no-renderer-output.txt).
- **Focused renderer checks:** 8/8 passed. Output: [focused-output.txt](fixtures/whole-card-drag/focused-output.txt).
- **Typecheck:** `npm run typecheck` passed. Output: [typecheck-output.txt](fixtures/whole-card-drag/typecheck-output.txt).
- **Final regression suite:** `npm test` passed 50 tests; 7 renderer-only checks were skipped because this run intentionally had no renderer environment. Output: [npm-test-output.txt](fixtures/whole-card-drag/npm-test-output.txt).
- **Temporary renderer cleanup:** `react-test-renderer@19.1.0` was installed only in a unique `mkdtemp` directory and pointed at the repository's pinned React via a temporary symlink. The `finally` cleanup removed the complete temporary directory; `exists_after_cleanup=false`. Output: [temp-cleanup.txt](fixtures/whole-card-drag/temp-cleanup.txt). No project dependencies were changed.

## FAIL

- None. Initial harness-only failures (a duplicate React copy, a mis-targeted Actions node, and a fixture `createElement` type mismatch) were corrected; the final recorded focused run is green.

## UNRUN

- **Real Paseo desktop interaction:** mouse drag, native click suppression, and rendered text-selection behavior were not exercised in the desktop app. The non-fullscreen window cannot be uniquely identified through the available computer-use surface, so no Paseo window was operated.
- **Phone/touch UI:** no physical or simulator device run was performed. Synthetic pointer callbacks do not prove native device gesture behavior.
- **Paseo resources and live persistence:** no project/workspace/card/session was created and no live board mutation was attempted. Those are unnecessary for this pointer-only verification.

## Parent closeout

The parent reloaded `paseo-ultra-kanban` after typecheck; the final runtime remains `running`. After verification finished, the parent deleted only test agent `2fdbb024-4ddb-4793-bad5-d281470910ae`; exact native inspection returns `AGENT_NOT_FOUND`. The existing development workspace and current board records were retained. The renderer directory is absent. No test project/workspace/card was created. [Parent cleanup evidence](fixtures/whole-card-drag/parent-cleanup-state.json).

