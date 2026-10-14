# Paseo Ultra Kanban

A local Paseo plugin for projects, one-workspace task cards and multiple agent sessions.

Read [the accepted outline](docs/SPEC-OUTLINE.md), [Phase 1 spec](docs/PHASE-01-SPEC.md) and [progress](docs/PROGRESS.md).

Cards default to all current project repositories. Optionally select one or more task repositories; this scope is separate from the workspace's startup directory. Existing workspaces in any project repository, including external Git worktrees and workspaces with another native Paseo project owner, can be linked without reparenting. A workspace remains unique to one card.

```sh
npm install
npm run typecheck
npm test
paseo plugin install "$PWD" --id paseo-ultra-kanban
paseo plugin reload paseo-ultra-kanban
```

Data lives in `~/.paseo/plugin-data/paseo-ultra-kanban/board.json` by default. `PASEO_HOME` selects the daemon home; `ULTRA_KANBAN_DATA_DIR` overrides the store directory for tests. The plugin preserves invalid data and the previous valid backup. New workspaces explicitly select their repository and the board's native project ID.

Tests use dedicated fixture directories. Existing Paseo resources and the separately installed `paseo-kanban` plugin are preserved.

Data version 1 is read as version 2 with unrestricted scopes on legacy cards. The next successful mutation persists the migration and backs up the preceding file. A worktree isolates its source repo only; additional scoped repos use their existing directories. Task scope is an instruction boundary, and provider permissions determine actual access.

Phase 1 stops for user acceptance after Luna verification. Agent tool/skill integration is deferred until the user's next instruction.
