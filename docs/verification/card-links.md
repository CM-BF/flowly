# Card links acceptance report

Date: 2026-10-16 (Asia/Singapore)
Plugin: `paseo-ultra-kanban` (preloaded instance; no reload/restart)

## Method

Headless Playwright Chromium following `ideas-ui.md`: fresh non-persistent context, `local-network-access` granted only to `https://app.paseo.sh`, direct connection to the already-running local daemon at `127.0.0.1:6767`. No token or pairing material is recorded. Browser: Playwright 1.63. Fixture directory was created by `mktemp -d` with prefix `paseo-kanban-card-links-`; actual path and resource IDs are recorded below and in the fixture record. Setup/cleanup evidence is under `fixtures/card-links/`.

## Fixture plan (written before creation)

- Disposable git repository and plugin project: generated under the dedicated temp directory; project title `Card Links <8-char run id>`.
- Cards: `Card Links A`, `Card Links B`, `Card Links C`; additional follow-up card is created via UI.
- Session: one `codex/gpt-6-luna` full-access session on a linked fixture card; archive after the tool/context check.
- Run ID: `cfc6504c-8f61-460d-bab7-4abaf5b1c314`; plugin project `abc3a335-97ba-420c-a34d-d26ae40b83c6`; native project `prj_06aa3549a389e4b2`; temp path `/var/folders/0b/f1crzdg95g5fwbq49s_3pw9c0000gq/T/paseo-kanban-card-links-1RpKcJ`.
- Cards: A `801d627c-5ebc-4c92-bd90-2280bad89b4a` / workspace `wks_c4dacbdc3c69cdd8`; B `de585f04-d9be-4d9e-a801-7a137f4641c0` / workspace `wks_c8278b483854bb0b`; C `2d7cfbea-070a-4143-9b74-1b489518459d` / workspace `wks_21557016dde90ba7`. Full fixture record: [fixture-ids.json](fixtures/card-links/fixture-ids.json).

## Results

| Check | Result | Evidence |
|---|---|---|
| 1. Menu and Links section, desktop/compact | PARTIAL: Links section PASS; menu/compact UNRUN | [desktop board](card-links-board-desktop-light.png), [desktop drawer](card-links-drawer-desktop-light.png), [browser evidence](fixtures/card-links/ui-evidence.json). Drawer showed `Links` below `Sessions` (no ideas). Right-click automation first targeted the drawer title and did not open the context menu; compact run exceeded the browser automation timeout. |
| 2. Link modal and relation behavior | UNRUN | Modal did not open because menu was not reached; no link writes made. |
| 3. Blocks waiting signal/resolution | UNRUN | No link writes made. |
| 4. Cycle and Related duplicate errors | UNRUN | No link writes made. |
| 5. Remove link and Activity events | UNRUN | No link writes made. |
| 6. New follow-up task | UNRUN | No follow-up card created. |
| 7. Permanent deletion backup | UNRUN | Project cleanup backup was created by project removal; no linked task deletion backup was exercised. |
| 8. Agent tool/context and archive | UNRUN | No session started. |
| 9. Plugin console/page errors | PASS for the exercised desktop path | Browser evidence records zero console and page errors through board/drawer interaction. |
| Desktop 1440×900 light; compact 390×844 light; one dark screenshot | PARTIAL | Desktop board/drawer light screenshots saved. Compact/dark UI did not complete; one attempted compact dark capture timed out before evidence was returned. |

No product bug was confirmed. The context-menu check was inconclusive because the automation right-clicked a drawer title and the compact browser launch timed out; these are test execution gaps, not product failures. No links were written.

## Cleanup

PASS. No sessions were created. `projects.remove` with `alsoPaseo: true` removed plugin project `abc3a335-97ba-420c-a34d-d26ae40b83c6` and native project `prj_06aa3549a389e4b2` (three workspaces); all three cards were removed. The dedicated temp directory was deleted. Post-cleanup native project registry and plugin board both report the fixture absent. Evidence: [cleanup-evidence.json](fixtures/card-links/cleanup-evidence.json). Project-removal backup: `/Users/bofan.wang/.paseo/plugin-data/paseo-ultra-kanban/removed/abc3a335-97ba-420c-a34d-d26ae40b83c6-2026-10-16T01-46-42-505Z.json` (left in place).


