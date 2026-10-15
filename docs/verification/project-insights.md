# Project Insights acceptance

**Date:** 2026-10-16 (Asia/Singapore)  
**Plugin:** `paseo-ultra-kanban`, already installed/reloaded at `2b76ed99caf07b7f92b971642c13e5a33ca5dd52`  
**Headless Luna test session:** `03d2ee59-2b2e-4936-9e8b-4a95acf71121` (`codex/gpt-6-luna`, `modeId: full-access` at creation; setup idle, archived during cleanup)  
**Browser:** Playwright 1.63 headless Chromium, isolated non-persistent context; granted `local-network-access` only to `https://app.paseo.sh`; connected to existing daemon at `127.0.0.1:6767`. No native Paseo window was used.

## Fixture

| Resource | ID / path |
| --- | --- |
| Plugin project | `ab61444b-e2eb-4aa6-b5a8-3bdc12856fa8` |
| Native Paseo project | `prj_28d35f86304b62a7` |
| Fixture directory (deleted) | `/var/folders/0b/f1crzdg95g5fwbq49s_3pw9c0000gq/T/paseo-project-insights-FauNA8` |
| Review/rework card | `68936876-7dc1-4153-9b34-19393409715a` |
| Done card | `5fb32215-a478-4e44-be73-ec1660a7c29c` |
| Urgent Todo card | `9d64a04f-41e5-48e6-a490-df778aa9e7ce` |
| Second In review card | `d30d915d-f0c4-4a5c-ae44-e400662ad282` |
| Luna test session | `03d2ee59-2b2e-4936-9e8b-4a95acf71121` |
| Fixture Git commits | `643e810`, `a034747`, `590c05f` |

The fixture produced 4 created cards, 1 Done transition, 1 In review → Development rework, 2 review cards, one urgent Todo card, a Luna setup turn, and 3 Git commits. The RPC snapshot for 2026-10-16 returned `created=4`, `done=1`, `rework=1`, `turns=1`, `agentMs=9825`, `commits=3`, `added=7`, and `deleted=1`.

## Results

| # | Status | Result |
| --- | --- | --- |
| 1 | PASS | Insights entry, Board/Esc return, and `I` toggle |
| 2 | FAIL | Values match; Commits tile substitutes line delta for the visible 7-day average |
| 3 | PASS | Review waiting rows show age and open card drawer |
| 4 | PASS | R7 recommends urgent Todo first; Open opens that card |
| 5 | PASS | Yesterday/Today navigation and Today upper bound |
| 6 | PASS | Generate, Generating…, grouped summary, card link, archived labeled digest sessions |
| 7 | PASS | Seven bars, lane medians, and fixture Git files |
| 8 | PASS | Compact light/dark width, wrapping, collapse, and header controls |
| 9 | PASS | No console or page errors |
| 10 | PASS | Flow append/removal and fixture cleanup verified |

`npm run typecheck`: PASS. `npm test`: PASS — 58 files passed, 12 skipped; 308 tests passed, 63 skipped.

### PASS

1. **Desktop entry and navigation:** The Insights chip opened the Insights page. “‹ Board” and Escape returned to the board; focusing the board root and pressing `I` opened Insights. Screenshots: [board, desktop light](fixtures/project-insights/board-desktop-light.png), [Insights, desktop light](fixtures/project-insights/insights-desktop-light.png), [keyboard return](fixtures/project-insights/keyboard-board-return-desktop-light.png).

3. **Waiting on you:** Both In review cards appeared with elapsed wait times (7 minutes in the final pass). Clicking the first row opened its card drawer. Evidence: [Waiting card drawer](fixtures/project-insights/waiting-card-drawer-desktop-light.png).

4. **R7 suggestion:** The suggestion read `Nothing is running. Next up: “Insights urgent next card”.` and its Open action opened the urgent Todo card. Evidence: [R7 card drawer](fixtures/project-insights/r7-card-drawer-desktop-light.png).

