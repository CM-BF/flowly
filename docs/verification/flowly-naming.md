# Flowly naming verification — 2026-10-19

Input: card `bb3e8868-2a5c-4914-97f3-7b0c01896be4`, the user's rename instruction, [naming spec](../FLOWLY-NAMING-SPEC.md), and the current Paseo plugin reference checked against the pinned 0.11.2 SDK. No Jira ticket input. Working tree: `50965f99686192f7cb027b94c4e4bda12531f824`, `main`, dirty (includes pre-existing work from other cards, preserved).

## Delivered

MCP server/configuration key `flowly`, exactly eleven advertised `flowly_*` tools, packaged `skills/flowly/SKILL.md` and byte-identical runtime skill (`name: flowly`), CLI `flowly.mjs`, `FLOWLY_*` session/config environment, new helper labels and query prefixes. README/overview, generated instructions, ticket hints and current tool references agree.

Private legacy environment/CLI compatibility, existing summarizer labels, data/settings migration and provisioning idempotency keys are retained. Historical verification evidence and the actual checkout/native resource paths are preserved. No new onboarding row or tip: the rename changes no concept or interaction. Already-running sessions can retain cached tool/configuration names; their CLI fallback remains valid, and new managed sessions receive the Flowly names.

## PASS

| Check | Result |
| --- | --- |
| `npx vitest run server/tool-server.test.ts server/service.test.ts server/naming.test.ts shared/summary.test.ts server/summaries.test.ts server/insights.test.ts server/tickets.test.ts client/queries.test.ts` | 8 files / 75 tests passed |
| `npm run typecheck` | Passed before reload |
| `npm test` | 84 files / 579 tests passed; 12 files / 63 tests skipped |
| `paseo plugin reload flowly` | Exact local directory installation reloaded and running; no daemon restart |
| Installed MCP initialize/list/read | Server identity `flowly`; exact eleven `flowly_*` tools; scoped read returned this card and caller identity |
| Installed new CLI | Current/read, workpad, progress and artifact writes succeeded through `flowly.mjs` with fresh signed requests |
| `node docs/verification/flowly-naming-live.mjs` | Real managed Luna session, `codex/gpt-6-luna`, `modeId: full-access` at creation; actual Flowly MCP read/progress write and new environment/skill checks passed |
| Independent Luna tests | 4 files / 22 tests passed; no defects found; [report](flowly-naming-luna.md) |
| Recovery/compatibility tests | Stable endpoint/credentials/receipts across reload, CLI environment precedence and legacy fallback, old CLI upgrade, copy-once legacy data/settings migration, old/new summarizer recognition |

The advertised tools are `flowly_get_task`, `flowly_update_status`, `flowly_report_progress`, `flowly_propose_idea`, `flowly_add_artifact`, `flowly_remove_artifact`, `flowly_read_ticket`, `flowly_set_tags`, `flowly_set_type`, `flowly_suggest_next_moves`, and `flowly_update_workpad`.

## Cleanup and limits

Only test session `bc10675f-1b10-49dd-8cba-6ebbf2f18fd0` was created, in this card's existing workspace. It completed, was archived and permanently deleted; native inspect confirmed missing, and a fresh card read confirmed it absent. No test project, workspace, card, worktree or branch was created. The existing workspace and every pre-existing session/resource are preserved. [Creation and cleanup metadata](flowly-naming-live.json) contains no credentials.

UNRUN: desktop/compact UI, because this change adds no UI interaction or layout. No browser/window actions were performed. The 63 skipped renderer tests remain skipped under the standard suite. `git diff --check` reports an existing trailing blank line at `client/settings-pages.tsx:421` from that file's pre-existing workflow-insights additions; this task preserved those edits. No failing functional check or unresolved naming defect. These original results were from the shared dirty workspace. The subsequent [rename-only review and commit validation](flowly-naming-review.md) records checks on the isolated publish candidate; commit/push receipts are recorded on the card.
