# Verification: remove a project (board, optionally Paseo)

Spec: [PROJECT-REMOVE-SPEC](../PROJECT-REMOVE-SPEC.md). Date: 2026-10-15. Implementation session `f8340275-eae8-4b9d-aa27-ddfa5abe6617`.

## PASS

- `npm run typecheck`; `npm test` 197 passed (`server/project-remove.test.ts` 2, `server/project-remove-paseo.test.ts` 5).
- Native behavior probe (throwaway git dir `/tmp/ultra-pdel-*`, one directory and one worktree workspace): `paseo project delete` removed the project and 3 workspace records; root folder, worktree folder and branch remained. Probe worktree, branch checkout and folder removed afterwards.
- Plugin reloaded. Fixtures via [setup.mts](fixtures/project-remove/setup.mts): `Keep fixture` (`prj_070332254997be28`) and `Paseo fixture` (`prj_c93895712ff949e7`), each on its own temp dir.
- Headless app.paseo.sh web client (own profile, not the user's windows): tab → All projects → Remove “…”… →
  - `Keep fixture`: default *Keep in Paseo* → gone from the board, native project still listed, backup written.
  - `Paseo fixture`: *Also remove from Paseo* ([dialog](project-remove-confirm.png)) → toast “removed from the board and from Paseo; files stay on disk”; native project no longer listed; its folder still existed.
  - Tabs afterwards: `Ultra Kanban | SMITH | Search System`.
- Cleanup verified: remaining native fixture deleted, both backups and both temp folders removed; `removed/` is empty.

## UNRUN

- Live refusal with a running session (service test only).
- Electron desktop app and phone layout of the dialog.
