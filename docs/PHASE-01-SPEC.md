# Phase 1: Kanban and Paseo resources

Later decision: new projects and cards use one native Paseo project root. The earlier multi-repo behavior below remains historical and is superseded by [SINGLE-ROOT-SPEC.md](SINGLE-ROOT-SPEC.md). Existing cards keep their saved scope.

Status: revised implementation specification, 2026-10-13. The user's correction supersedes the earlier single-repo card interpretation. Finish this phase and stop for user acceptance; Phase 2 remains deferred.

## 1. Goal and complete user journey

The plugin adds an Ultra Kanban screen and workspace panel. A user creates a board project, selects or registers its single Paseo project, adds repo directories, creates a card with one existing/new workspace, opens its right drawer, and works with any of that workspace's agent sessions. All board records survive plugin reload. The UI uses real Paseo resources and has no seeded/mock tasks.

The visual direction is a restrained work desk: compact project navigation, clear column labels and counts, flat task cards with status/priority accents, and a readable drawer. Use host theme tokens. Wide windows show columns and a right drawer together; compact windows use horizontal board scrolling and a full-width task detail with Back. Important actions have accessible labels and explicit pending/error states.

## 2. Scope and relations

- Kanban project ↔ Paseo project: 1:1, including archived board records for uniqueness.
- Project → repository directories: 1..N existing canonical absolute directories. One is primary and matches the registered Paseo project's root.
- Card ↔ workspace: 1:1, including archived cards so past ownership cannot silently be reused.
- Workspace → sessions: 0..N, queried from Paseo; do not maintain a duplicate provider-session database.
- Card → repo scope: optional. `repoPaths: []` means all current project repos; a nonempty list selects one or more project repos. The default form selects none. Scope is editable and independent of workspace startup/source repo. It guides agent work; it does not impose a filesystem sandbox.
- New workspaces pass the board's native project ID and a separate startup/source directory. The directory defaults to the first effective scoped repo (the primary directory for unrestricted cards). Worktree creation specifies one Git source repo explicitly; this does not narrow card scope.
- Existing workspaces are linkable when their actual directory is in a project repo, or their Git common directory matches a project repo (including managed worktrees outside the source directory). They may belong to another native Paseo project, retain that owner, and must be unbound. Native project ID/title alone is not proof of repo membership. Scope selection does not filter this project-wide workspace list.
- Project/card archive affects board visibility only. No implicit workspace, session, worktree or project deletion.

## 3. Project operations

Create: title (1..120 chars), optional description (max 10,000), a primary directory, optional additional directories, and optional existing Paseo project ID. Trim text, canonicalize and validate directories on the daemon. If linking, verify the project exists and primary directory matches its root. If registering, run Paseo CLI with argv on the daemon home and verify the returned registration through the plugin's SDK before saving. Enforce native-project uniqueness.

Edit: rename board title/description, add/remove secondary directories, and archive/unarchive. Native project's root and ID are immutable in v1. A directory used as a workspace source or explicitly selected in a card scope cannot be removed, including archived cards. Unrestricted cards follow additions/removals to the current project list. Renaming the board does not rename the native project. Project navigation shows task counts and primary/secondary repo labels. The screen supports an empty state with Create project and a show-archived toggle.

## 4. Card operations

Create: title (1..200), description (max 20,000), status (default todo), priority (low/normal/high/urgent; default normal), optional multi-select repo scope, and workspace mode. The repo scope UI explains that no selection means all project repositories, offers independent toggle controls and Clear selection, and never implicitly selects a repo on opening.

1. Link an existing unbound workspace in any project repo, including a workspace owned by another native project. List its repo, path and native owner; occupied entries are disabled with a reason. Infer its source repo from canonical path/Git identity on the daemon; do not ask for a fake single-repo task binding. Outside-project or missing workspaces are rejected before card commit.
2. Create a fresh directory-backed workspace. A separately labeled Startup repository picker is optional in the initial form; blank chooses the first effective scoped repo. Show the effective default so users know the starting directory while the card remains unrestricted by default.
3. Create an isolated worktree from one project's Git repo and a required branch name. Base ref is optional in the form: empty input resolves to the selected repo's current named branch on the daemon (for example `refs/heads/main`). Legacy `HEAD` input is normalized the same way; the literal `HEAD` is never sent to Paseo's worktree API. A detached HEAD or non-Git directory requires an explicit valid base ref and produces an actionable error before provisioning. Invalid Git source/branch failures preserve the form and create no card.

