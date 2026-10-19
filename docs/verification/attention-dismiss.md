# Verification: attention dismiss (ATTENTION-DISMISS-SPEC)

Date: 2026-10-19. Session: 67ac7b82-3403-4dff-a132-e5c353dd4706 (Claude, implementation session; not a Luna test session).

## PASS

- `npm run typecheck`.
- `npm test`: 577 passed / 63 skipped. New: `client/attention-dismiss.test.ts` (signal keys; subset hides; new turn / question / request / error brings the card back; fewer signals keep it hidden; read-unavailable), `server/attention-dismiss.test.ts` (idempotent dismiss/restore without revision or Activity, byte-identical repeats, archived/unknown/invalid rejected, card delete drops the record, older board.json reads as none), `client/onboarding-logic.test.ts` (tip `attention-dismiss` order), i18n catalog check.
- `paseo plugin reload flowly`: running, clean logs.
- Headless app.paseo.sh web client on the local daemon, own browser profile (the user's two Paseo windows untouched), dark scheme. Tinylink fixture card *Expired links crash the server…*, which the user had already dismissed at 09:29.
  - Desktop 1700×1000: card shows **Needs you** + **Dismissed**; bell and sidebar badge exclude it; Attention dropdown lists it under *Dismissed · 1*. [01-board](attention-dismiss/01-board.png), [02-attention](attention-dismiss/02-attention.png), [03-dismissed-expanded](attention-dismiss/03-dismissed-expanded.png)
  - Restore: the card returns to the main list (1 question), the overview chip *1 needs you* reappears, the card loses the Dismissed marker. [04-restored](attention-dismiss/04-restored.png)
  - Dismiss again from the row button: it moves to *Dismissed · 1*, the chip disappears, bell and sidebar badge drop by one, the card keeps Needs you + Dismissed. [05-dismissed-again](attention-dismiss/05-dismissed-again.png)
  - Drawer: notice "Dismissed from Attention. It comes back when something new happens." with Restore; the question and Reply are unchanged. [06-drawer](attention-dismiss/06-drawer.png)
  - Compact 430×900: the Needs attention sheet shows the empty state "Nothing new needs your attention." and the Dismissed section with a Restore button. [07-compact-board](attention-dismiss/07-compact-board.png), [08-compact-sheet](attention-dismiss/08-compact-sheet.png)
  - No page errors.
- Fixture state: the Tinylink record ends with the same signal (`q:f6a158fa…`) as before; only `dismissedAt` changed (re-dismissed by the test). No other card, project or session was changed.

## UNRUN

- Re-surfacing by a real new agent turn in the live UI (covered by unit tests only).
- Native iOS/Android rendering; the user's own desktop windows (not driven).
- Luna 6 test session.
