# Single task input: live verification

Dates: 2026-10-22 (first pass, `856c871`) and 2026-10-23 (retest, `43efb13`), local time. Host: `srv_BSheQn5lzdEE`, Paseo `0.12.0`, `127.0.0.1:6767`. Real `https://app.paseo.sh` with headless local Chrome; screenshots through `docs/promo/shot-lib.mjs`, host sidebar and unrelated tabs excluded.

## Installation

First pass: installed `856c8718a57f2c3f6a4481eb84c06c2204364108` from `file:///Users/citrine/Projects/flowly-kanban/flowly` into Paseo's managed checkout `~/.paseo/plugins/flowly/e2e460f9-fc8e-4b3b-9e3c-9540312a5c9f/checkout`. Status running; no startup error. The replacement was gated on all user Flowly jobs/card sessions being idle. Original data and install record: `~/.paseo/backups/flowly-2026-10-22-before-task-intake/`.

Live testing found missing metadata organization; fix `dc5a75c` followed. Its installation waited for the user's own Flowly pipeline (Next Workspace C3–C5) to stay idle for two minutes; earlier idle notifications were rechecked and refused when the next user task had already started.

Retest: on 2026-10-23 02:53, after an immediate recheck, the daemon was updated with `paseo plugin update flowly --ref 43efb13c5ed28f483a91e018787599bedbb16233`, the commit validated for automation review round 3 ([record](automation-review-round3.md)), which contains `dc5a75c`. Managed checkout `~/.paseo/plugins/flowly/bb1cb648-f352-4796-8820-5d8a240ecfbf/checkout`, status running, no startup error, no daemon restart. Backup of the data, settings and previous source (`856c871`): `~/.paseo/backups/flowly-2026-10-23-before-round3/`.

## Observed passes (first pass, `856c871`)

- Project settings exposes provider modes and Speed Normal/Fast. Save then reopen/read persisted configuration verified Codex Luna, low reasoning, Full Access, Normal.
- Desktop new-card form has one Task textbox. It starts an agent by default. Original brief was preserved byte-for-byte and the direct session implemented the requested greeting helper, tested two names (including Chinese), committed `ccb10aa`, and delivered In review.
- Real direct session runtime: `codex/gpt-6-luna`, low, full-access; feature `service_tier=default` confirmed from its daemon snapshot.
- A separate parked card was created with agent off. The next new card again offered Create and start. Compact 430×932 form likewise defaults on; expanding and collapsing More options preserves the typed draft. Draft was cancelled.
- Project Fast (`service_tier=priority`) and a separate automation implementer override Normal (`default`), Full Access and low reasoning saved.

## Failure found and fixed in source

The first real agent set type/tags/workpad and delivered without using `flowly_update_metadata`; the long preview title and raw description remained. The fix (`dc5a75c`) adds metadata to existing setup context, reminders and delivery checks for brief-bearing cards. Original-value confirmation counts, partial updates do not; actual human edits are respected. The existing explicit `acknowledgeOpen` exception remains.

## Retest on `43efb13` (2026-10-23)