Store `repoPaths` separately from `sourcePath` (workspace provenance) and workspace ID. `sourcePath` never represents task scope. New workspace startup/source must be one of the effective scoped repos; an existing workspace may start in another project repo, and scope edits may exclude the startup repo without moving the workspace. A successful resource provision followed by a failed store write is reported with the created workspace ID so it can be linked on retry. Never hide this partial success or delete a user resource automatically. Use a client-supplied creation operation ID for idempotent card retries. The native workspace request key also includes a fingerprint of its creation inputs, allowing a user to correct a failed source/ref/branch form without reusing Paseo's cached failed request. Unchanged retries reuse the same native key; once a card is committed, the card operation ID returns that committed result. Detect prior cards for the workspace before commit.

Edit: title/description/priority/status/repo scope; never recreate its workspace. Preserve the form's initial revision and draft on conflict. Archive/unarchive preserves its workspace ownership. Cards can move between status columns through an accessible Move action and reorder within a column through Up/Down controls. v1 uses these cross-platform controls; drag gestures may be added after native interaction validation.

Columns: Backlog, Todo, In progress, In review, Blocked, Done, Cancelled. Finished columns can be collapsed. Search matches title/description; priority and repo-scope filters compose with search. A repo filter includes unrestricted cards and cards explicitly selecting that repo, regardless of workspace source. Cards show title, priority, All project repositories or selected repo names, workspace availability and session activity count. An empty column offers Add task. Counts reflect displayed results, with a visible total when filtered.

## 5. Right drawer and sessions

Click a card to open a task drawer, preserving the board context. Header shows title, status, priority, edit/archive and close/back. Body shows description, repo scope, separate workspace startup/source repo, workspace name/directory/native owner/state, Open workspace, session list and activity/history. If the workspace no longer belongs to any current project repo, explain incompatibility and disable session actions.

Workspace unavailable/archived: preserve the card, clearly mark availability, keep business edits available, disable session creation/instructions with a reason. If active, list all its sessions, displaying provider/model, title and initializing/running/idle/permission/error/archived state. Users select one session; refresh selections safely when the list changes.

New session form discovers provider/model/mode choices from Paseo; require an available choice, preserve the default mode unless explicitly selected, optionally send an initial instruction, and create through the workspace handle. Add card title/description and effective repo scope with absolute work directories as task context. For a worktree-backed startup repo, use this workspace's checkout for that repo; other scoped repos use their registered directories. Explain that only the startup repo is isolated by this worktree. Existing-session follow-ups include current scope context, so scope edits are observed on the next instruction. Provider permissions still determine actual filesystem access; agents must report denied access rather than claim work was done. v1 does not inject Kanban tools yet.

Selected session shows recent text output and pending permission/question summary. Full tool trace and full native composer are available through Open session. Instruction input sends only to the selected session, preserves text on failure, and clears on accepted delivery. For a running agent, explicitly choose Steer or Interrupt using supported native semantics. Unsupported operations remain disabled/explained. Permission resolution is handled by opening the native session in Phase 1.

Status subscription/refresh updates running and idle state without reload. Timeline subscription is scoped to the selected session and released on selection/drawer close. Refetch after reconnect; limit displayed history to recent records and provide Refresh/Open session.

## 6. Data and RPC contracts

Server data directory: `FLOWLY_DATA_DIR` override, else `<PASEO_HOME or ~/.paseo>/plugin-data/flowly`. A versioned JSON document stores projects, cards and bounded card events. Write through one store instance with serialized mutations, temp file + atomic rename, restrictive permissions, and a backup of the previous valid revision. Corrupt or newer-version files produce a recoverable error without silent replacement.

Data version 2 adds card `repoPaths` (empty = all project repos). Project: ID, title, description, native project ID, primary path, repo paths, revision, created/updated/archived timestamps. Card: ID, project ID, workspace ID, workspace source path, repo scope, title, description, status, priority, position, revision, creation operation ID and timestamps. Event: ID, task ID, actor (`human`, `agent`, `system`), action, optional agent ID/note, previous/new status and timestamp. Retain the latest 100 events per card. Session state is read from Paseo; it is not authoritative card status.

