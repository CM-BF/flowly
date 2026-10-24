# Card display: calmer layout and user-chosen fields

Status: implemented 2026-10-19. Card: 任务卡片布局调整. Amended 2026-10-24 by [CARD-TREE-SPEC](CARD-TREE-SPEC.md) (parent breadcrumb, Held, sub-card roll-up; specified, not implemented yet).

## 1. Problem

A board card grew one row or pill per feature: ticket key line, title, progress line, latest-output line, and a wrapping row of priority pill, type pill, tag chips, Needs you, waiting, workpad checks, workspace state, approvals, errors, running, unread, ideas, archived and legacy. In a 260 px column a busy card ran to 7–8 lines, and the things that need the user were mixed in with descriptive metadata.

## 2. Layout

Four tiers, top to bottom. Every tier is omitted when empty.

| Tier | Content | Style |
| --- | --- | --- |
| Meta | priority (Urgent/High/Low only), type, ticket key, tags (first two, then `+n`), parent breadcrumb (sub-cards only, 2026-10-24) | one wrapping row of small muted text with icons, no pills or chips; Urgent/High keep their colour |
| Title | task title, up to 3 lines | unchanged |
| Activity | one line of what the agent did, with its relative time | AI mark when it is the progress summary |
| Status | what needs the user and what is happening | signals as before |

- Urgent/High keep the left stripe; it follows the Priority field.
- Status order (as `CardSignals` in `client/card.tsx` renders it): Needs you, Held (2026-10-24), waiting on cards, automation, Sub-cards n/m followed by its roll-up (2026-10-24: hidden below, below needs you, below with errors, below held, below running, below unread), workspace problems, approvals, errors, running, unread, Dismissed, workpad checks, ideas, Archived, Legacy.
- Parent breadcrumb (2026-10-24, CARD-TREE-SPEC §2.5): a sub-card shows a `CornerLeftUp` icon and its parent's title on one line, at most 40% of the width; its accessibility label is "Sub-card of {title}" with the full path.
- The accessibility label of the card is unchanged and always lists every fact, whatever is hidden.

## 3. Options (Settings → Cards)

Host-scoped (`board-view` settings), so every board on this device uses them.

| Option | Values | Default |
| --- | --- | --- |
| Activity line (`cardActivity`) | `auto`: progress summary, else latest output · `progress` · `output` · `both` · `none` | `auto` |
| Priority, Type, Ticket, Tags, Parent card (`parent`, 2026-10-24), Session activity, Workpad checks, Ideas | shown / hidden (`cardHidden`: list of hidden field ids) | all shown |

- Session activity covers running, starting, unread, session count, Loading… and Last known, and also the sub-card roll-up's "{n} below running" and "{n} below unread" (2026-10-24). Approvals and errors are always shown.
- Parent card: "Show which card a sub-card belongs to".
- Always shown, not configurable: Needs you, Held by {title}, waiting on cards, approvals, errors, Workspace unavailable, Wrapped up, Archived, Legacy, and the roll-up's "{n} hidden below", "{n} below needs you", "{n} below with errors" and "{n} below held" (2026-10-24, CARD-TREE-SPEC §2.4). They tell the user to act or explain why the card behaves differently.
- `both` restores the earlier two-line behaviour (progress line, then output line).
- The page shows a live preview card built from sample data with the current options, and a *Reset to defaults* row.
- The board's Sort menu ends with *Card display…*, which opens Settings on the Cards page.
- The same page has a **Card sidebar** group for the open card's section order and which sections start open (DRAWER-SPEC, Section order).

## 4. Data contract

- `cardActivity: "auto" | "progress" | "output" | "both" | "none"`, default `auto`.
- `cardHidden: string[]` (≤ 20, each ≤ 40 chars), default `[]`; field ids include `parent` (2026-10-24). Unknown ids are kept and ignored, so a newer client's value never invalidates the whole board-view document on an older one.
- Pure helpers in `shared/card-display.ts`: `cardDisplay(view)` → per-field visibility; `activityLines(mode, hasProgress, hasOutput)` → which lines show.

## 5. Onboarding

New one-time tip `card-display`, shown when the current project has 6 or more active cards: “Cards too busy? Choose what they show in Settings → Cards, or from the Sort menu → Card display.” Welcome tour copy is unchanged: this is a view preference, not a new concept.

## 6. Acceptance

1. Default card: meta row, title, at most one activity line, status row; no priority/type pills or tag chips.
2. Each switch hides its field on the board and in the preview immediately; settings persist across reload.
3. Activity modes behave as in §3; `auto` shows output only when there is no progress summary.
4. Always-shown signals stay when every switch is off.
5. Invalid stored values fall back to defaults; older stored documents get the defaults.
6. All new strings in every catalog; `npm test` passes.
