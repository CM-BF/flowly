# F4 desktop shortcuts — verification (2026-10-15)

Branch `feat/keyboard-shortcuts` in worktree `/Users/bofan.wang/.paseo/worktrees/270gs08k/feat-keyboard-shortcuts`. Implementation session `adff718c-c0bb-4a8f-9162-ca8081b734b6` (Claude Code; no separate Luna test session, per card instructions).

## Research evidence

- `node_modules/@getpaseo/plugin/dist/client/contracts.d.ts` (0.11.2): `PluginClientContext` has no shortcut or keybinding method. `PluginCommandCenterItemContribution` = `id/title/icon/keywords/context/onSelect`.
- Installed host bundle `/Applications/Paseo.app/Contents/Resources/app-dist/_expo/static/js/web/index-*.js`: internal `resolveShortcutKeysForAction(<fixed action id>)`, `useKeyboardShortcutsStore` and `KeyboardShortcutsDialog`, with no plugin entry point. RN-Web `keyboardProps = {onKeyDown, onKeyDownCapture, onKeyUp, onKeyUpCapture}` is forwarded by `View`.

## Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npx vitest run client/shortcuts.test.ts` | PASS 10/10 (key mapping, modifier/repeat/IME/blocked guards, grid ordering and navigation, intent freshness/unknown/once-only key, no collision with session-link params) |
| `npm test` | PASS 103 passed / 56 skipped (renderer-only fixtures). First run FAIL 3 fixture files: their host mock lacks `Modal`, and `client/modal.tsx` read `Modal.Content` at import time; fixed by reading it at render time |
| Plugin install/reload, Luna session, desktop UI | UNRUN (card instructions forbid install/reload and other sessions) |

## Unrun acceptance items

- Pressing keys in the real desktop board, and whether a click on blank board space focuses the root `View` (`focusable` → tabIndex).
- Focus after a host Modal closes (it may return to the document root, which would require another click).
- Command Center items appearing, and `openScreen` with new params on an already-open board screen re-rendering with the new `intent`.
- Help modal and header Keyboard button appearance in light/dark themes.