## Run 2

Date: 2026-10-16. Fresh fixture; previous run retained unchanged.

### Pre-creation record

- Run ID: `ed86d3bc-4574-4196-8e60-654a8dcaa042`; dedicated temp path reserved: `/tmp/paseo-kanban-card-links-run2-ed86d3bc` (will be created only after this record).
- Planned operation IDs: `card-links-run2-project-ed86d3bc-4574-4196-8e60-654a8dcaa042`, `card-links-run2-A-ed86d3bc-4574-4196-8e60-654a8dcaa042`, `card-links-run2-B-ed86d3bc-4574-4196-8e60-654a8dcaa042`, `card-links-run2-C-ed86d3bc-4574-4196-8e60-654a8dcaa042`.
- Resources to be created: one plugin/native fixture project, three task cards with one workspace each; one Luna 6 session on a linked fixture card only for check 8. Plugin-generated resource IDs will be appended immediately after each creation.

### Run 2 results

| Check | Result | Evidence |
|---|---|---|
| 1. Card menu and Links section | PASS desktop; UNRUN compact | Desktop card actions menu showed both `Link to a card…` and `New follow-up task` ([menu screenshot](card-links-run2-followup-actions.png)). Drawer shows Links under Sessions ([drawer/activity screenshot](card-links-run2-activity-final.png)). Compact 390×844 was attempted twice in isolated `isMobile`/`hasTouch` contexts; both runs could not interact with the hidden/non-visible sidebar “Ultra Kanban” target, exact blocker recorded in [compact evidence](fixtures/card-links/compact-dark-run2-evidence.json) (second attempt used force click). |
| 2. Link modal, search and link display | FAIL: already-linked candidate remains enabled; other checks PASS | The modal opened with all four relation choices. Search by exact title returned only the matching candidate on retry ([search screenshot](card-links-run2-search-exact-retry.png), [evidence](fixtures/card-links/search-retry-run2-evidence.json)). Candidate rows displayed lane names. Creating Related showed `Linked` toast and both cards displayed the relation ([evidence](fixtures/card-links/group2-run2-evidence.json)). Bug: after B was linked to C by Blocks, opening C’s modal and choosing Related still showed B as enabled and without `Linked`; clicking it then produced `These cards are already linked.` while keeping the modal open. See [candidate screenshot](card-links-run2-related-existing-blocks-candidate.png), [refusal screenshot](card-links-run2-related-refusal.png), and [evidence](fixtures/card-links/group5-run2-evidence.json). Exact repro: create B Blocks C; open C → Links + → Link to a card… → Related. B is offered as an enabled candidate despite the existing B/C link; click B and the server rejects it with `These cards are already linked.` |
| 3. Blocks waiting signal and resolution | PASS | Before resolution, board screenshot shows `Waiting on 1` on C ([screenshot](card-links-run2-waiting-on-before-desktop-light.png)); after moving A to Done, B’s drawer lists A in `Was waiting on` and the B board card no longer has a waiting signal ([screenshot](card-links-run2-resolved-b-drawer-desktop-light.png)). |
| 4. Cycle and duplicate Related errors | PASS for server/UI error behavior; same disabled-candidate bug as check 2 | C Blocks A produced the cycle error inside the modal; no C→A link was written. Related between already-linked B/C was refused with `These cards are already linked.` ([cycle screenshot](card-links-run2-cycle-error-desktop-light.png), [group 3 evidence](fixtures/card-links/group3-run2-evidence.json), [group 5 evidence](fixtures/card-links/group5-run2-evidence.json)). Candidate disabling is separately recorded as the check 2 failure. |
| 5. Remove link and Activity | PASS | Row X removed B→C; the drawer no longer lists C under Links. Activity shows `You linked` and `You unlinked` records for Blocks B/C ([screenshot](card-links-run2-activity-final.png), [evidence](fixtures/card-links/final-drawer-run2-evidence.json), [RPC event evidence](fixtures/card-links/verify-run2-evidence.json)). |
| 6. New follow-up task | PASS | Form title and `Follow-up of <source>` line verified; saved without starting a session; new drawer showed `Follow-up of B`, and B listed it under Follow-ups ([form](card-links-run2-followup-form-desktop-light.png), [new-card drawer](card-links-run2-followup-drawer-desktop-light.png), [evidence](fixtures/card-links/group6-retry-run2-evidence.json)). |
| 7. Delete permanently linked card and backup | PASS via `tasks.delete` RPC; UI action UNRUN | The linked follow-up card was permanently deleted via the plugin RPC. Backup `/Users/bofan.wang/.paseo/plugin-data/paseo-ultra-kanban/removed/task-353a0c17-8868-4ccf-81bd-51daf77a8916-2026-10-16T01-55-28-045Z.json` contains the card’s `derived` link. The card actions menu did not expose Delete permanently; after two UI attempts this entry is UNRUN. Evidence: [delete-evidence-run2.json](fixtures/card-links/delete-evidence-run2.json). |
| 8. Agent view | PASS | Started from B’s drawer. Session `1d94a008-4d15-4590-ae37-df81f82582d7`, provider `codex/gpt-6-luna`, mode `full-access` at creation. It called `kanban_get_task` and reported `blocked_by` A (Done, lane Done) and `follow_up` card (Todo, lane Todo). Initial context listed the follow-up only; resolved `blocked_by` was omitted. Archived after the report. [session screenshot](card-links-run2-agent-session-created.png), [CLI tool log and result](fixtures/card-links/agent-result-run2.json), [archive evidence](fixtures/card-links/delete-evidence-run2.json). |
| 9. Plugin console/page errors | PASS for exercised paths | No console or page errors in the desktop group scripts that completed; see each `*.json` evidence under [fixtures/card-links](fixtures/card-links/). |
| Desktop light, compact light, dark screenshot | Desktop light PASS; compact UNRUN; dark PASS | Desktop light screenshots include board, modal, link states, follow-up form and drawers. Compact failed twice as detailed in check 1. Separate 1440×900 dark desktop context rendered board and drawer: [dark board](card-links-run2-board-desktop-dark.png), [dark drawer](card-links-run2-drawer-desktop-dark.png), [evidence](fixtures/card-links/dark-desktop-run2-evidence.json). |

