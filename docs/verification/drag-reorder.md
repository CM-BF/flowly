# F3 drag reorder — verification (2026-10-15)

Spec: [DRAG-REORDER-SPEC.md](../DRAG-REORDER-SPEC.md). Branch `feat/drag-reorder` (worktree). Code-level verification only; the plugin was not installed or reloaded, by instruction.

## PASS

- `npm run typecheck` — PASS.
- `npm test` — 18 files / 110 tests passed; 60 renderer-only tests skipped (no renderer in the default environment).
- `server/place.test.ts` (10): slot midpoint/ends/equal-neighbor; same-column reorder = one board write, only moved card's position/revision/updatedAt change, other cards untouched, no event; cross-column = status+position in one write with `status_changed`; append/empty column; current-slot drop writes nothing (file bytes unchanged); stale revision, self/foreign/other-status/missing anchors rejected without writing; archived card/project rejected; concurrent same-revision drops commit once; equal positions normalized without touching other revisions; schema rejects two anchors.
- `client/geometry.test.ts` (12): midline slot hit testing, first/last/empty column, dragged card excluded, window→content conversion with scroll, no-op/outside drops return null, anchors and captured revision, cross-column fallback to column end. Existing column/edge-scroll tests unchanged.
- `server/service.test.ts` new case: a created card appends after reordered (fractional) positions.
- `docs/verification/fixtures/drag-reorder/columns-drag.test.tsx` (4, run with `DRAG_REORDER_RENDERER=<temp react-test-renderer 19.1.0>`): `DesktopColumns` shows the insertion line only for an effective slot, ghost copy, single anchored `onDrop`, no write for current slot / outside board / cancel-then-release, cross-column anchor, vertical scroll participates.

## Pre-existing, not caused by this change

- With all legacy renderer env vars set, `docs/verification/fixtures` has 45 failing renderer checks; an export of the base commit `6c05374` fails the same 45 (stale `client/ui` mocks lacking `space`/`radius` etc.). `card-responder.test.tsx` expected payload was updated for the new `beforeId/afterId` fields.

## UNRUN

- Actual desktop UI (line appearance in light/dark, drag feel, horizontal edge-scroll during reorder, error banner on a real conflict) — needs plugin install/reload, which this card forbids. Touch/compact layouts are unchanged in code (no responder installed) but not exercised on a device.
- No Luna session, no Paseo resources created.
