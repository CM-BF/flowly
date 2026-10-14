# Phase 1 acceptance report

Date: 2026-10-13 (Asia/Singapore)  
Current revised result: **Focused Phase 1 behavior and final code checks pass; revised compact UI capture remains blocked.** Revised live UI/session/RPC coverage is recorded below, including default all-repo scope, cross-repo writes, secondary native-owner workspace linking, repo edit guard, and focused negative cases. `npm run typecheck` passed and `npm test` passed **21/21** after making the test-only migration fixture repeatable. Do not treat the earlier 12-test result or its unrun checklist as current status. The prior same-directory duplicate remains unattributed. No Phase 2 work was started.

Compact revised light/dark form and drawer captures remain outstanding. CUA `cua.getApp('Paseo')` fails with `Computer Use server error -10005: cgWindowNotFound`; earlier drag actions did not produce a verifiable resized window. System Events geometry access was denied with `osascript is not allowed assistive access (-1719)`, and no broader permission was requested. The documented CUA native API has no resize method, so revised compact UI is not marked passed. Window-menu items could not be inspected because CUA could not retrieve the Paseo window accessibility tree.

## Historical report — earlier single-repository scope

The following session details, 12-test result, check table, and unrun list record the earlier acceptance cycle only. The revised addendum and final closeout below supersede its status and checklist.

### Historical test session and safety boundary

- Paseo acceptance session: `8c65c2a2-960b-4d0b-b9b8-782a8bc29029`, provider/model `codex/gpt-6-luna`, workspace `wks_1b4e2fc48dd38d30`. `paseo inspect` confirms Luna 6 and no pending permissions. It is a child of implementation session `af65956b-64e6-4491-86e8-7fe95ebd1a52`.
- Additional Luna runtime used for the actual card sessions: `afe9ac0c-ab19-497a-be07-e555459ea1ac` and `89104f06-1934-41c5-95f9-a73360566da3`, both `codex/gpt-6-luna`, both idle after their turns.
- All project/workspace/card validation used disposable resources under `/tmp/ultra-kanban-acceptance-20261013` and the dedicated plugin ID `paseo-ultra-kanban`. Existing `paseo-kanban`, user projects and unrelated workspaces were not modified. The Paseo daemon was not restarted; the plugin was reloaded through its plugin command.
- Test work was limited to `docs/verification/`; implementation files were not changed by this test session.

### Historical completed checks

