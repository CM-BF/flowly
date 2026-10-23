# Task intake Luna verification

- Session ID: `9294a850-8b3d-4c55-8602-62a8411fb61b`
- Scope: read-only source review and unit fixtures; no implementation edits, commits, daemon operations, real CLI calls, or user data changes.
- Source: `6aa9b06` plus the existing uncommitted Flowly task-intake diff.
- Spec reviewed: `docs/TASK-INTAKE-SPEC.md`.

## Results

- `npm run typecheck`: passed (`tsc --noEmit`).
- Focused Vitest command on `shared/task-intake.test.ts`, `server/metadata.test.ts`, `server/automation.test.ts`, `client/session.test.ts`, and `server/tool-server.test.ts`: **38 passed, 2 failed, 40 total** across 5 files.
- The task-draft tests confirm the full multiline brief remains in both initial description and `brief`, while a bounded first-nonempty-line preview supplies the title.
- Metadata tests confirm a successful update leaves `brief` intact, creates one event/revision, replays once, rejects request-ID reuse and stale revisions, and blocks finished cards/reviewer writes.
- Automation tests confirm Fast=false, explicit provider default, launch images and client message ID reach the initial session, images are absent from board storage, and an identical launch replays without creating a second session.
- Source inspection confirms launch payloads are schema-parsed into a separate `automation-launches/<sha256>.json` file, written with mode `0600` under a directory created with mode `0700`; the board stores only the reference key and collection removes consumed/orphaned/aged files. This verifies the code path, not filesystem permissions or crash recovery on the live daemon.
- The new-card form uses one required Task field, defaults to starting an agent, uses the same brief as the first instruction, keeps images alongside that launch, and puts workspace/status/priority/type/tags and the opt-out behind More options. Project model settings expose permissions and speed; direct and queued launches propagate mode and feature values.

## Failures

Both failures are in `server/automation.test.ts` and concern exact expected argument objects in legacy follow-up send assertions:

1. `busy sessions defer the exact instruction instead of interrupting a running turn` expected `{ agentId, text }`; received also `messageId` and `images: undefined`.
2. `transient refresh errors retry the same session and payload without creating a replacement` has the same shape mismatch.

The implementation now supplies the stable message ID and optional image field to `send()`. These assertions need to account for the added fields; this run does not show a changed message body or a duplicate send. The suite therefore remains red until those expectations are reconciled.

## Not verified

No live daemon install/reload, app.paseo.sh UI path, real agent organization, refresh persistence, narrow layout, automation queue lifecycle on the daemon, or actual on-disk privacy/recovery behavior was exercised. Root owns those checks and fixture cleanup.

## Root follow-up after the Luna run

The two exact-object assertions now include the stable message identity. Typecheck and the final full suite passed: 988 passed, 65 pre-existing skipped (135 files, 122 passed and 13 skipped). Added isolated filesystem coverage for private payload permissions, ownership, missing files and consumption/deletion cleanup, plus a first-turn-before-create-return regression. Live checks remain pending until the user's active Flowly work settles.
