# Flowly automation review: live verification

Date: 2026-10-22 (America/Los_Angeles)

## Result

**PASS** for the project settings persistence/validation path, parent and sub-card automation with a real agent handoff, reviewer approval, and desktop/compact UI inspection. **No product failure was observed** in the exercised paths. See Unrun for scenarios outside this pass.

This was a real Web UI run against `https://app.paseo.sh`, using a separate headless Chrome instance and `docs/promo/shot-lib.mjs`. The browser route identified the local daemon as `srv_BSheQn5lzdEE` (Paseo `0.12.0`). The daemon kept Flowly running from `/Users/citrine/.paseo/plugins/flowly/76e62726-164c-44d6-871f-b0809ad908b3/checkout`, sourced from `file:///Users/citrine/Projects/flowly-kanban/flowly`, revision `0caefa58febaed77ad42a52a5184b9a561f867c8`. The source implementation commit under review was `409d713`; no reload or source/data restore was performed during this validation.

## Fixture and agents

The isolated fixture was created through Paseo and the Flowly UI, then removed through their UI flows.

| Resource | ID / path | Outcome |
| --- | --- | --- |
| Native Paseo project | `prj_72a4b054104a4ca3` | Removed from Paseo |
| Flowly project | `1d38dae2-21ed-4bfa-8983-b507999c0d43` | Removed from board |
| Parent card | `dc326c99-139f-4480-b1d1-897d8fe8520f`, workspace `wks_705b858e7869fb94` | Archived and permanently deleted after delivery/review |
| Child card | `a19d78fb-d092-4ddd-b5eb-6e8c8cc484c4`, workspace `wks_11fb17c466a00fa2` | Accepted as Done, then archived and permanently deleted |
| Fixture repo | `/Users/citrine/plugin-test-2026-10-22-luna-review` | Removed after Paseo project removal |
| Parent worktree | `/Users/citrine/.paseo/worktrees/09et1e54/kanban-build-tiny-math-helpers-and-integrate-on` | Archived by the UI; absent after cleanup |
| Child worktree | `/Users/citrine/.paseo/worktrees/09et1e54/kanban-implement-multiplication-helper-9980ea` | Archived by the UI; absent after cleanup |

Every automation session was Codex / `gpt-6-luna`, low reasoning, `full-access`. All four test-owned agents were archived after use:

- Parent implementer `83f71013-a69f-4e35-9250-9678a5ce3703`
- Child implementer `e37e31d6-7f08-4f19-bfb8-6fd1eea2ac1e`
- Child reviewer `adfcb518-c672-408f-ac4b-d019bbae8f21`
- Parent reviewer `8683a63b-0097-4984-8d04-67a01deeedf0`

## Scenarios