| Check | Result | Evidence |
|---|---|---|
| Required checks on current HEAD | **Pass** — `npm run typecheck`; `npm test` (2 files, 12 tests) | Test command output in this session; current implementation tests include store/resource routing, association/revision protection, retry keys and default branch resolution. |
| Two repositories mapped to one native Paseo project | **Pass** — fixture board has exactly repo-one and repo-two; its one native project is `prj_8859e85f82a61739` rooted at repo-one | `fixtures/acceptance-cli-evidence.txt` |
| Directory workspace card | **Pass** — card source repo-one; workspace `wks_03edb11a97acb9c6`, path `/private/tmp/ultra-kanban-acceptance-20261013/repo-one`, native project display `repo-one` | CLI evidence; `fixtures/wide-light-2sessions.png` |
| Worktree from repo-two | **Pass** — original worktree card uses repo-two source path, distinct branch `ultra-kanban/acceptance-repo-two`; worktree is registered under the same native project | CLI evidence |
| Existing workspace link | **Pass** — linked unbound fixture workspace `wks_3bc59e6341a37b37` at `/tmp/ultra-kanban-acceptance-20261013/repo-two`; it remains under native project repo-one | CLI evidence |
| Default Base ref after HEAD fix | **Pass** — new task form displayed `Base ref (optional)` with current-branch placeholder; field was left untouched/empty. New independent repo-two card ID `330d653a-7035-45bf-84dd-bdf26e7d3ea4` created workspace `wks_88fa464b23f8a27d` at `/Users/bofan.wang/.paseo/worktrees/2wp43niw/ultra-kanban-acceptance-repo-two-default-20261013`, branch `ultra-kanban/acceptance-repo-two-default-20261013`. `git symbolic-ref --quiet HEAD` on source resolves `refs/heads/main`; worktree HEAD matches source HEAD `1b16710baa85d0e18a7f653e564612832d4fb191`. | CLI evidence; current form/card was also visible in the live Paseo board. |
| Two sessions on one card workspace | **Pass** — both Luna sessions use cwd `/private/tmp/ultra-kanban-acceptance-20261013/repo-one`. The card UI showed 2 sessions, output for each, selected-session detail, and follow-up field. | `fixtures/wide-light-2sessions.png`, `fixtures/compact-light-drawer.png`; session IDs above |
| Follow-up instruction is delivered and actually answered | **Pass** — instruction to session `afe9ac0c-ab19-497a-be07-e555459ea1ac`: `Follow-up acceptance check: reply exactly ULTRA-KANBAN-FOLLOW-UP-DELIVERED. Do not edit or create any files.` The selected session output visibly returned `ULTRA-KANBAN-FOLLOW-UP-DELIVERED`. Session two separately returned `ULTRA-KANBAN-SESSION-TWO`. | `fixtures/wide-light-2sessions.png`; live session output captured in the Paseo UI. |
| Business status independent of session turns | **Pass** — after turns ended, the card remained Todo (`status: todo`) while the drawer showed both sessions idle and recorded turn lifecycle events. | filtered plugin JSON in CLI evidence; screenshot |
| Duplicate native project link | **Pass** — attempting to add the already linked fixture native project was rejected with “Paseo project is already linked; open or restore its board project.” No duplicate board/native project record was created. | Direct Paseo UI observation |
| Occupied workspace selection | **Pass** — a workspace already bound to a card appeared disabled with an “already bound” reason; the unbound existing fixture workspace remained selectable. | Direct Paseo UI observation |
| Card archive/restore | **Pass** — archive reduced active count, drawer offered Restore task, restoring returned the card; workspace and sessions remained. | `fixtures/acceptance-cli-evidence.txt` lifecycle state; live UI |
| Board archive/restore | **Pass** — archived board disappeared from active list, appeared under Show archived with its cards retained, and restored to active with cards intact. | Live UI; project JSON currently has `archivedAt: null` |
| Plugin reload persistence | **Pass** — `paseo plugin reload paseo-ultra-kanban` and logs showed stop/load/store-ready; the board returned with its card count and repository labels intact. No daemon restart. | `paseo plugin logs paseo-ultra-kanban`; current board JSON |
| Light/dark and wide/compact visual check | **Pass, with window restore note below** — light/system wide screenshots and a real `1102×1290` compact window were captured. At compact width the board remained horizontally navigable and task detail was shown in a single-column full-width pane with Back/Close controls. Dark appearance was visibly checked at wide width. | `fixtures/wide-light-kanban.png`, `fixtures/wide-system-drawer.png`, `fixtures/compact-light-board.png`, `fixtures/compact-light-drawer.png`, `fixtures/wide-dark-2sessions.png`, `fixtures/dark-wide-after-reload.png` |

### Historical failed checks and resolved integration finding

- **Resolved before this final run:** the old form prefilled Base ref with literal `HEAD`; Paseo rejected the worktree request with `Base branch cannot be HEAD when creating a Paseo worktree`. Supplying `main` in that first run worked. The implementation was then updated to default the optional input to empty and resolve the selected source repo's symbolic HEAD. The fresh-form blank-default retest above passed without supplying a ref. The original failure is retained here as a real finding, not a current failure.
- **Duplicate directory workspace observation, cause unknown:** two native directory workspaces with the same test name and repo-one path exist (`wks_03edb11a97acb9c6` and `wks_38692b1890571f2f`), while one board card is bound to the first. This appeared during earlier CUA interaction when element IDs had become stale. The sequence cannot establish whether a second provision was caused by UI retries or service behavior. It is deliberately not attributed to a product double-create defect or declared harmless. The duplicate is preserved as test evidence and no deletion/archive was attempted.

