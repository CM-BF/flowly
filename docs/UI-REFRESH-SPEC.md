# UI refresh — native-blend visual and information architecture

Status: authorized by the user's 2026-10-14 request to redesign the whole Kanban UI (project chooser, board, cards, card drawer, session cards, session detail). Direction chosen by the user: **native blend** (look like a first-party Paseo surface) with **visual + information-architecture** changes allowed. Presentation only: RPC contracts, storage, one-root scope, session/business-status independence, motion policy ([MOTION-SPEC.md](MOTION-SPEC.md)) and drawer rules ([DRAWER-SPEC.md](DRAWER-SPEC.md)) are unchanged unless amended below. Luna acceptance is deferred by the user; they review the reloaded plugin themselves first.

## 1. Design language

- Follow the host Paseo scale read from the installed 0.11.2 app: 4-point spacing grid; type 12 / 13 / 14 / 16 / 18; weights 400 / 500 / 600; radii 4 / 6 / 8 / 12; icons 12 / 14 / 16. Only `PluginTheme` colors are used; tints are derived from them with alpha, never new hues.
- Status color semantics match the host status dots: needs approval → `statusWarning`, error → `statusDanger`, running/starting → `accent`, unread finished turn → `statusSuccess`, idle/closed → muted. Business statuses get a Lucide status glyph (Backlog dashed circle, Todo circle, In progress dot/warning, In review dot-dashed/accent, Blocked slash/danger, Done check/success, Cancelled X/muted).
- Desktop controls are compact (32 pt high) with hover feedback on web; native/compact controls keep ≥ 44 pt hit targets. Ghost icon buttons replace text buttons for secondary actions, each with an accessibility label.
- Errors use a toned notice (icon + tinted border) rather than a plain bordered box. Long IDs, full timestamps and configuration explanations move to details or accessibility labels; visible times are relative ("3m ago") with the absolute time in details.

## 2. Board

- Toolbar: one 48 pt row. Project switcher (folder glyph, project name, chevrons), muted task count, search-aware Filters button (badge with active-filter count), primary "New task".
- Project chooser modal: host-style list rows (name, root path, check for current, archived badge). Current-project actions (Edit, Archive/Restore) and "New project" sit below a divider. Selecting a project closes the drawer exactly as before.
- Filters modal: search field, priority segmented control, two switch-style rows (Show archived, Show finished), footer with Reset / Refresh / Done.
- Desktop lanes: borderless `surface1` lanes (radius 12) without a header divider. Header = status glyph, label, muted count, ghost "+" (hover). Empty lane shows a quiet "No tasks"/"Drop here". Drag target feedback (accent overlay, ghost preview, subdued source) keeps the existing behavior.
- Compact status control is a full-width row showing status glyph, label and count; the status chooser modal is a list of rows with counts and a check.

## 3. Cards

- Title first (14/500, up to 3 lines). One signal row below: priority glyph only when not Normal (Urgent danger, High, Low muted), session signals as dot + short text in priority order — approvals, errors, running, unread — otherwise a muted session count when sessions exist. Archived/Legacy as small outline badges. Workspace unavailable / loading / unavailable / last-known states remain visible as one muted line.
- The actions "…" button is an absolutely positioned ghost icon in the top-right; on desktop web it appears on hover/selection and stays focusable; compact always shows it. Whole-card mouse drag, click suppression, non-selectable text and accessibility summary remain unchanged.
- Selected card: accent border; hover: stronger neutral border. Attention is carried by the colored signal dots, not by card borders or colored edges. Empty lanes render nothing; the dashed drop slot appears only during a drag.

## 4. Card drawer

- Header: project breadcrumb (muted) with Edit / Archive / Close (desktop) or Back (compact) icon buttons; title 18/600; property chips for Status (opens the status chooser modal on both layouts, replacing the desktop `SettingsSelect`) and Priority (opens Edit). Errors shown under the header.
- Body sections with small uppercase-free headers ("Description", "Sessions n", "Activity"): description as readable text; sessions list with "New session" ghost button in the section header; Details & workspace disclosure (unchanged content); Activity as a compact timeline (dot, humanized action, actor, relative time, note).

## 5. Session card (row)

- One bordered row group: status dot (semantic color, pulsing only through existing reduce-motion-aware motion if added), title (500), trailing relative time and chevron. Second line muted: state label · provider/model. Unread → success dot and bold title; needs-attention → tinted state text. Archived rows dimmed. Highlight after creation uses the accent border.

## 6. Session detail

