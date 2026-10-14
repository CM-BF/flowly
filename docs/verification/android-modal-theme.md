# Android modal theme crash correction

Date: 2026-10-14

## Evidence and diagnosis

- User-provided [project chooser crash screenshot](fixtures/android-modal-theme/project-chooser-crash.png): Paseo's error screen reports `Theme missing` at plugin `useTheme`, then `Button`, after opening the project chooser on Android.
- `client/ui.tsx` defines the plugin's own `Theme` context and throws that exact error when it is absent. The prior `client/board.tsx` provider wrapped the screen outside the host Modal, while the chooser's `Button` was rendered inside `Modal.Content`. The same boundary existed in six other modal bodies.
- Inference from the stack and source: the Android host Modal renders its body without carrying the plugin's own outer context. The public Paseo modal contract guarantees plugin runtime context inside modal children; it does not establish preservation of this plugin-defined theme context. The screenshot identifies the failure in `Button`, not a project RPC or persisted-data error.

## Change

- The existing current `PluginTheme` is provided again **inside** each of the four board modal bodies. `ProjectForm`, `TaskForm` and `SessionCreate` capture the theme in their parent tree and provide it inside their modal bodies. All seven `Modal.Content` occurrences now have an immediate theme provider.
- This is a client-only render change. No board record, native project, workspace, session, RPC, or permissions were changed.

## Verification

- PASS: `npm run typecheck` exited 0 after the change.
- PASS: inspected every `Modal.Content` in `client/board.tsx`, `client/forms.tsx` and `client/session-create.tsx`; all seven immediately contain `<Theme.Provider>`.
- PASS: `paseo plugin reload paseo-ultra-kanban` exited 0; subsequent plugin inventory shows this plugin enabled and `running` from the local directory. No daemon restart or other plugin action was performed.
- UNRUN: Android project chooser and the other affected modals on a real device. The ADB inventory did not return and was interrupted; no safely addressable Android UI target was established. The user's two desktop Paseo windows were not used as a substitute. No GUI action was attempted.
- No test suite was run or added for this correction. The reload status and source/typecheck evidence do not establish that the Android screen no longer crashes.

Source SHA-256 after reload: `client/board.tsx` `2e8bcd7fdee1fdd19061f75104e97d4b018b3b82b8d70a37535cf6c3c0d58b7b`; `client/forms.tsx` `8051054c50ea079a84e51d49ccc4b1d970a266026e4ca038912b503cf8b1a54b`; `client/session-create.tsx` `3ac560c5c0bdf3d3fc12d634248c39f4aa3db7823f9c8da313cfbf9bd0b500f5`. The copied screenshot SHA-256 is `19dbc447ca640432f886c71e98967e0bc23297910b5a4a4e611367d245e734dc`.