| Scenario | Result | Evidence |
| --- | --- | --- |
| Project created through the UI on a fresh git root outside the synthetic workspace; default model Codex GPT-6-Luna, low, Full Access, Normal saved | PASS | `06-retest-project-settings.png` |
| Direct agent (automation off), the greeting brief typed once | PASS. The first instruction carried "Card setup missing: metadata, type, tags, workpad" with the `flowly_update_metadata` instruction. 20 s after its turn started the agent recorded "Organized card: title", then type `feature`, tag `greeting` and a workpad, and only then moved to Development. `intakeOrganized=true`; the brief was kept and, being already faithful, confirmed as the description. Title "Add greeting helper and tests". Commit `9bb2f91`; `node test.js` passes in its worktree. Session `764d6fac`: codex/gpt-6-luna, low, `full-access`, `service_tier=default`. A summarizer child session was hard-deleted afterwards, as designed. | `07-retest-direct-input.png`, `11-retest-direct-organized.png` |
| Automation on: project Fast, implementer explicitly Normal + Full Access, Codex GPT-6-Luna low reviewer without its own speed, 2 review rounds, 2 cards at once | PASS, persisted exactly | `08-retest-automation-settings.png`, `10-retest-reviewer-settings.png` |
| Automated image card: one brief plus `color.png` (solid red) attached through Add images | PASS. Queued and claimed in the same second; the agent organized title "Identify the image's dominant color" (type `docs`, tag `image-color`) and wrote "Red. The image is uniformly filled with a bright red color." without using the filename. Launch overrides reached the real sessions: implementer `0a8e32f1` `service_tier=default` (its explicit Normal beats the project's Fast), reviewer `d647a13b` `service_tier=priority` (inherits the project's Fast); both `full-access`, labels `flowly-automation=implementer/reviewer`. | `09-retest-image-input.png`, `14-retest-image-card-reviewed.png` |
| Reviewer changes and rework | PASS. Round 1 of 2 requested the line the brief asked the reviewer to require; the card moved In review → Development ("The reviewer requested changes"), the implementer added it (`685ca25`) and redelivered, round 2 approved: "Agent review passed · Review round 2 of 2". | `14-retest-image-card-reviewed.png`, `16-retest-compact-reviewed-drawer.png` (430 px) |

The other live automation paths on the same fixture (Stop, Run again with session reuse, blocker reasons, project automation off/on) are recorded in [automation-review-round3.md](automation-review-round3.md#live-acceptance-on-43efb13).

The fixture is outside the synthetic project directory this time, so its root is an ordinary native project root; cards still used New isolated worktree.

## Evidence

- First pass: [Project settings](task-intake/01-project-settings.png), [Single input](task-intake/02-single-input.png), [Compact input](task-intake/03-compact-input.png), [Compact options](task-intake/04-compact-options.png), [Automation execution settings](task-intake/05-automation-settings.png), [Full-access Luna source review](task-intake-luna.md)
- Retest: `task-intake/06-…` to `16-…` (named per scenario above)

## Fixtures and cleanup

First pass: project `8114344c-ee0c-4980-83a1-28d9aecbb018`, native `prj_2b64e8ebb4b655dd`, root `/Users/citrine/Projects/flowly-kanban/.fixtures/plugin-test-2026-10-22-intake`; direct card `8f41143a…`, parked card `d168019d…`, session `ae87af0e…`, review session `9294a850…`. Cleaned up on 2026-10-22: cards deleted through the UI, sessions archived, worktrees removed, project removed from Flowly and Paseo, fixture root and exact-owned preparation/removed-record files deleted.

Retest: project `04529bcb-fcaa-4fd7-8f09-09b31099d148`, native `prj_d9e5bb888d0d5b9d`, title `plugin-test-2026-10-22-intake-retest`, root `/Users/citrine/Projects/plugin-test-flowly-intake-retest`, worktrees under `~/.paseo/worktrees/009yz0fg`. Cards `fdd13fa7` (direct), `b7920df8` (image), `793023f7` (Stop/Run again), `c8a1209f` (blocker Y), `6828733f` (held X). Sessions `764d6fac`, `0a8e32f1`, `d647a13b`, `a402bc62`, `d0b35cb0`, `f26b01ca`, plus summarizer child `d8b86ed1` (hard-deleted by Flowly). Cleanup on 2026-10-23 03:05–03:07: all five cards deleted through the UI with Archive and delete; all six sessions archived; project removed with "Remove from board and Paseo"; the native project list equals the pre-test list (8); the board holds only the user's two projects; the 23 exact-owned `removed/` and `preparations/` files, the fixture root and the empty worktree folder deleted. Flowly's rolling `*.bak` files and its per-session `artifact-reads.json` timestamps (two entries for the deleted sessions, a map that predates this work and is never pruned) were left to the plugin. User projects and sessions were not touched.

UNRUN: physical Android.
