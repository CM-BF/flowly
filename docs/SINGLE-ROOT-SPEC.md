# Single-root project amendment

Status: approved by the user's 2026-10-13 instruction; implementation follows this document. This amends the active Phase 1 and Phase 2 specs wherever they describe adding repositories to a board project or selecting repositories per card.

## Goal and product contract

- One Kanban project binds exactly one native Paseo project and uses that native project's `projectRootPath` as its only editable project directory. The board cannot add repository paths to the native project.
- The project form can register a native Paseo project from an existing directory or select an existing native project. Its root must equal the selected directory after `realpath` normalization. A board project cannot rebind or change its root later.
- To work across two repositories, the user places both under a common directory and registers **that directory** as the native Paseo project. The plugin does not create, move, clone, or register the child repositories. A directory workspace starts at the common root, and the Agent may navigate its children subject to provider permissions.
- A new card has one workspace. A new directory/worktree workspace is created from the native project root and assigned to the linked native project. A worktree requires the root itself to be a Git repository with a resolvable base; a common directory containing separate Git repositories uses a directory workspace.
- An existing workspace can be linked if its directory is contained by the native root or is a Git worktree of that root. Its original native owner is preserved, including an owner different from the board project's native project. Workspace ID remains unique across all cards, including archived cards.
- No new project repo list, task repo picker, workspace source picker, or repository filter appears in the UI. The project root is shown explicitly. Tool/skill context for a new card contains that root (or its external worktree checkout) as the working directory; it does not suggest extra sibling repositories.
- Card business status, sessions, tools, receipts and human completion policy stay as specified in Phase 2.

## Existing data and compatibility

Board storage remains version 3. The existing `projects[].repos`, `tasks[].repoPaths` and `tasks[].sourcePath` fields are retained internally so a reload does not rewrite or discard previously created projects, cards, workspaces, activities or agent receipts. New project records have `repos=[primaryPath]`; new card records have `repoPaths=[primaryPath]` and `sourcePath=primaryPath`.

For an existing project with multiple stored `repos`, that list is a **read-only legacy snapshot**, not an editable feature. Existing cards keep their stored scopes and workspace links. A legacy card with `repoPaths=[]` continues to resolve against that project's stored legacy list, preserving earlier all-repo behavior. Existing selected-scope cards keep their selections. Their scope is displayed read-only as legacy; the user can edit title/description/priority/status/archive, and Agent tools continue to check the saved scope and both revisions. New cards created in the same old project use only its native root. No directory is moved, no native owner is changed, and no task is automatically rebound.

The new project/task write RPCs reject deprecated `repos`, `repoPaths` and `sourcePath` input rather than silently accepting an old multi-repo form. Existing data remains readable. Archiving/restoring a legacy card is supported. No automatic conversion of an old multi-repo native project into a new common parent is possible because Paseo project identity and workspace ownership must be preserved; the user can create a separate native project rooted at the chosen common directory when desired.

## Server and UI behavior

1. Canonicalize the native root; create or link the native Paseo project at that exact root. Persist a single-root `repos` value for new records, retaining old values only on old records.
2. On a new task, ignore neither extra input nor stale expectations: schema-reject deprecated repository/source fields; use the root for new workspace provisioning. The selected existing workspace must match **the root**, not a secondary legacy directory. Existing old cards can continue using their old workspace.
3. Keep project root and legacy repo list immutable through the board edit RPC. Reject a reused native project binding and duplicate workspace binding as before.
4. Replace project/task repository controls and board repository filter with root display and a read-only legacy scope indication. For a common-directory project, explain that worktree isolation requires the root itself to be Git.
5. For new cards, the Agent sees one root/checkout mapping. For legacy cards, it still sees the stored directories and the UI marks them as legacy. Tool authorization remains bound to actual card/workspace/agent IDs and current versions.

## Verification

- Typecheck, full tests and skill validation; targeted tests cover new one-root project creation, rejection of deprecated API fields/secondary workspace source, common-parent directory workspace, worktree root behavior, legacy card read/write preservation and unchanged v3 bytes on read.
- Reload the existing plugin only after typecheck. Use an explicitly `codex/gpt-6-luna` full-access Paseo test session and isolated fixture directories for live project/card/workspace/context checks; preserve all existing resources and data.
- UI checks operate only on the user's non-fullscreen Paseo window if CUA can identify it unambiguously. Otherwise record UI as unverified and continue non-UI checks. Do not touch the fullscreen window or treat old screenshots as current proof.
- Record PASS/PARTIAL/UNRUN separately in `docs/verification/single-root.md`. Stop after this amendment for user review.