Read version 1 as version 2 with every legacy card unrestricted (`repoPaths: []`); preserve IDs, source provenance, ownership and history. A read does not rewrite the file; the next successful serialized mutation persists version 2 atomically and retains the original version-1 file as the previous backup. Reject invalid/newer versions without reset.

Runtime-neutral shared Zod contracts:

- `board.read`: complete validated document plus revision and service health; called on entry and every 3 seconds while visible.
- `projects.create/update`: validated project inputs; update requires expected project revision.
- `tasks.create/update/move`: card inputs; update/move require expected card revision. Reordering is serialized. Non-status changes do not emit status events.
- `resources.list`: native projects and active workspaces with matching project repo paths, native owner, directory and availability; recompute canonical repo membership on the daemon. Provider/models are read directly through the SDK.
- `tasks.context`: validated card/project/workspace scope context and availability for session creation/follow-ups; uses the supplied Paseo SDK and never changes resources.

Errors distinguish validation, revision conflict, occupied resource, resource missing, provisioning failed and partial provisioning. Mutation result refreshes board cache; polling synchronizes other clients. Stale forms retain draft and offer reload. Filesystem and CLI access remain server-only. All outputs are validated by RPC schemas.

## 7. Failure and lifecycle handling

- Duplicate creation operation IDs return the original committed card. Duplicate workspace/project associations are rejected even under concurrent requests.
- Workspace resources may disappear between listing and saving; revalidate immediately before commit.
- Hook events add observational activity only. They never move a card's business status or launch another session.
- On reload, persisted board state is loaded and resource availability is recomputed. No replay assumption, background auto-prompt or inferred task completion.
- Plugin cleanup releases registrations, subscriptions and timers. Do not restart the daemon.

## 8. Packaging and install

Manifest `paseo-ultra-kanban`, display name Ultra Kanban, requirements `>=0.11.2`; pin SDK types at 0.11.2. TypeScript strict, React Native client; Node server. Code is divided into client UI, server store/resource service and shared models/contracts. Keep `OVERVIEW.md` for the Paseo listing and README for developer commands.

Register a sidebar screen, a workspace panel showing that workspace's linked card, and Command Center Open Ultra Kanban. No separate global connection. Existing installed plugins and their data remain untouched.

## 9. Acceptance and required testing session

Before installing, typecheck and run focused invariant tests. At testing time, create a Paseo `codex/gpt-6-luna` session in this project's workspace. No configured profiles currently exist; the model is discoverable under Codex. The session tests against fixture directories only and writes `docs/verification/phase-01.md` with commands, UI evidence, session ID and outcomes. The session does not edit implementation source.

Required scenarios:

1. Empty board → project with two repos → native project registration/one-to-one enforcement.
2. Create directory and worktree cards from different repos under the same native project; exact ownership/source path verified. Worktree creation with the untouched optional base-ref field must succeed on the selected repo's named branch. Verify a non-default branch and detached-HEAD error behavior.
3. Link an existing compatible workspace; reject occupied/incompatible/missing workspace and duplicate operation retries.
4. Edit/move/reorder/filter/archive/unarchive; preserve unrelated edits on revision conflict.
5. Drawer shows the card's single workspace and multiple sessions; create a session, send a follow-up and observe the actual reply/status. Business status remains unchanged when a turn ends.
6. Plugin reload retains cards, history and associations. Missing/archived resources show the intended error state.
7. Real Paseo client at wide and compact widths and light/dark themes; verify text contrast, scrolling, forms, drawer and pending/error states. Rendering alone or a browser 200 does not satisfy this.

Revised required scenarios: untouched repo scope creates an unrestricted card; one/multiple selections and clearing persist; scope edits keep the same workspace/sessions; scope filters include unrestricted cards; new-session and existing-session follow-up context carries only effective repos (with checkout mapping); unrestricted tasks can actually modify isolated fixtures in both repos. Link an existing secondary-repo workspace owned by its own native project and an external managed worktree; preserve their owners. Reject arbitrary directories even if attached to the board's native project. Verify version-1 migration/backup and project repo edit guards. Retain prior test evidence and distinguish it from revised acceptance.

Phase 1 implementation is ready for user acceptance only when Luna failures are resolved or specific externally blocked checks are documented. Then stop and provide the revised spec, verification report and UI entry to the user. Do not start Phase 2 until the user instructs it.
