# Next moves in the delivery call — live verification (2026-10-20)

Spec: [NEXT-MOVES-SPEC §8](../NEXT-MOVES-SPEC.md). Card `4297bbee` ("Next moves in the delivery call"). Implementation session `bd191c80` (Claude Sonnet 5.5).
Test sessions: two `codex/gpt-6-luna` sessions, mode `full-access`, thinking `medium`, created the way the Flowly UI creates a card session (`tools.prepare-session` + `agents.create`, label `flowly-task`, `FLOWLY_*` env). Model availability was checked with `list_models` first; no substitution.

Build under test: working tree on `main` at `39fb511` plus uncommitted changes (this card's and other cards'). The plugin runs from the repository directory.

## Setup

- `npm run typecheck`: clean, before the reload.
- `paseo plugin install "$PWD" --id flowly`: `Plugin ID "flowly" is already configured`. The plugin is a local-path install of this directory, so there was nothing to install.
- `paseo plugin reload flowly`: log shows `Stopping plugin` → `Plugin ready` (03:01:32 → 03:01:35 UTC), store ready, `project folders: 0 written, 4 current, 0 failed`.
- The reload rewrote the runtime files in `~/.paseo/plugin-data/flowly/`: `flowly.mjs` now mentions `no-moves`, and `SKILL.md` is byte-identical to `skills/flowly/SKILL.md`.
- Fixture: the permanent **Tinylink** project, which was left as it was. One temporary card `b827d662…` (workspace `wks_7c4867ac1a075047`, `tasks.create`, mode `directory`) with two sessions:
  - **S1** `991f26a9…`, started with the `flowly` MCP server.
  - **S2** `43f91c69…`, prepared the same way but **without** the MCP server, so the CLI is its only way in.
- Both prompts forbade editing files. The Tinylink repo had `HEAD 47899f7` and a clean tree before and after.

## PASS

| # | Step | Result |
|---|---|---|
| 1 | S1, MCP: `flowly_update_status` `in_review` with `nextMoves` = Run the tests, Commit and push, Move to Done (`moveTo: done`) | Accepted. Board: `status_changed` test→in_review and `next_moves_suggested` (3 moves) at the **same millisecond**, 03:04:24.755. The session view shows the three chips above the composer, Move to Done with the check icon (`chips-s1-session.png`). S1's tool calls were `flowly.flowly_get_task` / `flowly.flowly_update_status` only. |
| 2 | S2, CLI only: `status in_review --moves '[…]'` | Accepted. Same pair at 03:05:00.226. Two chips (`chips-s2-session.png`). S2's activity has only `[Shell]` calls and no `flowly.*` tool call. |
| 3 | S1, MCP: `flowly_report_progress` kind `result` with `nextMoves: []` | `progress_reported` and `next_moves_suggested` with `moves: []`, note `No next steps needed`, at 03:09:00.028. The chips are gone: `session-next-moves` row count 0 (`none-s1-session.png`). |
| 4 | S2, CLI: `note --kind result --no-moves` | Same pair at 03:09:20.913. No chips (`none-s2-session.png`). |
| 5 | Activity in the card drawer | 11 entries. The text "suggested no next moves" appears in **2** rows, one per explicit none; S1's is visible in `none-activity.png`, S2's is just above the crop. The non-empty suggestions add no row: only the status changes ("Verification delivery A/B") show. |
| 6 | Done guard, live (S2, CLI): `status development --moves '[{"label":"Move to Done","moveTo":"done"}]'` | Refused with `INVALID_INPUT`: `A moveTo="done" move is only offered together with a delivery to In review (status in_review). Leave it out, or deliver first.` Nothing was written: no event between S2's turn start (03:09:06) and its next report (03:09:20), and the card status did not change. |

Evidence: `events.json` (the card's agent and system events, exported before cleanup) and the five screenshots in `next-moves-delivery/` (plus `chips-drawer.png`, the drawer with both sessions). Screenshots are headless Chromium at 1700×1000, clipped to the plugin panel; they show only the Tinylink fixture.

Also seen, existing behavior and not part of this change: when a new message started a turn on an In review card, rule A1 moved it to Development (03:04:38 for S2, 03:08:45 for S1).

## Not verified

- **Phone / compact layout.** Only one desktop size was checked. The chip row is unchanged code, but nobody looked at it on a phone for this change.
- **The standalone `flowly_suggest_next_moves` call, including `[]` through it.** Covered by unit tests only; the live run used the new fields on `update_status` / `report_progress`.
- **Languages other than English** for "Suggested no next moves": the i18n test only.
- **Coverage after rollout** (the 90% target): needs real use first. Baseline 56 of 101 delivery, question and result turns (about 55%).

## Observations

- Sessions that were already running keep their old tool list. This implementation session, started before the reload, still listed `flowly_suggest_next_moves` with the old schema afterwards. S1 and S2 were created after the reload and saw the new fields, as NEXT-MOVES-SPEC §8.8 says.
- Luna S2 answered its first turn in Chinese although the prompt was English. The CLI output was unaffected.
- The plugin's auto-summary started a hidden Haiku summarizer after each turn (4 in total); all four archived themselves.

## Incidents

- One headless screenshot was taken of the Paseo host's **History** page, because the text "History" in my click matched the host sidebar item and not the drawer's section. It listed my real session titles. I deleted the file at once; nothing was committed. Every screenshot I kept was checked by eye first and shows only the Tinylink board and the plugin panel. The exploratory full-window screenshots (with the host sidebar) were only ever in `/tmp` and are deleted.
- The first capture of S2's session view timed out once; the rerun worked.

## Cleanup (verified in both places)

- `tasks.delete-check`: no blockers, no warnings. `tasks.delete` with `archive: true`: the card is deleted, 2 sessions and the card's own workspace archived.
- **Plugin board:** Tinylink is back to its 6 original cards with the same IDs and statuses as before the run.
- **Native Paseo:** `wks_7c4867ac1a075047` is no longer listed; Tinylink's 5 other workspaces are still there. S1 and S2 are archived (`closed`, `archivedAt` 03:13:03). The 4 summarizer sessions of the card were archived by the plugin right after their turns (03:04:38, 03:05:12, 03:09:11, 03:09:33). The 3 Haiku sessions and the 3 earlier summarizer sessions of the permanent fixture are unchanged.
- Left in place on purpose: the plugin's own recovery backup of the deleted card, `~/.paseo/plugin-data/flowly/removed/task-b827d662-ea67-44d1-88b6-b884afb3522d-2026-10-20T03-13-05-761Z.json`. It is the product's safety copy, not a fixture; delete it by hand if you do not want it.
- Removed: the helper scripts and the `playwright-core` install I used (they lived in `/tmp`, outside the repository), S2's `/tmp/nm-s2-snap.json`, and the headless Chromium processes.

## How to repeat

Create a card in Tinylink (`tasks.create`, mode `directory`), then two sessions with `tools.prepare-session` + `agents.create` (`provider: codex/gpt-6-luna`, `modeId: full-access`, label `flowly-task`; one with `mcpServers: { flowly: preparation.mcp }`, one without). Ask each to deliver with `nextMoves` and later with `[]` / `--no-moves`, read `board.read` events for the card, then `tasks.delete` with `archive: true` and check `list_workspaces` / `list_agents`.