### Historical unrun / partial checks

- Detached-HEAD and non-Git source errors were **not exercised live**. This run does not claim that the actionable error appears before provisioning in Paseo. The code/unit coverage and UI behavior need a dedicated live negative case.
- Same-operation-ID retry was **not exercised against the live plugin service**. The form creates a fresh operation ID and offers no fixed-ID control. Unit coverage exists for idempotency, but it does not resolve the duplicate directory workspace observation. A controlled live retry with one fixed operation ID remains required if an invocation path can supply it.
- Incompatible/missing workspace rejection was not manually induced. Occupied workspace rejection/disable behavior was verified in the form; native project duplicate rejection was manually verified.
- UI-level stale revision conflict with two competing forms, edits, cross-column move, reorder, and composed search/filter behavior were not completed in this acceptance pass. Revision/concurrency behavior is covered by focused tests, not by live competing UI clients.
- The exact pre-test window geometry was `2056×1290` at the initial observation. After compact testing, Paseo was returned to its largest normal desktop window (`1980×1290` at `+76+39`) and theme `System`; this is the closest available window state but not pixel-identical geometry. No theme/appearance preference other than temporarily switching System→Dark→System was left changed.

## Historical fixture evidence files

- `fixtures/acceptance-cli-evidence.txt` — filtered board, native project, relevant workspaces, selected source symbolic HEAD, worktree branch/path/commit.
- `fixtures/wide-light-kanban.png`, `fixtures/wide-light-2sessions.png`, `fixtures/wide-system-drawer.png` — real Paseo wide UI.
- `fixtures/compact-light-board.png`, `fixtures/compact-light-drawer.png` — real Paseo compact UI at 1102×1290.
- `fixtures/wide-dark-2sessions.png`, `fixtures/dark-wide-after-reload.png` — real Paseo dark appearance.

---

# Revised acceptance addendum — 2026-10-13, final reload baseline 13:06

This addendum retains the preceding report as historical evidence for the
earlier single-repository card interpretation. The revised current Phase 1
spec is the acceptance authority for this section. Source was reported stable
since the 13:06 plugin reload; this test session did not edit implementation
or spec files and did not restart the daemon.

## Session and fixture boundary

- Revised acceptance session: `6c18d210-afa6-4b36-9550-60301a87767c`,
  `codex/gpt-6-luna`, full-access mode, idle with no pending permissions when
  inspected. The session was created from Paseo UI in workspace
  `wks_9971e291bf5ff148`, CWD
  `/private/tmp/ultra-kanban-acceptance-20261013/repo-one`. Full-access is the
  provider's permission mode; it is not a hard filesystem sandbox. Instructions
  and observed writes were confined to the explicitly named fixture paths.
- Disposable fixture root:
  `/private/tmp/ultra-kanban-acceptance-20261013`. Primary board
  `00aebed7-d778-4a5b-ba01-94b63eaa5196` maps repo-one and repo-two to native
  Paseo project `prj_8859e85f82a61739`. Secondary repo native project
  `prj_959652485680186c` owns repo-two workspaces used for compatible links.
- Paseo UI appearance was returned to `System` before handoff. The window
  remains at its largest observed desktop size; exact pre-test geometry was
  not restored in this run.

## Revised checks completed

