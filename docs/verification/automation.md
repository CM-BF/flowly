# Agent automation — verification (2026-10-22)

Spec: [AUTOMATION-SPEC.md](../AUTOMATION-SPEC.md). Implementation session `5ef567f0-6312-4d90-849c-c24d82795183` (Claude Opus 5.5), branch `sw/flowly-automation`.

Method (open-paseo-plugins/AGENTS.md): installed on the user's own daemon (`127.0.0.1:6767`, server `srv_BSheQn5lzdEE`, Paseo 0.12.0) from the local repository by git ref (`paseo plugin install file:///…/flowly --ref sw/flowly-automation --id flowly`, later `paseo plugin update flowly --ref sw/flowly-automation`), and driven through the real web UI at `app.paseo.sh` in Paseo's in-app browser. The page URL carried the daemon's server id. Screenshots in [automation/](automation/) were taken with `docs/promo/shot-lib.mjs` (`playwright-core` from a temporary folder, the system Chrome as `PLAYWRIGHT_CHROMIUM_PATH`), except 06–07, which are phone-width (430 pt) captures from the in-app browser, where the host sidebar is not shown.

## Passed

- `npm run typecheck`; `npm test`: 115 files passed, 13 skipped; 927 tests passed, 65 skipped (skips pre-existing).
- Focused tests: `shared/automation.test.ts` (8) and `server/automation.test.ts` (12) as listed in the spec §8; tool list (`flowly_submit_review`); tip order (`agent-automation`); nine catalogs.
- Live, fixture project `plugin-test-2026-10-22 automation` (git repo with `calc.js`/`test.js`; implementer Claude Haiku 4.5, reviewer Codex GPT-6-Luna low, 2 slots, 2 review rounds):
  1. **Settings** (Edit project → Agent automation): toggle, slots, implementer and reviewer models, review rounds, full access; saved as entered ([05](automation/05-project-settings.png)).
  2. **Dependencies**: card B (*multiply*) linked *Blocked by* card A (*subtract*). *Run with agent* on B (drawer button) → *Queued for agent*, *Waiting on 1*, no session. *Run with agent* on A (card ⋯ sheet) → claimed and a session created within 0.1 s.
  3. **Unattended session**: A's session `a34a8a63` ran in A's own worktree as `claude-haiku-4-5`, mode `bypassPermissions`, first message `[Flowly automation] …`, used the Flowly MCP tools, set tags/workpad/stage itself and delivered to In review. Card showed *Agent working*.
  4. **Review approve**: on delivery, review round 1 started in a Codex session (`gpt-6-luna`, `full-access`), the card **stayed In review** when the reviewer started (no A1 move), the reviewer called `flowly_submit_review(approve)`; card shows *Agent review passed*, drawer the reviewer's summary and *Review round 1 of 2*.
  5. **Release on Done**: moving A to Done (wrap-up declined) released B; B ran, was reviewed and approved the same way.
  6. **Review changes** (card D, a fixture rule told the reviewer to request changes in round 1): delivered → round 1 `changes` → card moved In review → Development (`rule=REVIEW`), findings sent to the implementer → implementer committed the fix and delivered again → round 2 in the same reviewer session → approved ([02](automation/02-drawer-review-changes-then-approved.png), [03](automation/03-activity-review-loop.png)). The fixture repo held both commits.
  7. **Reminders and give-up** (card C, told to stay silent): turn ended without a delivery → *Reminder 1 of 2* → *Reminder 2 of 2* → *Agent automation gave up* and the card moved Todo → Blocked (`rule=AUTO`) ([04](automation/04-drawer-gave-up-after-reminders.png)).
  8. **Stop / Run again**: *Stop* on a live job → *Automation stopped · Stopped by you*; *Run again* reused the implementer session (generation 2 and 3, *queued this card again* message).
  9. **Plugin reload mid-turn**: B re-run, `paseo plugin reload flowly` while its agent was running; the turn ended 5 s later and the new plugin instance handled it (review started, approved).
  10. Board and phone layout ([01](automation/01-board-outcomes.png), [06](automation/06-compact-board.png), [07](automation/07-compact-drawer.png)).

## Found and fixed during the live test

- **New project failed on this daemon** with `spawn paseo ENOENT`: the desktop-managed daemon has no `paseo` on PATH. Project create/delete now use the app-bundled CLI resolver that session settings already used (`server/paseo-cli.ts`). Pre-existing, not automation.
- **Done did not release blocked cards at once**: a move of a card without a job of its own did not run the dispatcher, so B waited for the next 15 s pass. Any card move now runs it (regression test added).
- **Run again on a card automation had blocked waited instead of reminding**: rule A1r restored Blocked after a silent turn, and automation read it as the agent blocking itself. Only a Blocked the agent set in that turn waits now (test added; re-verified live: two reminders, then give-up).
- While fixing the first item, the two existing tests that stubbed `execFile("paseo", …)` stopped intercepting the resolved path for one run and created 8 native projects (*Shop-Stack*, *Edit*) in the daemon; the stubs now match the resolved path and the 8 projects were deleted with `paseo project delete`.

## Not verified (UNRUN)

- A failed turn and its retry with backoff on a real provider (no provider failure occurred; covered by `server/automation.test.ts`).
- Waiting on a permission (full access was on) and a provider without an unattended mode.
- A hook missed during a daemon restart (the reconcile path is covered by a unit test; live, only a plugin reload mid-turn was tried).
- Slots under contention with more ready cards than slots (only unit-tested; live runs never had more than two ready cards).
- Phones (Android device) and the Codex CLI path (`review` API action has no CLI command; automation sessions always get MCP).

## Cleanup

All fixture resources were created by this test and removed: the 4 cards via *Delete permanently* with *Archive* (8 sessions archived: implementers `a34a8a63`, `82c43238`, `2e1261cd`, `96c79d2a`, reviewers `38b8e155`, `6e71a280`, `1bfdea0d`, `e8a6816e`; Paseo removed the 4 worktrees), the project via *Remove* → *Also remove from Paseo* (`prj_20c44473d3d37c23` gone from `paseo project ls`), the fixture folder, the empty worktree folder, the board's `removed/` backups of the fixtures and their 8 session preparation files. The user's *Better Kanban* project and its two cards are unchanged; `board.json` holds no automation job.
