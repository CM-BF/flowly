# Auto status v1 — live end-to-end (2026-10-15)

Client: separate headless app.paseo.sh web client bound to the local daemon (not the user's windows). Fixture recorded before creation; removed afterwards.

| Step | Evidence | Result |
| --- | --- | --- |
| Fixture card "E2E auto-status fixture" (Ultra Kanban project, worktree, generated branch `kanban/e2e-auto-status-fixture-728a36`) | board.json event `created` | PASS — optional branch name generated |
| Start session from the card (claude / Haiku 5.5 / Bypass) | `agent.turn_started` → `status_changed` rule `A1` todo→in_progress "started working" | PASS |
| Agent `kanban_report_progress kind=question` "Proceed with the test? (yes/no)" | card shows "Needs you" ([screenshot](auto-status-needs-you.png)) | PASS |
| User reply "yes" (`paseo send`) | new turn clears the question; agent sets in_review "E2E test complete" | PASS |
| Casual message while In review | A1 in_review→in_progress, turn ends without report → `A1r` in_progress→in_review "No work was reported in that turn; restored" | PASS |
| Status-change flash | accent outline appears on both moves and fades ([sequence](auto-status-flash-sequence.png)) | PASS |
| Wrap up (Done) | preflight "1 session idle · branch … · No uncommitted changes or local-only commits"; worktree workspace + session archived; card archived | PASS |

Cleanup: session 5906c28f archived (absent from active `paseo ls`), worktree removed by Paseo (`git worktree list` shows only main), branch had 0 unique commits and was deleted, card archived (plugin keeps archived history; no delete operation exists). No other resources created.

Not covered: native iOS/Android, Luna acceptance.
