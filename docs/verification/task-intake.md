# Single task input: live verification (in progress)

Date: 2026-10-22 (local). Host: `srv_BSheQn5lzdEE`, Paseo `0.12.0`, `127.0.0.1:6767`. Real `https://app.paseo.sh` with headless local Chrome; screenshots through `docs/promo/shot-lib.mjs`, host sidebar and unrelated tabs excluded.

## Installation

Installed `856c8718a57f2c3f6a4481eb84c06c2204364108` from `file:///Users/citrine/Projects/flowly-kanban/flowly` into Paseo's managed checkout `~/.paseo/plugins/flowly/e2e460f9-fc8e-4b3b-9e3c-9540312a5c9f/checkout`. Status running; no startup error. The replacement was gated on all user Flowly jobs/card sessions being idle. Original data and install record: `~/.paseo/backups/flowly-2026-10-22-before-task-intake/`.

Live testing found missing metadata organization; fix `dc5a75c` is committed and typechecked, with 990 tests passed / 65 existing skipped. Its installation is pending while a new nonfixture job runs. A second idle notification was rechecked and correctly refused after the next user task had already started; the monitor now requires two minutes of sustained idle before notifying. No daemon restart.

## Observed passes

- Project settings exposes provider modes and Speed Normal/Fast. Save then reopen/read persisted configuration verified Codex Luna, low reasoning, Full Access, Normal.
- Desktop new-card form has one Task textbox. It starts an agent by default. Original brief was preserved byte-for-byte and the direct session implemented the requested greeting helper, tested two names (including Chinese), committed `ccb10aa`, and delivered In review.
- Real direct session runtime: `codex/gpt-6-luna`, low, full-access; feature `service_tier=default` confirmed from its daemon snapshot.
- A separate parked card was created with agent off. The next new card again offered Create and start. Compact 430×932 form likewise defaults on; expanding and collapsing More options preserves the typed draft. Draft was cancelled.
- Project Fast (`service_tier=priority`) and a separate automation implementer override Normal (`default`), Full Access and low reasoning saved. No reviewer configured. Actual automated launch of this combination remains pending.

## Failure found and fixed in source

The first real agent set type/tags/workpad and delivered without using `flowly_update_metadata`; the long preview title and raw description remained. The fix adds metadata to existing setup context, reminders and delivery checks for brief-bearing cards. Original-value confirmation counts, partial updates do not; actual human edits are respected. The existing explicit `acknowledgeOpen` exception remains. Offline regression tests pass; fresh-agent retest is pending installation.

The fixture is nested inside the synthetic project directory. New in directory is rejected by that plugin's existing workspace-creation guard; fixture cards use New isolated worktree instead. This is not evidence that arbitrary nested directories are accepted as synthetic roots.

## Evidence

- [Project settings](task-intake/01-project-settings.png)
- [Single input](task-intake/02-single-input.png)
- [Compact input](task-intake/03-compact-input.png)
- [Compact options](task-intake/04-compact-options.png)
- [Automation execution settings](task-intake/05-automation-settings.png)
- [Full-access Luna source review](task-intake-luna.md)

## Fixture inventory and remaining work

Project `8114344c-ee0c-4980-83a1-28d9aecbb018`, native `prj_2b64e8ebb4b655dd`, title `plugin-test-2026-10-22-intake`. Root: `/Users/citrine/Projects/flowly-kanban/.fixtures/plugin-test-2026-10-22-intake`.

- Direct card `8f41143a-b50c-48a2-b504-083e343c34da`, workspace `wks_f9a434444242dc85`, session `ae87af0e-e2e3-45ff-a57b-e3b7087ae410` (idle, completed).
- Parked card `d168019d-6bb7-4d98-85b7-2ffa4ecc19a3`, no agent.
- Read-only review session `9294a850-8b3d-4c55-8602-62a8411fb61b` is archived.
- Archived fixture inventory and reusable driver: `/tmp/flowly-intake-run/`.

UNRUN: corrected metadata flow on a fresh real agent; automated image delivery/launch override; physical Android. Initial fixture cleanup completed: both cards deleted through the UI, session archived, both worktrees removed, project absent from both native Paseo and Flowly, exact-owned preparation/removed-record backups and fixture root deleted. Remaining tests will create a fresh fixture. User projects and sessions are untouched.
