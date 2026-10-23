# Card comments, Full access precedence and fallback settings: live verification

Date: 2026-10-23 (local). Host `srv_BSheQn5lzdEE`, Paseo `0.12.0`, `127.0.0.1:6767`. Real `https://app.paseo.sh` with headless local Chrome; screenshots through `docs/promo/shot-lib.mjs` (host sidebar and other projects excluded).

## Installation

The owner decided installs need not wait for their own pipeline to go idle: Flowly must survive a reload. The live jobs were compared before and after each update, and the one live job (the owner's C5, waiting on a question) came through every reload unchanged. No daemon restart was needed.

| Revision | Content | Backup |
| --- | --- | --- |
| `6b0d367` | PR #1 | `~/.paseo/backups/flowly-2026-10-23-before-6b0d367/` |
| `8f7793a` | PR #2: capacity limits, sub-cards a person is running, recovery of missed turn ends | `~/.paseo/backups/flowly-2026-10-23-before-8f7793a/` |
| `52ca423` | PR #3: patient retries for host hiccups | `~/.paseo/backups/flowly-2026-10-23-before-52ca423/` |

The tests below ran on `52ca423`, apart from the first run of the card, which predates PR #3 (see scenario 4).

## Fixture

Project `916a51e3-60ca-4a02-a8e2-c68b2d91aab7`, native `prj_10a0d3b60e101342`, title `plugin-test-2026-10-23-comments`, git root `/Users/citrine/Projects/plugin-test-flowly-comments`.

Cards:
- `6404e832` "Add and commit NOTE.txt": automated, worktree `wks_35cdc865791f2bd2`.
- `496308bd` "Parked comments fixture": agent off.

Sessions:
- Implementer `c8471ffe`.
- Reviewer `8e5c5045`.
- Reviewer preparation `ced67cd7`, never created (see scenario 4).

Project settings, saved through the UI:
- Default model: Codex GPT-6-Luna, low reasoning, Permissions **Default Permissions** (`auto`), Normal speed.
- Automation on, Full access on, implementer unset (so it uses the project default).
- Implementer fallback: GPT-6-Astra.
- Reviewer: GPT-6-Luna, low reasoning.
- Reviewer fallback: GPT-6-Astra.

## Results

| # | Scenario | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Fallback pickers in Edit project | PASS. *Implementer fallback* and *Reviewer fallback* (the latter shown once a reviewer is set) saved; the board stored `implementerFallback` / `reviewerFallback` exactly. | `card-comments/01-settings-fallbacks.png` |
| 2 | Full access beats a project default that asks for approvals | PASS. The implementer inherited the project default (Luna, low) and ran in `full-access`. | Daemon snapshot |
| 3 | Automation sessions opt out of the rate-fallback plugin | PASS. The implementer's labels were `flowly-task`, `flowly-automation=implementer` and `paseo-rate-fallback=off`. | Daemon snapshot |
| 4 | A host hiccup during session creation (owner's `next-workspace` plugin: "Plugin next-workspace before agent.create failed: Plugin RPC timed out") | Before PR #3 (`8f7793a`): the implementer was created on the retry and delivered, but the reviewer was refused twice, so the review gave up after 30 s (`delivered`/`incomplete`). After PR #3 (`52ca423`): the next refusal was retried a minute later ("Could not reach the reviewer session (host, 1 of 5); retrying in 1 min"), and the reviewer was created and approved. | Activity |
| 5 | Comment requesting a change on a delivered card | PASS. The comment was saved as a human `commented` event and sent to the implementer, which received the exact text. A1 moved the card to Development and the job reopened. The agent read `get_task`, updated its workpad, committed `a139c62` and delivered. A new review cycle (round 1 of 3) approved it. | `card-comments/02-comment-change-request.png`, `04-comments-desktop.png` |
| 6 | Question comment on the approved card | PASS. The agent answered in one sentence ("Commit `a139c626f3ca` … added the second line") and changed nothing. A1r restored In review, and the job settled as delivered with the approval kept, without a new review round. | `04-comments-desktop.png` |
| 7 | Comment on a card without a session | PASS. Saved only. The hint read "No agent session on this card yet: the comment is saved, and an agent reads it when one starts.", with Start session offered. No agent was started. | `card-comments/03-comment-no-session.png` |
| 8 | Phone width (430 px) | PASS. The Comments section showed both comments, the To: line and the composer. The board shows one lane at a time; the In review chip switches to it. | `card-comments/05-comments-compact.png` |
| 9 | One-time tip | Shown on the board: "Ask about progress or request changes right on the card: comments are saved here and sent to the card's agent." | `04-comments-desktop.png` |

## Not verified

- **A real provider-limit switch to a fallback model.** A limit cannot be triggered on demand. The switch is covered by `server/automation-fallback.test.ts` and `shared/automation-fallback.test.ts`. Only the settings and labels it depends on were checked live.
- **Physical Android.**
- **The progress summary on the fixture card.** It also failed on the same `next-workspace` hook timeout ("Last update failed …"). That is the other plugin's problem; this pass did not change the summarizer.

## Cleanup

- Both cards were deleted through the UI with Archive and delete.
- The project was removed with "Remove from board and Paseo".
- Both created sessions are archived (`closed`); `ced67cd7` never existed.
- The worktree folder `~/.paseo/worktrees/0rqxpku9` and the fixture repo were deleted, along with this test's 10 exact-owned `removed/` and `preparations/` files.
- No native project that existed before the test is gone. Three native projects were added during it under `.fixtures/plugin-test-next-workspace/owned/`; they belong to the owner's pipeline (C5b.2 runtime tests) and were left alone.
