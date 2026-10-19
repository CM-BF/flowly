# Verification: card sidebar tweaks (DRAWER-SPEC, Section order and Artifacts paging)

Date: 2026-10-19. Session: 82ea8335-9348-4ab6-a64e-953f8bba84d9 (Claude, implementation session; not a Luna test session). Base `7a4562d` + uncommitted changes.

## PASS

- `npm run typecheck`.
- `npm test`: 583 passed / 63 skipped (85 files). New `shared/drawer-sections.test.ts` (default, stored order, unknown/duplicate ids, missing ids placed after their default predecessor, move keeps unknown ids); `shared/settings.test.ts` (`drawerOrder` default and invalid value); `client/onboarding-logic.test.ts` (`sidebar-order` after `card-display`); i18n catalog check.
- `paseo plugin reload flowly`: running, store ready, clean logs.
- Headless app.paseo.sh web client on the local daemon, own browser profile (the user's Paseo windows untouched), dark scheme, 1700×1100. Read-only use of the existing card *harness2研究* (project Agent SMITH: 30 outputs, 7 inputs, 10 summary versions):
  - Artifacts: Outputs and Inputs each show 5 rows and *Show 5 more* / *Show 2 more*; one press shows 10 outputs in the same list at the rows' left edge, the button stays (next 5), no Show less.
  - Artifacts title with chevron collapses the whole list (count, ticket and + stay in the header; Sessions moves up) and expands it again.
  - Close side bar → reopen the card: back to 5 rows per group and expanded.
  - Progress → History: version rows start at the Progress card's left edge; an opened version's Target/Recap/Next line up with its title.
  - Settings → Cards → Card sidebar lists Progress, Workpad, Artifacts, Sessions, Ideas, Links with grips; dragging Sessions above Progress stores the order and the open card shows Sessions first (y 379 vs Progress 560). *Reset section order* restores the default; the setting was left at the default.
  - Follow-up, Workpad collapse: the Workpad title collapses the section (Acceptance group hidden) and the header shows `Acceptance 20/20 · Checks 20/20`; close and reopen the card → expanded again. Typecheck, `npm test` (583 passed / 63 skipped) and plugin reload rerun after this change.
  - The `sidebar-order` tip banner shows while the card is open. No page errors.
- Screenshots were kept outside the repo (they show the user's own card content).

## Follow-up: whole-sidebar layout (2026-10-19)

- PASS: `npm run typecheck`; `npm test` 587 passed / 63 skipped (new `drawerSectionsOpen` / `withSectionOpen` / `defaultDrawerLayout` tests, `drawerOpen` setting, i18n catalogs); `paseo plugin reload flowly` running.
- Headless web, same card *harness2研究*, before/after screenshots at 1700×1100 and 430×900 (phone, touch):
  - Before: on the phone the fixed title/properties/tags took over half the screen; Workpad showed 20 criteria, 20 checks with full multi-line commands and 10 confusions; Details/Usage/Activity used a leading chevron unlike the other sections.
  - After: phone header is the action row only, the title block scrolls away; all nine sections share one header style; Workpad shows 5 per group with *Show 5 more*, out-of-date checks first, one-line commands; Links 0 shows no chevron or empty body.
  - Settings → Cards → Card sidebar: Workpad *Starts open* off and Activity on → reopening the card shows Workpad collapsed with `Acceptance 20/20 · Checks 20/20` and Activity open; tapping Workpad expands it; *Reset sidebar layout* restores the defaults (note "The sidebar uses the default layout"). The setting was left at the default.
  - Earlier paging/collapse/reopen script rerun: PASS. No page errors.

## Follow-up: main and sub sessions (2026-10-19)

- PASS: `npm run typecheck`; `npm test` 615 passed / 63 skipped (new `sessionTree` tests: nesting, grandchildren, orphans, parent loops); HEAD plus only this card's files: 558 passed / 63 skipped; `paseo plugin reload flowly` running.
- Headless web, Tinylink card *Add rate limiting to POST /shorten* (fixture use allowed by AGENTS.md): two temporary Haiku agents created in its workspace with `paseo.parent-agent-id` = its session `402bf42e…`. The sidebar shows *Sessions 1* with `↳ 2 ready to review` under the main session, folded; tapping it shows both subagents indented. No page errors.
- Finding: `paseo agent run` from inside an agent sets the parent to the calling agent and ignores `--label paseo.parent-agent-id`; the first two fixtures therefore became children of this implementation session and correctly stayed main sessions on the Tinylink card. Recreated with `PASEO_AGENT_ID` unset.
- Cleanup: all four fixture agents (`5609b214`, `1e1b81eb`, `12f8bfd5`, `57e1dd39`) archived and deleted; `paseo agent ls --all` shows none; the Tinylink session and card are unchanged.

## UNRUN

- Native iOS/Android apps (arrow buttons instead of drag, collapse animation on native, keyboard with the tag input now inside the scroll view on phones). Phone layout was checked on mobile web only.
- Luna 6 test session.