| Check | Result | Evidence |
|---|---|---|
| New card default scope | **Pass, live UI** — create form opened with no repo selected and stated `All project repositories · default`; workspace startup repository was separately shown as repo-one. Card `fa8ba46a-ac0a-44bd-a2e1-2f95dfa5d743` persisted `repoPaths=[]` at creation. | `fixtures/revised-wide-system-create-form.png`; `fixtures/revised-scope-session-evidence.txt` |
| Edit to one repo, multiple repos, and clear | **Pass, live UI** — an existing card was set to repo-two only, then repo-one + repo-two, then cleared to all. Save/drawer confirmed all-repo scope; workspace path/source and both existing sessions stayed unchanged. The revised marker card was also changed from unrestricted to repo-two only without changing source repo-one or workspace/session IDs. | `fixtures/revised-wide-system-scoped-drawer.png`; live Paseo UI observations |
| Repo filter membership and composition | **Pass, live UI** — unrestricted cards appeared under both repo filters. Search + High priority + repo-two matched the scoped marker card; same search + High + repo-one returned no match. Clearing search/priority then selecting repo-one/repo-two included unrestricted cards in both results. | Live Paseo UI observation; current board filter state returned to All repositories |
| Unrestricted task writes in both repos | **Pass, actual Luna follow-up** — selected card session wrote one exact marker in each fixture repo under default all scope. After changing scope to repo-two only, its next instruction created a marker only in repo-two; the repo-one counterpart was absent. Logs showed repo-two as the sole work directory and repo-one separately as workspace starting directory. | `fixtures/revised-scope-session-evidence.txt`; live Paseo session `6c18d210-afa6-4b36-9550-60301a87767c` |
| Link a workspace owned by repo-two's own native project | **Pass, live UI** — an existing directory workspace at `/tmp/ultra-kanban-acceptance-20261013/repo-two` was eligible and linked; drawer identified workspace repository and native owner as repo-two. | Live Paseo UI; board card `Ultra Kanban Acceptance: secondary repo native owner link` |
| Link an external managed worktree | **Pass, live UI** — repo-two's external worktree under `/Users/bofan.wang/.paseo/worktrees/...` was eligible based on actual Git repository identity; drawer displayed the checkout path, repo-two membership, and preserved native owner repo-two. | `fixtures/revised-wide-system-external-owner-drawer.png`; `fixtures/revised-wide-dark-external-owner-drawer.png` |
| Live same-operation-ID retry | **Pass, live RPC** — three invocations with fixed operation ID returned the same card and workspace, creating exactly one card and one workspace (`7/30` → `8/31`). This is controlled request evidence only; it does not attribute the older duplicate. | `fixtures/revised-live-rpc.mjs`; `fixtures/revised-rpc-evidence.txt` |
| Outside-repo and missing workspace | **Pass, live RPC** — both rejected with `Workspace is unavailable or outside this project's repositories.` before commit; card/workspace counts stayed `8/31`. Rejection is based on project repo identity, not native owner identity. | `fixtures/revised-rpc-evidence.txt` |
| Non-default named branch default base | **Pass, live RPC** — isolated source branch `acceptance/non-default-base` with empty base ref produced the expected worktree branch and identical source/worktree commit. The main repo-one/repo-two branches were not changed. | `fixtures/revised-rpc-evidence.txt`; edge fixture board `8983634a-5b2e-4b2b-b41d-d72136da801a` |
| Detached and non-Git pre-provision errors | **Pass, live RPC** — both returned actionable named-branch guidance before provisioning; edge board counts remained unchanged and its original repo list was restored. | `fixtures/revised-rpc-evidence.txt`; test-only script assertions |
| Competing UI draft versus RPC revision | **Pass, live UI + RPC** — while the UI form held an unsaved title/repo-scope draft at revision 1, RPC updated the card to revision 2. Saving the stale form displayed `Revision conflict: this card changed. Reload before saving your draft.`; the title and selection remained in the form until canceled. | Direct live UI observation; card `6a69cddf-f193-4635-8a0b-12fe7b17387f` |
| Move and reorder | **Pass, live UI** — external-worktree card moved Todo → In progress → Todo; Up/Down changed its position relative to the secondary native workspace, then returned it to its original order. | Direct live UI observation; same marked card/workspace retained |
| v1 migration | **Pass, full suite** — legacy card read as v2 unrestricted (`repoPaths=[]`), IDs/source/events survived, read did not rewrite v1 bytes, and first mutation persisted v2 with exact v1 backup. Test-only fixture now uses a fresh temp directory for each run. | `fixtures/revised-migration.test.ts`; historical `fixtures/migration-v1-data/board.json.bak`; `fixtures/revised-full-test-output.txt` |
| Project repo edit guard | **Pass, live RPC** — attempted removal of repo-two was rejected because fixture cards use it as source and explicit scope; project revision/repo list, all card fields relevant to association/scope, and bound workspace IDs/paths/owners were identical before and after. Then an isolated dummy Git repo was added and removed; an unrestricted card's `tasks.context` included it while present and omitted it after removal. Original repo-one/repo-two entries were never removed. | `fixtures/revised-project-repo-guard.mjs`; `fixtures/revised-project-repo-guard-output.json` |

