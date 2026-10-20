# Delivery-time reminders: live verification (2026-10-20)

Spec: [NEXT-MOVES-SPEC §9](../NEXT-MOVES-SPEC.md), [IDEAS-SPEC §4.1](../IDEAS-SPEC.md). Card `363821a3` ("Delivery-time reminders for missing next moves and ideas, plus firmer skill wording"). Implementation session `a938115a` (Claude Sonnet 5.5).

Test sessions: five `codex/gpt-6-luna` sessions, mode `full-access` (set at creation), thinking `medium`, created the way the Flowly UI creates a card session (`tools.prepare-session` + `agents.create`, label `flowly-task`, `FLOWLY_*` env). Model availability was checked with `list_models` first; no substitution. The prompts forbade file edits, workpads and starting other agents.

Build under test: commit `3d0a67c` on `main` (pushed) with other cards' uncommitted files in the working tree. The plugin runs from the repository directory and was reloaded (`paseo plugin reload flowly`) from this tree before the run; the reminder code is the committed one.

## Setup

- Fixture: the permanent **Tinylink** project, left as it was. One temporary card `2263ed10…` (workspace `wks_8e3489f772502ce0`, `tasks.create`, mode `directory`) with five sessions, run one after another:

| Session | Id | Flowly access | Prompt, in short |
| --- | --- | --- | --- |
| S1 | `00560906…` | MCP configured, **CLI used** | deliver twice, "do NOT pass any next moves" |
| S2 | `1ac54164…` | MCP only | deliver twice, leave `nextMoves` out entirely, then end the turn |
| S3 | `66dc5721…` | MCP only | as S2, but "read that call's result and do whatever it asks you to do" |
| S4 | `5d8f03e3…` | CLI only (no MCP server) | as S3, leaving out both `--moves` and `--no-moves` |
| S5 | `5a7adaad…` | MCP only | neutral: deliver and end the turn, next moves not mentioned |

- Each did: read the card, stage `test`, `npm test` (13/13 passed), deliver to In review, deliver once more ("second delivery"), end the turn.
- Tinylink repo: `HEAD 47899f7`, clean before and after.

## Results

Every call below is taken from the sessions' own tool output (Codex rollout files), cross-checked against the card's events (`delivery-reminders/events.json`). Per-call summary: `delivery-reminders/calls.json`.

| # | Session | Delivery | The result carried | The session then |
| --- | --- | --- | --- | --- |
| 1 | S2 (MCP) | 1st, no `nextMoves` | `reminders`: next-moves text **and** ideas text, key order `receipt, replayed, reminders, current` | ended its turn; no suggestion, no idea |
| 2 | S2 (MCP) | 2nd, no `nextMoves` | the same two reminders | ended its turn |
| 3 | S3 (MCP) | 1st, no `nextMoves` | the same two reminders | looked up `flowly_suggest_next_moves` and called it with `moves: []` (event `next_moves_suggested`, "No next steps needed", 09:01:01) |
| 4 | S3 (MCP) | 2nd, no `nextMoves` | **only the ideas reminder**: the next-moves reminder is gone | ended its turn |
| 5 | S4 (CLI) | 1st, no flags | the two reminders, printed right after the receipt | ran `next-moves --moves '[]'` (event at 09:03:01) |
| 6 | S4 (CLI) | 2nd, no flags | **only the ideas reminder** | ended its turn |
| 7 | S1 (CLI) | 1st and 2nd | **only the ideas reminder** (twice): the session put `--no-moves` on both deliveries itself | ended its turn |
| 8 | S5 (MCP) | 1st (the only one) | **only the ideas reminder**: the session passed `nextMoves: []` on the delivery itself | ended its turn |

What this shows:

