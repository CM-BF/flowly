# Compact task status label

Date: 2026-10-14  
Acceptance mode: code only, per the user's most recent choice.

## Report and cause

- The user-supplied [phone crop](fixtures/status-label/before.png) is 538×130 px and shows the current task status shortened to `T...` beside “Status”.
- The plugin constrained the entire `SettingsSelect` wrapper to 240 pt. The installed Paseo 0.11.2 [settings implementation](https://github.com/getpaseo/paseo/blob/v0.11.2/packages/app/src/components/settings/index.tsx#L195-L205) gives the row label `flexBasis: 160` plus right margin before the control. Source plus screenshot support a width-allocation diagnosis; no device measurement of the internal control was available.

## Change

- Compact TaskDrawer shows a full-width status button with the selected `statusLabels` text. Tapping opens a host Modal with all seven complete labels. The plugin theme is provided inside `Modal.Content` for the Android boundary. The Status action stays grouped with Edit and Archive.
- Wide TaskDrawer retains the public host `SettingsSelect` and gives it a 300–360 pt wrapper rather than the old 180–240 pt wrapper.
- Both layouts use the same change-status function. A same-value choice makes no write. Different values use the captured task revision, existing guarded RPC and success toast. Inactive/archived/pending state disables mutation; moving to a session preview closes the compact chooser. No server, board-data or native resource contract changed.

## Verification

- PASS: `npm run typecheck`.
- PASS: focused TaskDrawer renderer 9/9, including a compact selected `In progress` label, seven choice labels, no-op current selection, one `blocked` CAS update and toast, and archived disable. Legacy renderer regressions 43/43 and immediate-close 2/2 passed in the corrected run. Output: `fixtures/drawer/focused-output-2026-10-14T14-28-51-760Z.txt`, `legacy-regression-output-2026-10-14T14-28-51-760Z.txt` and `legacy-immediate-close-output-2026-10-14T14-28-51-760Z.txt`.
- The first regression run failed only because older synthetic mocks did not export the newly used host Modal and plugin Theme; its original output is preserved at `fixtures/drawer/legacy-regression-output-2026-10-14T14-28-09-045Z.txt`. The two fixture mocks were updated, then the run passed. No implementation change was made for that fixture error.
- PASS: final `npm test`: 15 files passed / 10 renderer-only skipped; 84 tests passed / 56 skipped. `impeccable detect --json client/drawer.tsx` returned `[]`. `paseo plugin reload paseo-ultra-kanban` exited 0 and reported running. The two timestamped temporary renderer paths are absent; current-run cleanup receipt is `fixtures/drawer/renderer-cleanup-2026-10-14T14-28-51-760Z.txt`.
- UNRUN: actual Android pixel text visibility, dropdown/sheet gestures, accessibility focus and light/dark rendering. The user selected code-only acceptance; no phone or Paseo window was operated, and no project/workspace/card/session was created.

Final `client/drawer.tsx` SHA-256: `0def8da202e606f384fd0b4c22fe22455c8da00003ac6f4e18aa03163fd79753`. Copied screenshot SHA-256: `1696d1c1ebfce861222a3be8579db2c6b502f90aa655aa8ae2476f6c879f8974`.
