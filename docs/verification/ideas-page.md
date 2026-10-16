# Ideas page acceptance report

Date: 2026-10-16 (Asia/Singapore)  
Plugin: `paseo-ultra-kanban`  
Method: Playwright 1.63 Chromium, fresh non-persistent contexts; granted `local-network-access` only to `https://app.paseo.sh`; connected to the already-running daemon at `127.0.0.1:6767`. I did not reload/restart the plugin or daemon and did not use the native Paseo windows. No token or pairing material was printed or saved.

## Fixture and sessions

The fixture plan and pre-creation record are in [plan.json](fixtures/ideas-page/plan.json) and [ids.json](fixtures/ideas-page/ids.json).

- Run ID: `3a097844-33dd-42bf-887e-af120fcb9edc`
- Temp git repo: `/var/folders/0b/f1crzdg95g5fwbq49s_3pw9c0000gq/T/paseo-kanban-ideas-page-svca1I` (removed)
- Plugin project: `04e323bd-52cd-41a2-bbc9-1a04439913e8` (`Ideas Page 3a097844`)
- Native Paseo project: `prj_933e4be1d1a6f1cc`
- Card A: `8d01ea4c-0c4d-433a-99cf-44825ab116c2`, workspace `wks_4fb84a3df891b22a`
- Card B: `fee7c9bd-9d4a-4f5a-ba0f-e2d56cf5a252`, workspace `wks_8b7df81bc6624dd7` (permanently deleted through the UI)
- Derived card from the accepted idea: `0c27cc60-cec2-48e6-81f5-bf8e6f17f83f`, workspace `wks_77606cfea4cfda1c`
- Ideas: A “continue validation” `1f7f1edf-52a4-4069-affb-5d4a31cda395`; A “independent filter audit” `18e65fe3-ea77-47b4-a4d7-c75ebc76d7ed`; B “add keyboard shortcut” `5521d014-00f2-4f7e-b56a-53da74cd4012` (deleted with B)

Full-access `codex/gpt-6-luna` sessions created for the fixture: Card A `cb44462f-63a0-421f-a7fc-ca419c47e4f8`; Card B `f116624d-43b4-4395-858a-59f8398e65c4`; check 9 on the derived fixture card `b5a2d9d2-c946-4030-bf30-a25668831850`. All three were archived during cleanup.

The first Card B idea proposal returned `UNAUTHORIZED` during the reported reload window. I retried once with a fresh task request; it succeeded and produced the recorded idea ID. This was transient test setup behavior, not recorded as a product failure.

## PASS

1. **Overview and navigation:** `Ideas 3` appeared before `Insights`. Clicking it opened the project Ideas page with the Board back control. `B` opened the page from the board; `Esc` left it; opening Insights closed Ideas. See [desktop board](ideas-page-board-desktop-light.png), [Ideas page](ideas-page-ideas-desktop-light.png), and [Insights](ideas-page-insights-desktop-light.png).
2. **Segments and controls:** Initial counts were Open 3, Accepted 0, Dismissed 0. Search matched idea text and card title. Newest, Priority, and Card sort choices worked; Group by card and all three filters worked. A no-match query showed “No matching ideas.” and Clear filters. See [sort view](ideas-page-ideas-priority-sort-desktop-light.png).
3. **Source cards and drawer:** Rows showed `From <card> · <lane>`. Clicking a source opened its drawer over the Ideas page. The drawer’s All ideas button opened the page filtered to that card; the `Card: Ideas Page Card A` chip removed the filter. See [drawer](ideas-page-card-drawer-desktop-light.png) and [card-filtered page](ideas-page-card-filter-desktop-light.png).
4. **Dismiss and restore:** Not now removed B’s idea from Open (Open 2); Dismissed showed it (Dismissed 1); Restore returned it to Open (Open 3, Dismissed 0).
5. **Finished card behavior and create-from-idea:** Card A moved to Done. Auto wrap up was enabled, so its session was archived automatically. Its ideas remained open and the overview count stayed 3. The finished-card Good idea menu for the `scope=here` idea contained only “Start a new task · Suggested” and the finished-card note; no continue/current-session option appeared. The form’s “Start an agent now” switch was off. Creating the task produced the derived card without a session, moved the idea to Accepted, and showed the source link. See [finished-card menu](ideas-page-finished-good-menu-desktop-light.png), [create form](ideas-page-create-from-finished-card-desktop-light.png), and [accepted result](ideas-page-accepted-desktop-light.png).
6. **Permanent deletion:** Card B’s UI dialog offered Archive and delete. After confirmation, B and its idea disappeared; the overview count reflected the remaining one open idea, while the accepted idea remained. See [delete dialog](ideas-page-delete-card-b-dialog-desktop-light.png) and [post-delete Ideas page](ideas-page-after-delete-desktop-light.png).
7. **Compact and dark rendering:** At 390×844, the Ideas page rendered and document/body widths stayed 390 px with no horizontal overflow. A dark screenshot was captured. See [compact light](ideas-page-compact-light.png) and [dark](ideas-page-dark.png).
8. **Ideas setting, check 9:** The setting was ON before the check. Turning it OFF while the page was open returned to the board; the overview chip and card lightbulb count disappeared, the drawer Ideas section disappeared, and B did nothing. A fixture-card session’s `kanban_propose_idea` returned `IDEAS_DISABLED` with the specified message, without an `ideaId`; plugin RPC showed the idea count was 2 both before and after. Turning the setting ON restored the `Ideas 1` chip, card count, drawer section, and B shortcut. **Final setting value: ON.** See [settings off](ideas-page-settings-off.png) and [settings on](ideas-page-settings-on.png); call and board-count evidence are in [settings-off-evidence.json](fixtures/ideas-page/settings-off-evidence.json), [settings-on-evidence.json](fixtures/ideas-page/settings-on-evidence.json), [disabled call evidence](fixtures/ideas-page/disabled-call-evidence.json), and [ids.json](fixtures/ideas-page/ids.json).
9. **Console and page errors:** Successful desktop, compact, dark, delete, and settings flows recorded zero plugin console errors and zero page errors. One early fresh-context startup had a transient `ERR_CONNECTION_RESET`; the retry and completed runs were clean.
10. **Cleanup:** PASS. The fixture project was removed through plugin RPC with `alsoPaseo: true`; both native project registry and plugin board show the project, cards, ideas, and workspaces absent. The temp directory was removed. All worker sessions were archived. Cleanup checks and IDs are in [cleanup evidence](fixtures/ideas-page/cleanup-evidence.json). Plugin-generated `removed/` backups for Card B and project removal were retained as lifecycle history; no plugin data files were edited.

## FAIL

No confirmed Ideas page acceptance assertion failed.

## UNRUN / observations

- Native Electron-window and physical-phone testing were not run, as requested. Acceptance used the specified isolated headless browser method.
- Animation timing and Reduce Motion behavior were not measured.
- **Adjacent workspace-restore observation (not classified as an Ideas-page failure):** after Card A was wrapped up in Done, I moved it back to Todo while preparing a writable fixture session for check 9. The drawer initially showed “Workspace is unavailable or archived” and zero sessions. A later `paseo ls --all` showed Card A’s original session idle, but I did not re-open the drawer to confirm its restored state. Check 9 therefore used a separate full-access fixture session on the derived card. The Ideas setting test itself passed.