## UI capture boundary and unrun items

- **Wide revised UI:** System/light create and scoped/external-owner drawers are
  captured in `revised-wide-system-*.png`; Dark create and external-owner
  drawer are captured in `revised-wide-dark-*.png`.
- **Compact revised UI: not captured.** A CUA window drag first returned
  `Computer Use server error -10005: windowNotFoundAtPosition((2160.0, 739.0))`;
  a logical-coordinate drag did not change the window bounds, and the lower
  right-edge attempt returned
  `windowNotFoundAtPosition((2165.0, 1434.0))`. Final closeout calls to
  `cua.getApp('Paseo')` returned `Computer Use server error -10005:
  cgWindowNotFound`, so no accessible Window menu was available to inspect.
  System Events returned `osascript is not allowed assistive access (-1719)`;
  no permission escalation was requested. Existing compact light images
  in the historical section predate revised repo scope and do not prove the
  revised form/drawer at compact width. No revised compact dark/light pass is
  claimed.
- **Final checks, 2026-10-13 13:37:** `npm run typecheck` passed. First `npm
  test` attempt had 20 passed and 1 failed because the test-only migration
  fixture refused to overwrite its retained `.bak` file. The fixture was made
  repeatable using a fresh OS temp directory for each run; the subsequent full
  `npm test` passed **21 tests in 4 files**. The first failure and final raw
  output are both retained. No implementation or spec code changed.
- Archive/reload lifecycle and other unaffected earlier workflows remain
  documented in the historical report rather than repeated here.
- The prior same-directory duplicate (`wks_03edb11a97acb9c6` and
  `wks_38692b1890571f2f`) remains **unattributed**. It was preserved; no
  existing resource was deleted or archived. The fixed-ID retry above neither
  explains nor retroactively proves the cause of that observation.
- No Phase 2 work was started. Phase 1 is presented for user acceptance with
  the compact revised UI capture explicitly outstanding.

## Revised evidence files

- `fixtures/revised-scope-session-evidence.txt` — model/session metadata,
  routed follow-up context, marker contents and hashes.
- `fixtures/revised-rpc-evidence.txt` — fixed-ID retry, repo identity negatives,
  named-branch default and detached/non-Git provision counts.
- `fixtures/revised-live-rpc.mjs` — isolated test-only SDK RPC harness; do not
  rerun unchanged because its fixed IDs already committed.
- `fixtures/revised-project-repo-guard.mjs` and
  `fixtures/revised-project-repo-guard-output.json` — live source/scope removal
  guard and unrestricted repo-list propagation.
- `fixtures/revised-typecheck-output.txt`,
  `fixtures/revised-full-test-output.txt`, and
  `fixtures/revised-full-test-initial-failure.txt` — final check output and the
  resolved evidence-fixture failure.
- `fixtures/revised-migration.test.ts` and `fixtures/migration-v1-data/` — v1
  migration/backup evidence.
- `fixtures/revised-wide-system-create-form.png`,
  `fixtures/revised-wide-system-scoped-drawer.png`,
  `fixtures/revised-wide-system-external-owner-drawer.png`,
  `fixtures/revised-wide-dark-create-form.png`, and
  `fixtures/revised-wide-dark-external-owner-drawer.png` — revised wide UI.
- `fixtures/revised-compact-ui-blocker.txt` — CUA errors, System Events denial,
  missing original geometry read, and the precise unrun compact boundary.