- **The reminder reaches a real session**, over MCP (`content` text and key order as in the unit test) and over the CLI (printed after the receipt), on `in_review` deliveries.
- **A session can act on it.** When allowed to (S3, S4) it made the call the reminder names, once with `[]` over MCP and once through the CLI, and the **next delivery no longer carried the next-moves reminder** (rows 4 and 6). The Activity of the card shows the pair `status_changed` / `progress_reported` followed by the suggestion event only where a suggestion was made.
- **An explicit none on the delivery call is enough:** S1 and S5 carried it themselves, and the result had no next-moves reminder (rows 7, 8).
- **The ideas reminder stays until an idea exists**, as designed (card-level): it appeared on every in_review delivery in all five sessions (9 deliveries), and no session proposed an idea (0 of 5; the card had nothing to follow up on).

## Not shown, or worse than hoped

- **Left alone, Luna did not act on the reminder.** S2 saw both reminders twice and ended its turn: its prompt said to leave next moves out and to end the turn, and a user's instruction wins over a line in a tool result. S3 and S4 acted only because their prompt allowed it. So these runs prove delivery and actionability, not a compliance rate; the rate on real work shows up in Insights, Agent habits.
- **The firmer skill text already changed the default.** With the neutral prompt (S5) and even against "do NOT pass any next moves" (S1), Luna put an explicit `[]` on the delivery call by itself, which the new rule ("every turn that delivers … ends with next moves; skip only when nothing needs the user") asks for. Whether that is the intended reading of "nothing needs the user" for a real card is for the user to judge; for this fixture card it was true.
- **S1 used the CLI although the MCP server was configured.** It followed the CLI line at the end of its instructions. Both paths print the same result.
- **The ideas reminder did not lead to any idea.** Expected here ("zero is fine; decide on purpose"), but this run cannot say whether it ever will on a card with real follow-ups.
- **Not covered:** the chips above the message box and the Activity rows in a real window (no UI step in this run; the sibling card covered them), phone layout, languages other than English (the reminders are agent-facing English), a `question`/`result` report live (unit tests only), a replay live (unit tests only).

## Observations

- Each new message on the In review card started a turn that moved it to Development (rule A1), as before; unrelated to this change.
- The plugin's auto-summary started a hidden Haiku summarizer after each of the five turns; all five archived themselves.
- Sessions that were created before the reload would still show the old tool schemas; the five test sessions were created after it and saw the new fields.

## Incidents

None. No screenshots were taken. The files Luna wrote itself were its request snapshots under `/tmp` (`flowly-2263ed10-*.json` from S1, `flowly-2263-*.json` from S4); they are removed.

## Cleanup (verified in both places)

- `tasks.delete-check`: no blockers, no warnings. `tasks.delete` with `archive: true`: the card is deleted, 5 sessions and the card's own workspace archived.
- **Plugin board:** Tinylink is back to its 6 original cards with the same ids, statuses and revisions as before the run; the temporary card has no events or ideas left.
- **Native Paseo:** `wks_8e3489f772502ce0` is no longer listed; Tinylink's 5 other workspaces are still there. S1 to S5 are archived (`closed`, `archivedAt` 09:05:13). The 5 summarizer sessions of the card archived themselves right after their turns. The 3 Haiku sessions of the permanent fixture are unchanged.
- Left in place on purpose: the plugin's recovery backup of the deleted card, `~/.paseo/plugin-data/flowly/removed/task-2263ed10-6a3c-41f0-a7b7-432a77d5bbbc-2026-10-20T09-05-18-170Z.json`. It is the product's safety copy, not a fixture; delete it by hand if you do not want it.
- Removed: the helper scripts and the `node_modules` link I used (in `/tmp/flowly-live-verify`, outside the repository) and Luna's `/tmp` snapshots.

## How to repeat

Create a card in Tinylink (`tasks.create`, mode `directory`), then sessions with `tools.prepare-session` + `agents.create` (`provider: codex/gpt-6-luna`, `modeId: full-access`, `thinkingOptionId: medium`, label `flowly-task`, env `FLOWLY_CONTEXT_FILE` / `FLOWLY_CLI` / `FLOWLY_SKILL`; `mcpServers: { flowly: preparation.mcp }` for the MCP ones). Ask for two deliveries without `nextMoves`; read `board.read` events for the card and the session's Codex rollout (`~/.codex/sessions/…`) for what each call returned. Finish with `tasks.delete` (`archive: true`) and check `list_workspaces` and `list_agents`.