#### Run 2 fixture and cleanup

Fixture project `974a1963-7c02-4a80-ae6a-71643e774085`; native project `prj_6ab72ff3edbd357d`; directory `/tmp/paseo-kanban-card-links-run2-ed86d3bc`. Cards: A `9651229b-afec-4beb-b412-adebdf5e4dfd` / `wks_a00484a672961406`; B `ff845efb-27e7-4711-a770-df9bbb04dfc3` / `wks_d867ddf85b6f3626`; C `4aa5e3a3-a80d-40a9-a9c5-e389467e6c29` / `wks_f428e9f5e1d5fdc4`; follow-up card `353a0c17-8868-4ccf-81bd-51daf77a8916` / `wks_f4ef446af653d0ed` (permanently deleted). The Luna session above is archived.

Cleanup PASS: `projects.remove` with `alsoPaseo: true` removed the fixture project and all remaining cards/workspaces. The temporary git directory was deleted. Both the plugin board and native Paseo project registry report no fixture project/cards/links. [Cleanup evidence](fixtures/card-links/cleanup-run2-evidence.json). Project removal backup left in place at `/Users/bofan.wang/.paseo/plugin-data/paseo-ultra-kanban/removed/974a1963-7c02-4a80-ae6a-71643e774085-2026-10-16T01-56-56-332Z.json`.

#### Fix after Run 2

The check 2 FAIL is fixed: `client/link-rows.ts` `linkCandidates` now marks a card as Linked exactly when the server would refuse it — for Related, any link between the two cards; for Blocks / Blocked by / Follow-up of, a link of that kind in either direction. Covered by `client/link-rows.test.ts` (B Blocks C → C's Related and Blocked by lists show B as Linked). PASS: typecheck; `npm test` 338 passed / 63 skipped; plugin reloaded. Not re-run in the browser.
