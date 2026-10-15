# Ideas UI acceptance

**Date:** 2026-10-16 (Asia/Singapore)  
**Plugin:** `paseo-ultra-kanban` (already reloaded)  
**Headless test session:** `515d644c-2c8c-48d5-ad33-327427816eec` — `codex/gpt-6-luna`, `modeId: full-access` at creation; archived after the run.

## Fixture IDs

| Resource | ID / path |
| --- | --- |
| Plugin project | `909f09b2-2dd6-4a5c-b4c9-e5c882e4b890` |
| Native Paseo project | `prj_c0f6aa948c315b42` |
| Source card A | `ce36b545-93a9-4c83-b903-c17ae19b4605` |
| Source workspace | `wks_894c895389ea960f` |
| Derived card | `387e46b5-3fcf-4ad1-a4a5-0f288b8c5771` |
| Derived workspace | `wks_72909721ace128f9` |
| Idea IDs | `92e19aee-f82b-47bf-8d39-2d932a788c7f`, `33a14fec-69cd-4ac4-a45d-f1fe2ba176cf`, `7cb80e98-5c7b-40b2-993d-db1e64f3f710` |
| Fixture directory | `/var/folders/0b/f1crzdg95g5fwbq49s_3pw9c0000gq/T/paseo-kanban-ideas-ui-CXY4tI` (removed) |

## Headless binding method

Used Playwright 1.63 with a fresh, non-persistent headless Chromium context. Granted Chromium's `local-network-access` permission only to `https://app.paseo.sh`; the web client then connected directly to the already-running local daemon at `127.0.0.1:6767`. This used a separate browser profile and did not change daemon configuration. No pairing link, token, or credential was printed or saved.

## PASS

- Fixture worker proposed the requested three ideas through `kanban_propose_idea`. The first had `bugfix`/`high` and long context, the second omitted optional fields, and the third had a long rationale. The worker reported no workspace file edits.
- The desktop board card shows the lightbulb and count 3: [board, 1440×900 light](ideas-ui-board-desktop-light.png).
- The drawer order is Sessions → Ideas → Details & workspace. Ideas count is 3. Cards show bold titles, type and non-Normal priority when supplied, relative time, and a two-line collapsed rationale. “Not now” is quiet; “Good idea” is green with a thumbs-up; both align to the right. See [desktop drawer](ideas-ui-drawer-desktop-light.png).
- Tapping the first card exposed “What to do” and “Context”; tapping again collapsed it. The chevron changed direction. No visible jump or clipping was observed in the settled state: [expanded card](ideas-ui-expanded-desktop-light.png). The full drawer content is vertically scrollable.
- “Not now” removed Beta from the open list and showed `Closed · 1`; Restore returned it to the list and restored the count to 3. Screenshots: [dismissed](ideas-ui-dismissed-desktop-light.png), [restored](ideas-ui-restored-desktop-light.png).
- “Good idea” opened “Create task from idea” with the title, Bug fix, High priority, and description filled with the idea detail, Why, Context, From card, and source progress. The first instruction remained blank. The [prefilled form](ideas-ui-create-form-desktop-light.png) and [form controls](ideas-ui-create-form-bottom-desktop-light.png) show this state.
- Turned off “Start an agent now”; the button changed to “Create task”. Saving created the derived card with no session. The source idea appeared under `Closed · 1` and its link opened the new card. The new card drawer shows “From idea on Ideas UI source card A”; its backlink returned to card A. See [saved card and origin link](ideas-ui-after-save-desktop-light.png) and [accepted idea in compact view](ideas-ui-closed-accepted-compact-light.png).
- At 390×844, drawer buttons fit on one row, card text wraps within the drawer, and document/body widths both stayed 390px. Lower ideas and the closed group continue by vertical scrolling. See [compact light drawer](ideas-ui-drawer-compact-light.png). Dark mode was launched directly in dark color scheme and kept the drawer readable: [compact dark drawer](ideas-ui-drawer-compact-dark.png).
- No plugin console errors or page errors were recorded.
- Cleanup passed: worker archived; `projects.remove` with `alsoPaseo:true` removed the native project and plugin project; source/derived cards, ideas, and both workspaces are absent; the owned project backup and temp directory were removed. Cleanup evidence: [cleanup-evidence.json](fixtures/ideas-ui/cleanup-evidence.json).

## FAIL

- No product UI assertion failed. One Playwright locator timed out after the origin link had already navigated and replaced its DOM node; a fresh headless run verified the source/new-card navigation in both directions. This was an automation locator lifecycle issue, not a UI behavior failure.

## UNRUN

- Frame-by-frame animation timing and Reduce Motion behavior were not recorded; expansion, collapse, and restore were checked in their settled visual states.
- Native Electron window and physical phone rendering were not tested; desktop and compact acceptance used the requested isolated headless web client.
