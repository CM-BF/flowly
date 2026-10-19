# Workpad verification — 2026-10-19

Card `78fb25af` ([spec](../WORKPAD-SPEC.md)). Implementer session `6afc07fe-beb8-4fd4-9704-9f4916ed570b` (Claude Code, claude-opus-5-5). No Luna session was used.

## PASS

- `npm run typecheck`.
- `npm test`: 77 files passed, 12 skipped (renderer-dependent fixture suites), 519 tests passed. New: `shared/workpad.test.ts` (11), `server/workpad.test.ts` (7), 5 workpad tests in `server/agent-service.test.ts`, silent-turn and tool-schema checks in `server/progress-rules.test.ts` / `server/tool-server.test.ts`, the `first-workpad` tip order in `client/onboarding-logic.test.ts`; i18n catalogs complete (26 strings × 9).
- Installed plugin reloaded (`paseo plugin reload flowly`); `kanban_update_workpad` appeared in this live session's MCP tool list.
- Live MCP: this card's workpad written (revision 1, HEAD `20c25c31e411`, dirty, host/path stamp); `get_task` returns it with `fresh` and `open`.
- Live CLI: `workpad` with a stale `--workpad-revision 0` → `WORKPAD_CONFLICT`; `status in_review` with 3 unrun checks → `WORKPAD_OPEN` listing them, card unchanged; `--acknowledge-open` on a non-status command is refused.
- Headless web client (app.paseo.sh on the local daemon, own browser profile; the user's windows untouched):
  - desktop 1700×1000: card shows `Checks 4/7` ([card](workpad/desktop-card.png)); drawer Workpad section with stamp, Acceptance, Checks (commit, "on uncommitted changes", Show output), Confusions ([drawer](workpad/desktop-drawer-checks.png)); Progress hides Target while acceptance criteria exist; no page errors.
  - ticking an acceptance criterion in the drawer and unticking it: 6 round trips saved (`workpad_checked` events, workpad revision 7, `by: human`, "by you" shown), task revision unchanged; checkboxes expose `aria-checked`; a check's status button reads e.g. "…: not run".
  - compact 400×860: card signal fits on one line ([card](workpad/compact-card.png)); drawer Workpad with tappable boxes ([drawer](workpad/compact-drawer.png)).

- Project switch (user follow-up): `npm test` 521 passed / 63 skipped (new switch tests in `server/agent-service.test.ts`, `server/workpad.test.ts`); plugin reloaded; the project settings dialog shows *Card workpad* below *Auto-update status in this project*, on by default ([screenshot](workpad/project-switch.png)); closed without saving.

## UNRUN

- Turning the switch off and on in the real UI (the user's projects were not changed; covered by service tests).

- Plan from a native todo list in a real session: covered by unit tests on the timeline shape (`AgentTaskItem`), but no Claude/Codex session with a todo list ran on a card after the reload.
- Cycling a check's state and resolving a confusion in the real UI (covered by server tests only).
- Out-of-date checks after a new commit in the real UI (covered by unit/service tests only).
- Luna 6 test session required by AGENTS.md; native iOS/Android apps; dark theme.
