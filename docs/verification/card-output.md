# Card latest agent output — verification

Spec: [CARD-OUTPUT-SPEC.md](../CARD-OUTPUT-SPEC.md). Implementing session `2b7e6e2a-6725-4589-b7e3-4cb59f9c0705` (card F1). Code-only verification in worktree `feat/card-output-summary`; no plugin install/reload, no Paseo project/workspace/session created, no board data touched.

## PASS

- `npm run typecheck`: PASS.
- `npm test`: 18 files passed / 11 renderer-only skipped; 99 tests passed / 59 skipped. [Output](fixtures/card-output/npm-test-output.txt).
- `client/card-output.test.ts` 6/6: workspace-isolated, archived-excluded, most-recent session choice with deterministic ties; newest assistant text skipping user/reasoning/tool/empty/code-empty entries; Markdown stripping (headings, checkbox lists, quotes, emphasis, inline code, links/images, tables, rules, strikethrough, code-only fallback, length bound); limiter concurrency bound, FIFO, slot release on failure, aborted queued work never starting.
- Synthetic renderer `fixtures/card-output/card-output-components.test.tsx` 3/3 (with temporary `react-test-renderer@19.1.0`): single-line muted non-selectable output + time, accessibility label `… Latest agent output 5m ago: <text>.`, no extra line/label text without output, press/drag handlers intact, `LiveTaskCard` requests output only for an available workspace. [Output](fixtures/card-output/renderer-output.txt).
- Legacy `fixtures/ui-ux/card-responder.test.tsx` 8/8 after updating its stale `ui` mock (baseline HEAD already failed 5/8 from missing `radius`/`space`/`touch`/`verticalScroll` mock exports and the `IconButton` rename). The selectable test now includes an output line. [Output](fixtures/card-output/card-responder-output.txt).
- Temporary renderer directory `/tmp/kanban-card-output-renderer.zOc1qr` and baseline copy `/tmp/kanban-card-output-baseline.bvDgAo` removed and confirmed absent.

## FAIL (pre-existing, not changed)

- `fixtures/session-attention/session-attention-components.test.tsx` renderer run: 4 failures from its stale `ui` mock; identical failures on baseline HEAD. Not modified.

## UNRUN

- Installed plugin reload and live daemon timeline fetch (card instructions forbid install/reload).
- Real desktop/compact rendering, ellipsis width, screen-reader output, real mouse drag/touch press feel.
- Observed request rate against a live board (bounded by design: one tail fetch per visible card per session `updatedAt` change, ≤3 concurrent).
