# Verification: delete a card permanently

Spec: [TASK-DELETE-SPEC](../TASK-DELETE-SPEC.md). Date: 2026-10-15. Session: 4cc9d427-a618-430f-94a1-1209f940f626 (card “增加彻底删除卡片”).

## Completed

- `npm run typecheck`: PASS.
- `npm test`: 251 passed / 63 skipped. New store tests in `server/project-remove.test.ts`: deletion scope + backup + reusable workspace binding; archived-only, stale revision and unknown card rejected with nothing written.
- Plugin reloaded (`paseo plugin reload paseo-ultra-kanban`); logs clean.
- Live cleanup through the running plugin's `tasks.delete` RPC (`node docs/verification/fixtures/task-delete/cleanup.mjs "$PWD" --apply`, dry run first; log: [last-run.log](fixtures/task-delete/last-run.log)). The script only deletes listed IDs that are archived cards of the Ultra Kanban project whose worktree workspace is archived in Paseo with its directory gone. Deleted 11 cards: F1–F4 and the E2E auto-status / archive / create-and-start / settings / composer / image / effort fixtures. Each has a `removed/task-<id>-<time>.json` backup. The restorable archived card “竞品调研” (live local-checkout workspace) was kept.

- Follow-up (any lane + archive choice): typecheck PASS; `npm test` 253 passed / 63 skipped. Live read-only `tasks.delete-check`: 竞品调研 → no blockers, workspace archivable; this card → blocker "1 session is still running".

## Unrun

- A live delete with *Archive* on a dedicated fixture card (covered by focused tests with a mocked Paseo).

- Luna (`codex/gpt-6-luna`) UI acceptance of the *Delete permanently…* menu entries and dialog on desktop/compact.
