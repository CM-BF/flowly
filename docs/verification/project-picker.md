# Verification: project directory picker and linked multi-repo projects

Spec: [PROJECT-PICKER-SPEC](../PROJECT-PICKER-SPEC.md). Date: 2026-10-15. Kanban card `ff4a2232-058b-4d75-adb5-32f0413bb2e2`, session `f8340275-eae8-4b9d-aa27-ddfa5abe6617` (implementation session, not a Luna test session).

## PASS

- `npm run typecheck`.
- `npm test`: 187 passed (63 skipped, pre-existing fixture suites). New `server/linked-projects.test.ts` (7 tests): linked create with name collision and fresh root per title, invalid/duplicate targets create nothing, cleanup before native registration, `set-links` add/remove/CAS/foreign-entry protection, folder-name rules, directory listing (hidden filter, git flag, symlinked dirs, dangling links skipped), native picker unavailable.
- `paseo plugin reload paseo-ultra-kanban`; plugin `running`.
- Live RPC against the installed plugin, [live.mts](fixtures/project-picker/live.mts) → [evidence](fixtures/project-picker/live-evidence.json): 12/12 checks — home listing, `native: finder` on macOS, git marking, invalid target rejected with no directory left, linked root created under `~/.paseo/plugin-data/paseo-ultra-kanban/projects/`, links and symlinks match, native Paseo project registered at that root (`kind: non_git`), `set-links` swapped a link without touching the target, stale revision rejected, board shows the project.
- Cleanup verified: fixture native project deleted (`paseo project ls`), board record removed, linked root and temp directories removed.
- macOS `osascript choose folder` starts and waits for the user (killed after 3 s in a smoke run; no error).

## UNRUN

- UI: the project form (Source choice, inline browser, Finder button, repositories list, edit of links) was not exercised in the Paseo window — CUA still cannot bind the non-fullscreen window unambiguously, and no Luna UI session was launched for this increment.
- Native dialog selection end to end (choose folders → paths returned) needs a human click; cancel parsing (`-128`) is unit-reasoned only.
- Windows Explorer / Linux zenity/kdialog dialogs: no such host available.
- Agent behavior inside a linked root under non-full-access sandboxes (symlink targets outside the workspace).
