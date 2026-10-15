# Ideas feature acceptance

**Date:** 2026-10-16 (Asia/Singapore)  
**Plugin:** `paseo-ultra-kanban`, already installed and reloaded  
**Test session:** `c8e2e1b0-3137-4a05-8a96-f430f0008b60` (`codex/gpt-6-luna`, full access)  
**Luna worker session:** `623f6398-0189-453f-bf2a-7ba85e48a0ed` (`codex/gpt-6-luna`, `modeId: full-access` set at creation)  
**Harness:** [live.mjs](fixtures/ideas/live.mjs)  
**Raw evidence:** [evidence.json](fixtures/ideas/evidence.json)

## Fixture IDs

| Resource | ID / path |
| --- | --- |
| Temporary fixture directory | `/var/folders/0b/f1crzdg95g5fwbq49s_3pw9c0000gq/T/paseo-ultra-kanban-ideas-yz4Sf8` (removed) |
| Plugin project | `9b13849f-b7c6-435f-a371-75ddd1767d03` |
| Native Paseo project | `prj_28902287f9d73f10` |
| Source card A | `8d5ff548-7d0a-473b-9d0f-42d07e34b5c9` |
| Source workspace | `wks_fb9fa356b49cee4e` |
| Luna worker | `623f6398-0189-453f-bf2a-7ba85e48a0ed` |
| Derived card | `124ad1f4-0be9-42a6-87e7-578836c599a1` |
| Derived workspace | `wks_228b3cc70afdb125` |

## PASS

- `npm run typecheck`: `tsc --noEmit` exited 0.
- `npm test`: 52 test files passed, 12 skipped; 279 tests passed, 63 skipped.
- Baseline snapshot: 21 native projects, 200 agents, 27 workspaces; final cleanup returned to the same counts.
- The full-access Luna worker called `kanban_get_task`, proposed Alpha and Beta via MCP, then proposed Gamma through the supplied CLI fallback. The worker reported an ideas array from `kanban_get_task`; CLI returned success and removed its private request snapshot.
- A case-insensitive, trimmed duplicate title was rejected with `IDEA_DUPLICATE`; the response included the existing idea ID. The board held exactly 3 ideas with the requested field values/defaults, 3 `idea_proposed` events and 3 `idea` receipts. Source card status stayed `todo` and task revision stayed `1`.
- Dismiss → restore → dismiss succeeded. Activity contained `idea_dismissed` and `idea_restored`; the idea ended dismissed.
- Creating a card from the open Alpha idea wrote `origin.taskId`/`origin.ideaId`, marked the idea accepted with `acceptedTaskId`, and added `idea_accepted` on card A. `tasks.context` contained `Derived from card: Ideas acceptance source card (8d5ff548-7d0a-473b-9d0f-42d07e34b5c9)` (card A of the final run; corrected by the implementation session, the first draft quoted attempt 05).
- Reusing the accepted idea with a new operation ID returned “This idea is no longer open.” Workspace count remained 29 before and after the rejected request. Updating the accepted idea returned “This idea already became a card.”
- Deleting card A with `archive:false` removed its ideas from the board. The task backup contained all 3 ideas; the derived card retained its origin. The fixture workspace directory remained empty, so the worker made no file changes.
- Cleanup passed: the worker session is archived; `projects.remove` removed the native project and its two workspaces; the plugin board no longer contains the fixture project or derived card; the temp directory and test-owned backup files are absent. Counts returned to 21 native projects, 200 agents, and 27 workspaces.

## FAIL

- No Ideas feature assertion failed. One parser-only false negative remained in the final execution because Luna returned a newer `{ mcp, cli }` report shape; the raw worker report contains the expected `IDEA_DUPLICATE`, and the board/event/receipt evidence confirms the full three-idea path. The current harness parser now accepts this shape; `node --check` passes.
- Earlier harness attempts also exposed an unavailable MCP client import path, receipts not being part of `board.read`, and an incorrectly sampled workspace-count baseline. Each attempt's resources were cleaned; attempt evidence is retained as `attempt-01.json` through `attempt-05.json`.

## UNRUN

- UI checks for the lightbulb badge, drawer Ideas section, prefilled “Create task from idea” form, and “From idea on …” line. CUA inventory returned the Paseo app but no window IDs, titles, or geometry, so the non-fullscreen window could not be identified unambiguously. No UI actions were taken.
