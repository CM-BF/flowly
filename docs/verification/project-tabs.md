# Verification: desktop project tabs and last-viewed project

Spec: [PROJECT-TABS-SPEC](../PROJECT-TABS-SPEC.md). Date: 2026-10-15. Implementation session `f8340275-eae8-4b9d-aa27-ddfa5abe6617`.

## PASS

- `npm run typecheck`; `npm test` (includes `client/project-memory.test.ts`, 3 tests).
- `paseo plugin reload paseo-ultra-kanban`.
- Separate headless app.paseo.sh web client bound to the local daemon (own profile, not the user's windows), 1440×900 light. Read-only: no project or card was created or changed.
  - Tabs `Ultra Kanban | SMITH | Search System`, then + and All projects ([screenshot](project-tabs-switched.png)).
  - Cold open: active `Ultra Kanban` (first). Click `SMITH` → active `SMITH`. Leave to the Paseo home screen and reopen Ultra Kanban → active `SMITH`. Page reload (cold start) → active `Ultra Kanban`.
  - No Kanban console errors.

## UNRUN

- The desktop Electron app itself (same React Native Web client; the user's windows were not touched).
- Many-project overflow scrolling and auto-reveal of an off-screen active tab (only three projects exist).
