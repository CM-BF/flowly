# Panel review and the sub-card tree fixes: live verification

Date: 2026-10-24 (UTC; 2026-10-23 local).
Environment: host `srv_BSheQn5lzdEE`, Paseo `0.12.0`, `127.0.0.1:6767`. The UI is the real `https://app.paseo.sh` in headless local Chrome. Screenshots come from `docs/promo/shot-lib.mjs` and exclude the host sidebar and other projects.

## Installation

| Revision | Content | Backup |
| --- | --- | --- |
| `1e91268` | PR #5: motion climbs the card tree; no accept while a sub-card's automation is live | `~/.paseo/backups/flowly-2026-10-24-before-1e91268/` |
| `c84b68e` | PR #6: panel review | `~/.paseo/backups/flowly-2026-10-24-before-c84b68e/` |

Both were installed with `paseo plugin update flowly --ref <sha>`, without restarting the daemon. Before and after each update, I compared the live jobs: the owner's C5 (`waiting`/`sub_cards` after PR #5) and C5b.3 (`working`). They were identical.

## Sub-card tree fix on the owner's live board (PR #5)

Before the fix, C5 was on reminder 2 of 2 (from `no_delivery` nudges). Its sub-card C5b had a failed coordination job, and C5b's sub-card C5b.3 was working. Under `52ca423`, C5's next silent turn would have given up and moved the card to Blocked.

After installing `1e91268`, the owner's reply was posted as a card comment through the UI. C5's agent received it, and the turn it started ended silently. Flowly then recorded `automation_waiting` ("Waiting for 2 sub-cards"), left the job `waiting`/`sub_cards` with `nudges: 0`, and sent no reminder.

Before installing, I also ran the new `motionOf` on a copy of the live board. C5b moves because C5b.3 is working, so C5 moves. The person-driven main card also moves, but nothing above it depends on that. No other parent's wake changed.

## Panel review (PR #6)

Fixture:
- Project `289a38fd-bfad-4e40-a136-c1fa42888bd6`, native `prj_cea23d635fda2a42`, title `plugin-test-2026-10-24-panel`. Git root `/Users/citrine/Projects/plugin-test-flowly-panel` (directory workspace `wks_4ab8aefdbffd1413`).
- Card `bba54aab` "Add NOTE.txt".
- Sessions: implementer `de657113` (Codex GPT-6-Luna, low) and panel reviewer `d3aa8519` (Claude Haiku 4.5).

The project and card were created through the plugin RPC, as in `docs/promo/setup.mjs`. Everything below was done in the UI.

| # | Scenario | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Edit project → Agent automation → Reviewer section | PASS. Panel review offers Off, Every round and After 1, 2 or 3 rounds with changes, with its explanation. Panel reviewer and Reviewers in a panel appear while the panel is on. Review rounds go up to 5. | `panel-review/01-panel-settings.png` |
| 2 | Save, then reopen | PASS. The board stored `panelAfter: 0`, `panelReviewer: {claude, claude-haiku-4-5}` and `panelSize: 2`, and the reopened form shows them. | `panel-review/02-panel-settings-reopened.png` |
| 3 | Run with agent; delivery goes to a panel round | PASS. Activity recorded "Review round 1 of 3 (panel of 2 reviewers)". A new reviewer session "Panel review: Add NOTE.txt" started on `claude-haiku-4-5` in `bypassPermissions` (Full access), labelled as reviewer. The card showed "Panel review round 1 of 3", and the Sessions list showed both sessions with their models. | `panel-review/03-panel-round-running.png` |
| 4 | The panel runs in parallel | PASS. Haiku's transcript has two `Agent` calls in one assistant message (`msg_011CgLAg…`), both `requestShape: foreground`. Their focuses were "Review artifact: verify git diff and file content" and "Review execution: run checks and verify test claims". Results came back 3 s apart (01:08:26 and 01:08:29). The reviewer then ran its own checks and called `flowly_submit_review` in the same turn. | Claude transcript of `d3aa8519` (not committed) |
| 5 | Verdict | PASS. Approved: the job settled `delivered`/`approved`, the card stayed In review for the person, and its signal reads "Agent review passed · Panel review round 1 of 3". The panel round took about 75 s. | `panel-review/04-panel-approved.png` |
| 6 | Phone width (430 px) | PASS. The card shows the same automation block and panel round. | `panel-review/05-panel-compact.png` |

## Found during the run (not caused by these changes)

**Agents can mistype the signed request token.**
- **What happened:** the implementer (GPT-6-Luna, low reasoning) called Flowly tools from Codex's script `exec` tool and retyped the 419-character request token by hand. Its copies differed from the issued token, one by a dropped character (418 characters). Flowly answered `UNAUTHORIZED` ("Invalid Kanban connection or request signature"), and the agent reported a blocker.
- **How it was unblocked:** a card comment told it to reuse the parsed `get_task` result instead of retyping. It then finished the card.
- **How rare it is:** only one earlier Codex session in the owner's history (2026-10-22) shows the same error.
- **Proposed fix (not done):** shorter request tokens. The session identity is already known from the MCP connection, so it need not be inside the token.

## Not verified

- **Panel escalation after rounds that requested changes** (`panelAfter` 1–3, the default 2): this run used Every round. The escalation, the separate panel-model session, the swap back to serial rounds, limits on the panel model and the reviewer history are covered by `server/automation-panel.test.ts`.
- **A Codex reviewer without subagents** reviewing each focus in turn.
- **`REVIEW_RUNNING` / `CHILD_BUSY` on a live parent:** covered by `server/sub-cards-round2.test.ts`.
- **Physical Android.**

## Cleanup

- The card was deleted with "Delete permanently", choosing Archive for its Paseo sessions and workspace. Both sessions are archived.
- The project was removed with "Also remove from Paseo". The native project and workspace are gone, and neither UI lists the project.
- I deleted this test's six exact-owned files in the plugin data folder: four `removed/` copies and two `preparations/` files, the latter checked to belong to `de657113` and `d3aa8519`. I also deleted the fixture repository.
