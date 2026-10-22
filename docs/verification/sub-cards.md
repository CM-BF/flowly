# Agent-created cards and sub-cards — verification (2026-10-22)

Spec: [SUB-CARDS-SPEC.md](../SUB-CARDS-SPEC.md). Implementation session `5ef567f0-6312-4d90-849c-c24d82795183` (Claude Opus 5.5), branch `sw/flowly-automation`.

Method as in [automation.md](automation.md) (open-paseo-plugins/AGENTS.md): the user's own daemon (`127.0.0.1:6767`, server `srv_BSheQn5lzdEE`), Flowly installed from the local repository by git ref (`paseo plugin update flowly --ref sw/flowly-automation`; the live run below used `a5c467a`, the fixes found in it were checked on `9647e4c` and `905907d`), driven and checked through the web UI at `app.paseo.sh`. Screenshots in [sub-cards/](sub-cards/) were taken with `docs/promo/shot-lib.mjs` (`playwright-core` from a temporary folder, the system Chrome).

## Passed

- `npm run typecheck`; `npm test`: 116 files passed, 13 skipped; 934 tests passed, 65 skipped (skips pre-existing).
- Focused tests: `server/sub-cards.test.ts` (6) as listed in the spec §7; tool list (`flowly_create_card`, `flowly_update_card`); tip order (`sub-cards`); nine catalogs; skill copy identical to `server/skill-source.ts`.
- Live, fixture project `plugin-test-2026-10-22 subcards` (git repo with an empty `test/smoke.test.js`; automation on, implementer Claude Haiku 4.5, no reviewer, 2 slots). One card created by hand, *String helpers: capitalize and reverse*, told to split itself into two sub-cards, then *Run with agent*:
  1. **Agent creates sub-cards**: the parent's session `bc99dd6a` set tags/workpad/stage and called `flowly_create_card` twice. Each sub-card got its own worktree (`kanban/string-helper-capitalize-function-596010`, `kanban/string-helper-reverse-function-337b06`), the *Sub-card of* link and the `created`/`linked` events with the agent as actor in the same write, `createdByAgent` pointing to the parent, Todo, and was queued for automation (`automation_queued` by the agent).
  2. **Parent waits without a slot**: the parent ended its turn → `automation_waiting` (*Waiting for 2 sub-cards*). With 2 slots, the first sub-card had taken the second slot at 09:24:52; the second sub-card stayed queued until the parent went to waiting at 09:25:36 and started in the same pass.
  3. **Sub-cards run**: both sub-card sessions (`752c1b93`, `00c4ee7a`, Haiku, bypassPermissions) implemented their file and test, committed and delivered to In review.
  4. **Parent woken once**: when the second delivered, `automation_woken` (*Its sub-cards settled*) and one `[Flowly automation]` message listing both sub-cards with lane, automation state, branch and worktree directory.
  5. **Parent integrates and accepts**: it merged both branches (one fast-forward, one merge commit), added `index.js`, ran every test (pass, recorded as a workpad check at `308d086`), accepted both sub-cards with `flowly_update_card action=accept` (In review → Done, actor agent, `Accepted by the parent card …`), then delivered itself to In review. Top-level Done stayed with the user.
  6. **Message after delivery**: a later message to the delivered parent's session moved the card In review → Development (A1) and resumed the job (`automation_resumed`); the turn reported no work, so A1r restored In review and automation marked it delivered again, without a reminder.
  7. **UI**: the parent card shows *Sub-cards 2/2*, the sub-cards are in Done, the *sub-cards* tip appeared ([01](sub-cards/01-board-parent-and-sub-cards.png)); the parent drawer's Links has a *Sub-cards* group with both cards and their lanes ([02](sub-cards/02-parent-drawer-sub-cards.png)); a sub-card's drawer has *Sub-card of* with the parent ([03](sub-cards/03-sub-card-drawer.png)).

## Found and fixed during the live test

- **One request, two cards**: the parent's agent issued both `flowly_create_card` calls in parallel with the same signed request. Creation was keyed on the request alone, so the second call got the first card back as `replayed` (the agent noticed, read the task again and created the second card); had both calls passed the replay check at once, the second would have been reported as newly created. A request is now claimed before the first await and its parameters are part of the operation id: the same call again returns the same card, other parameters get `REQUEST_REUSED` like every other write (test added, red on the old code).
- **A Done sub-card read "Delivered; your review"**: a delivered job stays delivered when the card is accepted, so the drawer still asked for a review. Finished cards show no signal for a job that is not live, and the drawer reads *Finished* ([03](sub-cards/03-sub-card-drawer.png), taken after the fix).
- Two automation tests slept a fixed 20 ms for background work and failed 4 of 5 runs under load; they now wait for the result.

## Not verified (UNRUN)

- The `REQUEST_REUSED` fix on the daemon: the probe asked the parent's session (through Paseo's agent messaging, on `905907d`) to make two parallel `flowly_create_card` calls with one request; the agent called `flowly_get_task`, then refused the rest as a possible prompt injection because the message came from another agent, not the user. Not pushed further; the unit test covers both orders (sequential and overlapping).
- `start=later` and `flowly_update_card action=start`/`cancel` live (unit-tested); a sub-card that fails or is blocked while its parent waits (the wake message carries it; unit-tested only through the settled case).
- `blockedBy` between sub-cards live (the dispatcher path is the one verified in [automation.md](automation.md); the link is written by the same create call, unit-tested).
- Sub-cards of a sub-card (depth limits are unit-tested), the 20-per-parent and 50-per-card limits.
- *New sub-card* from the card menu, the action sheet and the drawer's Links menu (the form path is a regular card creation with a link; no live click-through).
- A parent without automation (a person starts the sub-cards; no wake message) and a non-git project (directory workspaces).
- Phones (Android device), and the CLI path (`create-card`/`update-card` have no CLI commands; MCP only).

## Cleanup

All fixture resources were created by this test and removed: the 3 cards via *Delete permanently* with *Archive* (3 sessions archived: parent `bc99dd6a`, sub-cards `752c1b93`, `00c4ee7a`; Paseo removed the 3 worktrees), the project via *Remove* → *Also remove from Paseo* (`prj_91d1e7d309f833ca` gone from `paseo project ls`), the fixture folder and its parent `.fixtures`, the empty worktree folder, the board's `removed/` backups of the fixtures and their 3 session preparation files. The user's *Better Kanban* project and its two cards are unchanged; `board.json` holds no automation job. Another agent's project (`plugin-test-2026-10-22-dwf`) and an empty worktree folder created during the test by something else were left alone.