- Compact header: back icon, title + status line (dot, state label, provider/model), trailing icon buttons: Mark read (only when unread), Refresh output, Kanban tools toggle, Open in Paseo. All existing enable/disable conditions are preserved.
- Transcript: user messages as right-aligned `surface2` bubbles; agent messages as plain markdown; tool activity as one-line muted mono rows with a wrench glyph; thinking as muted italic with a brain glyph. "Recent output · open in Paseo for the full conversation" becomes a muted caption at the top. Running tail keeps the spinner.
- Kanban tools panel: bordered card with explanation, configuration and last-call lines, and the "Send Kanban work instructions" button.
- Composer: a single bordered container with the multiline input and an integrated send icon button (both layouts); hint and jump-to-latest in a small row above; Steer/Interrupt as a segmented control shown only while running. Enter/Shift+Enter, draft buffering, steer/interrupt and authorization behavior are unchanged.

## 7. Forms

- Project/Task/New-session forms keep fields and validation; adopt the new field, segmented choice and notice styles; footer actions are right-aligned with Cancel before the primary action.

## 7a. Phone scrolling (2026-10-14 correction)

- User report: on the phone the board list drifted slightly left/right. All vertical lists (compact task list, lanes, drawer, session output) are vertical-only: `horizontal=false`, no horizontal bounce/indicator, directional lock, and a content container with `overflow: hidden` / `maxWidth: 100%`, so child overflow or transforms cannot widen the iOS (Fabric) content size.
- Switching the compact status is a filter change, not navigation: the list fades without a horizontal slide. Drawer/session navigation keeps its slide.

## 7b. Session composer keyboard and send button (2026-10-14 correction)

- User report: in the drawer session view the software keyboard covered the composer. The session view no longer relies on `KeyboardAvoidingView` (which was disabled on Android). On native it measures the view's bottom edge against the keyboard top on show/change and pads by the actual overlap (0 when the host window already resized; iOS follows keyboard timing). The inset is removed on hide/unmount and the transcript re-follows the tail when the inset appears. Web is unaffected.
- Send button: circular, centered on a single-line input in a pill composer; accent with accent foreground when sendable, muted tinted fill when empty/unwritable, press scale feedback, spinner while sending, and a return glyph when the running-session mode is Interrupt.

## 7c. Native composer in the host sheet (2026-10-14 correction, supersedes the keyboard-inset part of 7b)

- User report: on Android the IME still covered the composer. Cause (RN 0.81 `ReactRootView.checkForKeyboardEvents`): Android emits `keyboardDidShow` only when IME visibility flips, with `height = ime.bottom - systemBars.bottom`; later IME height changes (Chinese candidate bars, keyboard switches) emit nothing, so plugin-side measurement under-lifts.
- Fix: on native platforms the session view shows a one-line composer bar (draft preview or "Message this session…", running mode, edit affordance). Tapping it opens the host `Modal` (gorhom bottom sheet with Reanimated keyboard tracking) containing the same multiline input, Steer/Interrupt control and send button; the host keeps it above the real IME. Successful send closes the sheet; failure keeps it open with the error. Draft, Enter/keyboard-send, authorization and send semantics are unchanged. Web/desktop keep the inline composer. The plugin-side keyboard inset hook was removed.

## 7d. New-session agent picker (2026-10-15 correction)

- User report: provider/model chip walls (15 providers, 20+ models) were hard to scan. The New session form now shows an always-visible "Agent" group with three rows — Provider, Model, Permissions — each showing its current value. Tapping a row expands one inline vertical list at a time (label, description, Default tag, check for the selected item, scroll-bounded); lists longer than 8 get a search field. Provider labels/descriptions come from the provider snapshot, falling back to the id; unselectable models are hidden; model descriptions drop a repeated name prefix. Selection logic (remembered defaults, fallbacks, creation) is unchanged. Pure option builders/filter live in `client/options.ts` with tests.

## 8. Acceptance

| Check | Expected |
| --- | --- |
| Typecheck and `npm test` | Pass before reload |
| Reload | Only `paseo-ultra-kanban` reloaded; no daemon restart; board data untouched |
| Behavior parity | Project select/CRUD, filters, drag, actions menu, drawer resize, status change, edit/archive, session create/preview/send/mark-read/tools/open in Paseo all reachable with unchanged rules |
| Modal theme | Every host `Modal.Content` body still installs `Theme.Provider` |
| Appearance | Light/dark use only theme tokens and alpha tints |
| UI acceptance | User review in the real app; Luna UI acceptance UNRUN by user decision |
