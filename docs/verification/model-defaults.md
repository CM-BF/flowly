# Model defaults verification (2026-10-16)

Method: headless Chromium (Playwright), isolated context, `local-network-access` granted only to `https://app.paseo.sh`, against the running daemon after `paseo plugin reload`; the `Tinylink` demo project. The global setting was restored to Automatic and the project override cleared afterwards. No native Paseo window.

## Completed

- Unit: `shared/agent-defaults.test.ts` (precedence, starting agent, stored values, schema) and the project field in `server/project-order.test.ts` (set, replace, clear, stale revision rejected). `npm run typecheck`, `npm test` pass.
- End to end, reading the "New session" dialog of a card:
  | State | Provider / model / reasoning shown |
  | --- | --- |
  | no defaults | Claude / Opus 5.5 / Medium (latest session) |
  | global = Claude | Claude / Opus 5.5 / Model default |
  | project = Codex (global still Claude) | Codex / GPT-6.1-Sol / Model default |
  | project override cleared | back to Claude / Opus 5.5 |
- Settings → Models and Project settings → Default model render and save; the provider list is searchable; no page errors. Screenshots in `docs/promo/screenshots/settings/` (`models-*.png`).

## Unrun

- "Start an agent now" on a new task with a default set (same code path as the dialog, `sessionDefaults`, but not driven); a project whose provider is unavailable on the machine; phone/tablet layouts of the new settings rows.
- Translations were written without native-speaker review.
