# Review levels and cached difficulty classification

Validation date: 2026-10-24. Runtime tested: `cc6a9eca286fa60898d49928205cceba8c651443`, Paseo daemon `0.12.0`. Dedicated full-access test session: `7eeebf12-723b-4700-81af-12b2be8c5cce`, `codex/gpt-6-luna`.

## Source and independent verification

- `npm run typecheck` passed; `npm test` passed 175 files / 1707 tests.
- Independent runtime review verified helper ownership across reload, superseded requests, late native creation and uncertain deletion. The fix preallocates an owned ID before creation, keeps bounded shutdown below the host's two-second deadline and recovers only matching recorded IDs. Unconfirmed missing creation remains recorded; this is not a guarantee of instantaneous deletion.
- Independent UI review verified the actual exported TaskForm's asynchronous classification updates and dirty-draft preservation. Both motivating regressions were reproduced without their fixes.
- Reviewer prompts at every level require changes for confirmed serious defects in the card's changes or realistic interactions even when acceptance criteria omit them. Only unconfirmed risks and out-of-scope improvements are advisory.
- Reproducible daemon client-bundle comparison: 1,390,065 bytes at base `ca58787` to 1,401,814 bytes, +11,749 bytes / +0.85%. No phone startup timing or native-speaker review was performed.

## Real daemon and model checks

The first fixture was nested inside a registered synthetic project and was rejected by its workspace-create safety hook. That attempt was preserved as blocked and cleaned; the hook was left intact. The retry used an independently owned ordinary repository outside that project. No user project or global Summary-model policy was changed.

| Check | Observed result |
| --- | --- |
| Auto storage foundation card | Model Deep, as expected |
| Auto permission-display UI card | Model Standard, as expected; keyword fallback alone would have called it Deep |
| Auto typo card | Model Light, as expected; keyword fallback alone would have called it Standard |
| Card content edited | Input hash changed and the actual model classified again |
| Pending to ready while editing | Unsaved title draft remained unchanged |
| Same content after refresh | Classification hash/time/verdict unchanged, no extra helper |
| Light automation | Real delivery and reviewer approval, single reviewer |
| Deep automation | First round used three panel perspectives; two rounds completed; remaining issues produced `changes` and the round-limit state, without false approval |
| Desktop task editor | Auto/Light/Standard/Deep and model reason visible |
| Deep card and drawer | Review depth, panel count and five earlier-delivery risks visible |
| Compact and project settings visual evidence | PASS in a focused recheck: full 430×932 CSS px viewport, board after refresh, Edit task and desktop/compact Edit project Review levels; invalid original clips retained as rejected evidence |
| Fixture cleanup | Exact project/card/workspace/agent IDs absent or archived as appropriate; owned directory removed |

The Deep fixture deliberately exercised design review. Its remaining findings concern the fixture's proposed persistence design, not unresolved product defects. The observed `changes` outcome verifies the stop-and-request-changes path; it is not an approved Deep delivery.

The fixture agents were confirmed as Codex GPT-6-Luna, high thinking, full-access, in their exact owned directory. Screenshots and DOM came from actual headless Chrome using `docs/promo/shot-lib.mjs`; no Paseo browser MCP was used. Original blocked and invalid-capture evidence remains retained alongside the successful checks.

Persistent local reports: `~/.paseo/verification/flowly-review-levels-20261024/`, with `live-luna/retry/REPORT.md`, `classification-results.json`, `classification-cache-draft.json`, `unchanged-refresh.json`, `automation-results.json`, `deep-panel-angles.txt`, exact cleanup ledger, `live-luna/retry/visual-recheck/REPORT.md` and full-width images, and the independent runtime/UI reports. These contain fixture evidence; private user briefs are not included here. The focused recheck's project/card/workspace were also removed and both registries checked; it created no task agents.

## Scope of the result

The tests establish real classification, cache invalidation, draft safety and both approval/changes automation paths. They do not establish that a difficulty model will classify every future card correctly, that panel reviewers find every architectural issue, or that an acknowledged risk is harmless. Explicit levels and foundation tags remain available; real review findings must still be assessed on their evidence.