5. **Day navigation:** Previous day showed Yesterday and hid Waiting/Suggestions; Next day returned to Today and was disabled there.

6. **Summary:** Today initially showed Generate. Clicking it showed Generating… and produced a headline, grouped Done/Progressed/Issues/Next bullets, and `Updated … · Haiku 5.5`. A summary card link opened the Done card. Two digest sessions created during the UI run were closed/archived and carried both required labels: `ultra-kanban=summarizer` and `ultra-kanban-project=ab61444b-e2eb-4aa6-b5a8-3bdc12856fa8`.

   - `2e5ceaac-b43f-4bd2-9d85-442d5e1694ae`
   - `9c98cba1-7c79-4006-85b8-242600e1d26d`

   Evidence: [generated summary](fixtures/project-insights/digest-desktop-light.png), [summary link drawer](fixtures/project-insights/digest-card-drawer-desktop-light.png), [cleanup/session evidence](fixtures/project-insights/cleanup-evidence.json).

7. **Last 7 days:** Seven date bars rendered; lane medians and Most changed files showed fixture values. Top files were `src.txt` (2 commits) and `README.md` (1 commit). Evidence: [trend, desktop light](fixtures/project-insights/trend-desktop-light.png).

8. **Compact layouts:** At 390×844, light and dark pages had no horizontal overflow (`innerWidth=docWidth=bodyWidth=390`). Six tiles wrapped into two rows; Last 7 days was collapsed by default and opened on tap; Back, Previous day, and Next day controls worked. Evidence: [compact light](fixtures/project-insights/insights-compact-light.png), [compact dark](fixtures/project-insights/insights-compact-dark.png), [compact checks](fixtures/project-insights/compact-evidence.json).

9. **Browser errors:** No plugin console errors or page errors were recorded in desktop or compact runs.

10. **Flow log and cleanup:** `flow/ab61444b-e2eb-4aa6-b5a8-3bdc12856fa8.jsonl` contained 16 fixture events (4 created, 9 status changes, 1 workspace auto-archive, 1 turn start, 1 turn end). Project removal moved the flow log into `removed/`; the fixture-owned log and project backup were then deleted. The native Paseo project, plugin project/cards, fixture workspaces, temporary directory and Luna test session were verified absent/archived. Evidence: [flow log before removal](fixtures/project-insights/flow-before-removal.jsonl), [cleanup evidence](fixtures/project-insights/cleanup-evidence.json).

### FAIL

2. **Commit tile average is not displayed visually.** The API values match the fixture actions, and all six accessibility labels report a 7-day average. However, the Commits tile shows `+7 −1` below the value instead of the required `avg 0/day`; the line-change hint replaces the average in the visible tile. Screenshot: [Insights, desktop light](fixtures/project-insights/insights-desktop-light.png). Repro: open the fixture project → Insights; inspect the Commits tile. It shows `3` and `+7 −1`, while the other five tiles show `avg 0/day`.

### UNRUN

- Native Electron and physical-phone rendering were not tested; desktop and compact checks used the requested headless web client.
- Error injection for unavailable model/digest RPC paths and ordinary card-message delivery were not exercised; no digest model error occurred during this run.

## Failure summary

One acceptance failure: the Commits tile does not visibly show its 7-day average. Open the fixture project’s Insights page and inspect that tile; it shows the line delta `+7 −1` where the other tiles show `avg 0/day`. All fixture-owned resources were cleaned up.

The first desktop harness pass reset to the Paseo home view when the same tab was resized from desktop to compact. Compact acceptance was rerun in a fresh isolated context and passed; this was a harness navigation issue, not a product failure.

## Follow-up fix (implementer)

FAIL #2 fixed after the run: a tile's hint (`+7 −1`, failed turns, peak sessions) and its 7-day average now share the line (`+7 −1 · avg 0/day`; on narrow phone tiles the line ends with an ellipsis). Typecheck passed and the plugin was reloaded; not re-screenshotted.