| Scenario | Result | Evidence |
| --- | --- | --- |
| Configure project automation, save, refresh, and verify persistence | **PASS** — enabled, max running `1`, Codex GPT-6-Luna low for implementer/reviewer, two review rounds, full access, and In review lane enabled remained selected after refresh. | `automation-review/03-automation-settings-configured.png`, `05-valid-settings-before-save.png`, `06-settings-persisted-after-refresh.png`, `07-settings-persisted-detail.png` |
| In review prerequisite and visible validation error | **PASS** — with automation enabled, turning off In review and saving was rejected with “Agent automation requires the In review lane.” The RPC surfaced `handler_error`; I restored In review and saved the valid configuration. | `automation-review/04-inreview-off-validation.png` |
| Desktop board and card interaction | **PASS** — the fixture opened on the local daemon; one parent card was created and claimed by the real automation agent. | `automation-review/01-empty-fixture-board.png`, `08-parent-card-created.png`, `09-parent-agent-running.png` |
| Parent waits for one explicitly started, `start=later` child | **PASS** — the parent agent created exactly one linked child, then started it. The persisted lifecycle records show `automation_waiting` at 23:51:36Z and `automation_woken` at 23:53:30Z. Screenshot 10 was captured after wake, so it shows the parent working again. | `automation-review/10-parent-waiting-child-in-review.png` |
| Child branch/check handoff and parent wake/integration | **PASS** — child branch `kanban/implement-multiplication-helper-9980ea`, commit `2bef453`, recorded `npm test` passing (3 tests). The parent woke after settlement, merged that branch at `d8c8ea9`, recorded its own passing check, accepted the child, and delivered itself to In review. The child was Done and parent In review before cleanup. | `automation-review/11-child-review-approved.png`, `automation-review/12-compact-parent-delivered.png`; parent and child workpad/activity in the live UI |
| Real reviewer approval | **PASS** — child reviewer approved. Parent reviewer also approved the delivered parent after reviewing the complete diff and independently running `npm test` (6 tests, 0 failures). | `automation-review/11-child-review-approved.png`, `automation-review/12-compact-parent-delivered.png`; reviewer result and automation state in the live UI |
| Compact board and project settings | **PASS** — inspected a 900px browser viewport for the compact board and a 1280px viewport for the full settings dialog. The dialog retained the selected model, review rounds, and full-access setting; no horizontal document overflow was observed. | `automation-review/12-compact-parent-delivered.png`, `13-compact-automation-settings.png`, `14-compact-automation-settings-lower.png` |
| Daemon/plugin check | **PASS** — `paseo plugin ls flowly --json` reported `running` at the target revision. The browser URL used the local server ID. Recent logs contained no plugin startup error; existing deprecation/transport warnings remain. | CLI state and browser session; not a UI screenshot |

The `npm test` commands above were run by the test-owned real implementation/reviewer agents in the isolated fixture worktrees as part of the live workflow. I did not run a broad test suite in this validation session.

## Unrun

- Stop followed by Run again and session reuse.
- Disabling project automation and verifying that the card neither wakes nor creates a session.
- A blocker-reason display path.
- A reviewer `changes` verdict followed by implementation rework; approval was exercised instead.

- Physical Android device testing, strict phone-width settings layout, provider-limit fault injection and unknown-message recovery on a live provider were not exercised; the latter recovery paths are covered offline.

## Cleanup and notes

- Both cards were archived, then deleted through the Flowly UI. In the delete dialogs I chose the option to archive Paseo sessions/workspaces, then confirmed Archive and delete.
- The project was removed using “Remove from board and Paseo.” `paseo project ls --json` no longer listed the fixture project; the Flowly project selector no longer listed it. The fixture repo, both worktrees, and the temporary fixture manifest/plan were removed. All four test-owned agents were archived.
- Flowly’s confirmation states that copies of permanently deleted card records remain in the plugin data folder. I left that plugin-managed record handling to Flowly and did not edit `board.json` or plugin data directly.
- Root reconciliation resolved the inventory count: its earlier snapshot had four entries, including a separate concurrent dynamic-workflow test fixture (`prj_8474b59633637446`). That fixture was cleaned by the other test session before Luna’s three-project preflight. The final three IDs match Luna’s preflight; this run’s fixture ID/path is absent. No user project was removed.
- Root independently confirmed the two cards/project are absent from board.json, the native fixture project is absent, both worktree paths and fixture root are gone, and all four listed agents are archived with no active turns or pending permissions. The initial parent identifier `01a16604-c7ea-7882-865d-6de9b2b32a4f` was its native Codex thread ID, corresponding to Paseo agent `83f71013-a69f-4e35-9250-9678a5ce3703`, not an extra leftover agent. The Luna validator itself was archived after verification. No active test monitors remain.
- Screenshot `automation-review/12-compact-parent-delivered.png` captures the real fixture board at compact width. An earlier capture of the unrelated default board was discarded and is not included.


## Independent evidence check

Root read the plugin-owned deletion backups without modifying them. The parent records `automation_waiting → automation_woken → automation_review_started → automation_review_approved`, finishing In review; the child records review approval and final Done. The parent’s reviewer independently ran six fixture tests, and the child’s reviewer ran three. Root also inspected the saved desktop/compact screenshots; they contain only the fixture flow, without the host workspace sidebar or unrelated conversations.
