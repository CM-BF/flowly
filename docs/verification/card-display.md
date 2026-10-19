# Verification: card display (CARD-DISPLAY-SPEC)

Date: 2026-10-19. Session: 82a329b1-9730-47f5-84b5-cbffa85470c5 (Claude, implementation session; not a Luna test session).

## PASS

- `npm run typecheck`.
- `npm test`: 526 passed / 63 skipped. New: `shared/card-display.test.ts` (visibility, unknown ids kept, activity modes), `shared/settings.test.ts` (defaults; a bad `cardActivity`/`cardHidden` falls back alone and keeps `boardSort`), `client/onboarding-logic.test.ts` (tip `card-display` order). One full run hit a 5 s timeout in `server/tool-server.test.ts` (CLI flow; unrelated, passes alone and on the next full run).
- Plugin reloaded (`paseo plugin reload flowly`, status running). Headless app.paseo.sh web client on the local daemon, own browser profile, 1700×950 dark; the user's windows untouched. Tinylink fixture, read only. No page errors.
  - Board: meta row (Urgent/High coloured, type, `#tags`), title, one activity line, status row. Tip `card-display` shows (6 cards). [board.png](card-display/board.png)
  - Sort menu → *Card display…* opens Settings on Cards. Preview renders through `TaskCard`.
  - Tags off + Activity *Both*: the preview and the board behind drop the tags and show the output line under the summary. [settings-cards.png](card-display/settings-cards.png)
  - *Reset to defaults* restored the host setting (all switches on, Activity auto; board back to one activity line, tags back) — the user's setting is left as before the test.

## UNRUN

- Compact phone layout and native (iOS/Android) rendering.
- Luna 6 test session.
