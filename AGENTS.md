# Project constraints

## Required reading and delivery order

- Read `docs/SPEC-OUTLINE.md`, the current phase spec, and `docs/PROGRESS.md` before changing code.
- The user's later single-root decision supersedes multi-repo product behavior. Read `docs/SINGLE-ROOT-SPEC.md` before modifying project, task, workspace or tool behavior.
- Phase 1 is the complete Kanban UI and Paseo resource integration. Stop after Phase 1 implementation and Luna verification for the user's acceptance. Do not start Phase 2 without the user's subsequent instruction.
- The user has authorized Phase 2 implementation and complete testing. Follow `docs/PHASE-02-SPEC.md`, use an explicitly full-access Luna 6 test session, and stop for user review after delivery.
- Write the complete phase spec before implementation. Keep observable behavior, errors, data contracts, and acceptance criteria in sync with changes. Routine implementation choices within the accepted scope do not require another approval.
- Record completed, failed, and unrun checks separately. A plugin reporting `running` alone does not prove UI or agent behavior.

## Product invariants

- One Kanban project corresponds to one native Paseo project root. New projects and cards use that root only. Users can place multiple repositories under a common directory and register that directory as the native project; the plugin does not maintain a new repo list or card repo selector.
- Existing multi-repo project/card records are read-only legacy scope data. Preserve their workspace links, scope, activities and receipts; never move directories or reparent native resources implicitly.
- One card corresponds to one workspace; a workspace cannot be bound to two cards. Card edits do not create additional workspaces.
- A card's sessions are the sessions in its workspace. Multiple sessions are supported; users choose which session receives instructions.
- A card's ordinary follow-up sends exactly the user's text after fresh task/workspace/session authorization. Give task context at session creation or through the explicit Kanban work-instructions action; do not prepend a task header to every message.
- Card business status and session execution status are independent. A turn ending never automatically completes the card.
- Automatic assignment, multi-agent handoffs, role orchestration, cross-host scheduling, and PR automation are outside v1.
- Archiving plugin records preserves history and does not implicitly archive/delete Paseo resources or directories.
- Exception, explicit only: the user-confirmed **Wrap up** of a Done/Cancelled card may archive that card's sessions, and its workspace only when it is a worktree (Paseo may then remove the worktree directory). It runs after a preflight (running sessions block; uncommitted/local-only commits require explicit acknowledgement) and archives the card last. See `docs/MULTITASK-SPEC.md`.

## Architecture and compatibility

- Plugin ID is `paseo-ultra-kanban`. Do not overwrite the separately installed `paseo-kanban` plugin.
- Root code is limited to `index.client.tsx` and `index.server.ts`. Other code belongs in `client/`, `server/`, or runtime-neutral `shared/`.
- Use the supplied Paseo SDK for resources and schema-validated RPC for plugin behavior. Never create a second Paseo connection in client UI.
- Client uses React Native primitives, host-provided modules, theme colors, and compact layouts. No HTML, DOM, CSS strings, `localStorage`, or imports of server/Node modules.
- Plugin-owned opens/closes, navigation (including sidebar and session preview Back), and drag/drop feedback must use consistent, short, interruptible transitions. Prefer shared React Native Animated opacity/transform primitives; keep pointer tracking and resizing immediate. Host-owned panes/modals/toasts retain host transitions. Honor system Reduce Motion, stop animation/listener work on cleanup, and cover rapid reversal/stale completion without delaying actions or retaining active subscriptions after close. Successful transient operations use native toasts rather than adding layout rows.
- Pin SDK/type dependencies to the host version and keep manifest requirements correct for both daemon and client.
- Persist on the daemon. Serialize writes, validate input, use atomic replacement, reject stale edits, and preserve invalid data rather than reset it.
- CLI/MCP clients must use the running plugin service for writes; they must not mutate its data file directly.
- Use subprocess argument arrays, never shell interpolation. Do not expose tokens or unrelated user configuration in logs.

## Testing and local installation

- The user explicitly requires a Paseo `codex/gpt-6-luna` session for each phase's testing. Discover actual provider/model availability; do not silently substitute a model.
- Launch all delegated/subagent sessions in full access, as explicitly requested by the user. For Codex pass `settings.modeId: "full-access"` at creation; do not rely on changing the mode after a turn has started. Discover the provider's equivalent mode when using another provider. Pass this requirement to test agents for any children they create, and stop leftover test children when the phase closes.
- Testing sessions may read source, run focused checks, and use the installed plugin against dedicated fixture projects/directories. They own test evidence, not implementation files. Tell them they are sharing the codebase and must preserve others' work.
- Do not spawn implementation agents without explicit authorization. The test-session request authorizes testing delegation.
- Run typecheck before installing/reloading. Install the local plugin under its own ID; reload it instead of restarting the daemon.
- Use isolated temporary directories and explicitly identified fixture resources. Preserve existing plugins, workspaces, sessions, projects, and data.
- Test-created Paseo projects, workspaces, sessions, cards and temporary directories must be cleaned up when the test finishes. Record their IDs/paths before creation; use `try/finally` where practical; verify cleanup in both the native Paseo registry and the plugin board. Never leave fixture projects visible for the user to clean up. Preserve only report/evidence files under `docs/verification/`. Do not delete any resource that predates that specific test or whose ownership is uncertain.
- The user has two Paseo windows. UI tests must identify and bind the non-fullscreen window by its actual window ID/title/geometry; never interact with the user's fullscreen window. If the computer-use API cannot target that window unambiguously, stop UI actions, report the limitation, and continue non-UI checks.
- Verify actual desktop and compact UI, error behavior, persistence, resource ownership, and message delivery. Save the test-session ID and evidence in `docs/verification/`.
- Use focused tests for business invariants and recovery; avoid snapshot tests that only mirror implementation or repeat broad suites without a new reason.

## Commands

- `npm install`
- `npm run typecheck`
- `npm test`
- `paseo plugin install "$PWD" --id paseo-ultra-kanban`
- `paseo plugin reload paseo-ultra-kanban`
- `paseo plugin logs paseo-ultra-kanban`

When creating a commit, include the Codex co-author trailer required by the parent `/Users/bofan.wang/AGENTS.md`. Stage only this project's changes.
