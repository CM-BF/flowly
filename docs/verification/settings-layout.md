# Settings layout verification (2026-10-16)

Method: headless Chromium (Playwright), isolated context, `local-network-access` granted only to `https://app.paseo.sh`, against the running daemon after `paseo plugin reload`. No native Paseo window was used. Screenshots: `docs/promo/screenshots/settings/`.

Completed: typecheck and `npm test` pass; four sections render and switch (light, dark); Japanese labels and long text wrap without overflow; the narrow layout was checked by temporarily raising the width threshold (German, long labels such as "KI-Zusammenfassungen") and then restored; no page errors.

Unrun: a real phone/tablet (touch targets, native `ScrollView` strip), a window shorter than ~560 px, the language picker's open dropdown inside the narrower column.

## Wider window (same day)

The host Modal cannot be widened (fixed ≈ 520 px, clips wider content), so the settings use their own `Modal` window up to 900 px wide. Checked headlessly: opens from the settings button, closes with Esc, with a click on the backdrop and with the close button, sections switch, dark theme renders, no page errors. Unrun: Android back button (`onRequestClose`), focus trapping/keyboard navigation inside the window (the host Modal provides this; the custom window does not), native iOS/Android rendering.
