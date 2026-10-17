# Card tags — verification (2026-10-18)

Spec: [CARD-TAGS-SPEC.md](../CARD-TAGS-SPEC.md). Card `11122d9a`, implementation session `e11590ef-52c5-4336-a645-5941a93fa5dd`.

## Passed

- `npm run typecheck`.
- `npm test`: 68 files passed, 12 skipped; 434 tests passed, 63 skipped (skips pre-existing).
- New focused tests:
  - `shared/tags.test.ts`: normalization (case, `#`, spaces/underscores, full-width, CJK, invalid characters, 32-char limit), stored-value schema, de-duplication, add/remove rules (agent can't remove human tags, overlap, 12 limit), form three-way merge, project vocabulary ordering, OR/prefix filter, `#tag` search.
  - `server/tags.test.ts`: drawer edits only bump the board revision and record `tags_changed`; no-op writes nothing; form edit merges and bumps the card revision; `kanban_set_tags` replay, whole-call refusal on an invalid value, `TAG_FORBIDDEN`, no-op receipt without an event, task revision unchanged; `projectTags` in get_task; idea tags normalized.
  - `shared/scope.test.ts`: `Tags:` context line only when tagged.
  - `server/tool-server.test.ts`: CLI `tags --add/--remove`.
  - `client/onboarding-logic.test.ts`: `first-tag` tip order.
- i18n catalogs complete for all nine languages (`shared/i18n.test.ts`).
- Live, installed plugin (`paseo plugin reload flowly`): this card's session CLI ran `tags --add "Tags, agent-tools, search"` → three agent tags, `projectTags` returned, task revision unchanged; `--add "bad!"` → `TAG_INVALID`, exit 1.

## Rework 2026-10-18 (user: "why does removing need + first")

- Tag editor rewritten: always-visible × on every chip, trailing "+ Add tag" chip that becomes an inline input, Esc/empty blur closes it, suggestions only while open. Drawer row has no edit mode, saves optimistically, no success toast.
- `client/tag-input.tsx` no longer reads `./ui` at module load: three verification fixture suites that mock `./ui` (drawer, session-chip, session-pane) failed to import with the first version and pass again.
- typecheck and `npm test` (434 passed, 63 skipped) after the rework; plugin reloaded.

- Phone (Android) screenshot from the user: the inline tag input clipped its text (default vertical padding in a 30pt box). Fixed: 36pt touch height, `paddingVertical: 0`, `includeFontPadding: false`, 14pt text. Not re-checked on a device.

- User report: pressing Back made the chips' × (and "+ Add") vanish, reflowing the row during the close transition. Cause: the drawer passes `active=false` while closing, which made the row read-only. Fixed: closing now only makes the row inert (`inert` on `TagEditor`/`TagPill`, presses and saves ignored); only archived cards/projects hide × and "+ Add". typecheck and `npm test` (437 passed) after the fix; not re-checked in the UI.

## Not run

- Desktop and compact UI checks (form tag editor, card chips, drawer Tags row, filter toggles, `#tag` search, tip) in the Paseo window.
- A full-access `codex/gpt-6-luna` acceptance session for the tool through MCP (the live check above used the CLI in this session).
