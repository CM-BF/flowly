# Verification: workspace restore on leaving Done/Cancelled — 2026-10-15

Spec: [WORKSPACE-RESTORE-SPEC](../WORKSPACE-RESTORE-SPEC.md). Run by the implementing session `d644187a` (Claude), not a Luna session.

## Completed

- `npm run typecheck`: PASS.
- `npm test`: 246 passed, 63 skipped. Includes 8 tests in `server/workspace-restore.test.ts`, 3 of them for session revival.
- Plugin reloaded (`paseo plugin reload paseo-ultra-kanban`); logs clean.
- Direct daemon connection probe (local credential, `inspectWorkspaceRecovery`): PASS. Host and SDK are both 0.11.2.
- End-to-end, `node docs/verification/fixtures/workspace-restore/e2e.mjs "$PWD"`, through the plugin's real RPC (`invokePluginRpc`). Log of the latest run: [last-run.log](fixtures/workspace-restore/last-run.log). The run used the user's real *Auto wrap up* setting, which is on, so moving to Done auto-archived both workspaces.

  | Check | Worktree card | Directory card (`local_checkout`) |
  | --- | --- | --- |
  | Archived after Done, recoverable | PASS (`restore`; directory removed by Paseo) | PASS (`unarchive`) |
  | Moved to Todo → `workspace_restored` recorded | PASS | PASS |
  | Same workspace ID active, listed by Paseo | PASS | PASS |
  | Directory exists | PASS (recreated) | PASS |
  | Back on the kept branch | PASS (`kanban/restore-worktree-…`) | — |
  | Card still bound to its workspace | PASS | PASS |
  | Session after restore, first version | Still archived | Still archived |
  | Session after restore, with session revival | PASS, `archivedAt` null, "1 session(s) restored" | PASS, same |

  - Done → Todo again without a new wrap-up produced no second restore event: PASS.
  - Fixture IDs:
    - project `4e4399de…` / native `prj_f4e404f1d33fe1f0`;
    - workspaces `wks_e7ac86a4e0d1332b`, `wks_0c68d23820cf973e`;
    - sessions `e927421b…`, `d4e955b5…` (Claude Haiku, never prompted);
    - temp repo under `$TMPDIR/uk-restore-e2e-1792053916577-*`.
  - Cleanup verified:
    - board project and cards gone;
    - native project, workspaces and sessions absent from `paseo project ls` / `workspace ls` / `ls -a`;
    - temp repo and worktree removed.

    An empty per-project parent `~/.paseo/worktrees/3cx1pc77`, created by this run, was removed afterwards; the script now removes it when empty.

## Session revival re-run (user follow-up: "把session也复活")

- Each fixture session first ran one Haiku turn ("Reply with OK"), so it has provider persistence like a real card session. With the plugin reloaded, the e2e passed all checks: worktree and directory workspaces restored, each session unarchived, events read "1 session(s) restored".
- An earlier run with never-prompted sessions showed that `refreshAgent` errors ("lacks persistence") but still unarchives. The service now re-reads the session and counts it as restored.
- Fixtures:
  - projects `prj_cb30469f72d0966d`, plus the second run's project;
  - workspaces `wks_921e6f3b57c7ed90`, `wks_9c67d6abf4dcbf7b`, `wks_ee0e479175933bdc`, `wks_84ed82e409f67c40`;
  - sessions `a28524a0…`, `28565c02…`, `e5c8f206…`, `46bbb9b2…`.

  All are absent from `paseo project/workspace ls` and `paseo ls -a`. The temp repos and worktree parents are removed.

## Unrun

- Luna (`codex/gpt-6-luna`) acceptance and real-app UI checks. The UI change is limited to three activity labels.
- Restore with *Auto wrap up* off, through the manual Done-prompt wrap-up. It is covered by the focused test (`wrapped_up` with `workspace archived`), not end-to-end.
- Unavailable paths against a real daemon: deleted directory, deleted source repo, daemon offline. These are covered by the focused tests only.
