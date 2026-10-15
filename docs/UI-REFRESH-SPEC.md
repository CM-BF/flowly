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

## 7e. 2026-10-15 refinements

- **Remembered project**: the board reopens on the last project chosen through the project chooser or created there (host-scoped plugin setting `board-view.lastProjectId`); links, Attention and workspace panels still select their own target without overwriting it.
- **Status-change flash**: when a card's status differs from the previous board snapshot (often an automatic A1 move or another client), the card shows a 1.5pt accent border with a 6% accent wash that fades in quickly and out over ~0.9s, then clears after 1.6s. Never on first load; each flash owns its timer; reduce-motion snaps; timers cleared on unmount.
- **Activity**: routine turn start/end records are hidden from the timeline (they still drive rules and markers); failed turns, questions (shown as "asked", full text emphasized) and rule changes ("Auto" badge with reason) are shown.

## 7e-2. Running pulse and summary hygiene (2026-10-15)

- Running/starting state dots (card "n running" signal, drawer session rows, session detail header) breathe between full and 35% opacity over ~1.6s with the native driver. Static under Reduce Motion; the loop stops on unmount or when the session stops. Verified live by sampling the dot over time.
- Card output summaries drop markdown images entirely, so image-only agent messages ("Image" alt text) no longer become the summary; the previous text message is used instead.

## 7f. Session archive / restore in the drawer (2026-10-15, user request)

- The public SDK exposes `agent.archive()` but no unarchive; the daemon restores an archived agent when it receives a prompt (Paseo's own behaviour). The plugin follows that model.
- Session detail header: "Archive session" icon for live sessions. Running/starting sessions ask for confirmation first (archiving interrupts the turn). Success shows a toast and returns to the card details.
- Archived session detail: the notice says sending a message restores it; the composer stays enabled with the placeholder "Send a message to restore this session…". The ordinary send path accepts an archived target (`workspaceSession(..., "restore")`); Kanban work instructions still require a live session.
- Drawer Sessions list shows live sessions; archived ones move to a collapsed "Archived · n" group at the bottom. The Sessions count shows live sessions.
- Verified live with a fixture card (archive → grouped → restore by message), then wrapped up: [evidence](verification/session-archive-restore.png).

## 7g. Focus rings, composer stability, Paseo send parity (2026-10-15, user report)

- **Focus rings**: the board root (focusable for shortcuts) and every plugin pressable suppress the browser's square focus outline (`noFocusRing`); focus is shown with the component's own hover/selected styling, and cards show their rounded accent border while focused. Verified: focused card computes `outline: none`.
- **Composer stability**: the drawer's task-context query keeps its previous data across revision changes (automatic status moves no longer blank it and flash "unavailable"); the composer input stays editable whenever the session exists — only the send button follows availability — so typing is never dropped. No rows appear/disappear above the input: "Latest" is a floating pill, the Steer/Interrupt segmented row is removed. Verified live on a running session: 40 typed characters, constant input position/height, focus retained; New task dialog position constant while the drawer is open.
- **Send while running (Paseo parity)**: options Steer / Queue / Interrupt with Paseo's semantics — Enter uses the preference, Cmd/Ctrl+Enter the alternative (queue for steer/interrupt; send now for queue); a queued message waiting behind a permission prompt interrupts instead. Paseo's own setting is client-local and not readable by plugins, so the board keeps a host-scoped copy (`board-view.sendBehavior`, default Steer) changed from the composer footer ("When running: …") or the native sheet. Queued messages show above the input (removable) and are sent one per finished turn by the board even when the preview is closed; a failed send returns to the front of the queue with an error toast.

## 7i. Composer parity, persistence, context menus, motion (2026-10-15, user request)

- **Composer chips (Paseo layout)**: under the session input, chips for Model · Reasoning · Permissions open upward menus (desktop) or inline lists (native sheet).
  - Reasoning and permissions apply on selection; the model menu shows the model and provider features (e.g. Fast mode) read-only with "Change in Paseo".
  - A running session with an empty input shows Stop in place of Send.
  - The header "Session settings" button is removed (superseded).
- **Persistence**: unsent drafts and queued follow-ups live on the daemon (`composer.json`: serialized writes, atomic replace, invalid files preserved), so plugin reload and app refresh keep them.
  - Drafts save 0.5s after typing stops (immediately when a send clears them) and are restored when the drawer opens.
  - The daemon drains queued messages on turn end, after a push, and opportunistically on reads, one per turn. A failed send returns to the front of the queue and shows its error under the composer.
- **Send now**: each queued message has "Steer" (and a context menu: Send now · Edit · Remove), which steers the running turn and removes it from the queue.
- **Feedback**: transient confirmations ("Marked as read", "Kanban instructions sent", "Session archived") are native toasts that auto-dismiss; inline notices are only for errors.
- **Context menus**: right-click (desktop web) or long-press (touch) opens plugin menus.
  - Cards: Open · Start session · Move to … · Move up/down · Archive.
  - Session rows: Open · Open in Paseo · Archive.
  - Queued messages: Send now · Edit · Remove.
  - The browser's native menu is suppressed across the board except in editable fields (copy/paste stays native).
  - Desktop menus float at the pointer (fade + scale, clamped to the board); compact uses the host sheet.
- **Motion** (shared primitives, Reduce Motion aware, interruptible):
  - chip and context menus (fade/rise or scale);
  - picker lists (fade/slide on expand);
  - toggle thumb slide;
  - question callouts and queued rows (enter rise);
  - the floating "Latest" pill (fade).

## 7k. Side bar headers (2026-10-15, user request)

- Every level of the side bar can close it directly.
  - **Card details**: project crumb · Edit · "⋯" (Start session, Wrap up… when finished, Archive/Restore card) · Close.
  - **Session detail**: Back · title/status · Open in Paseo · "⋯" (Mark as read when unread, Kanban tools, Stop when running, Archive session) · Close.
  - Compact keeps Back on the card level (it is the close) and adds Close at the session level.
- The manual Refresh button is removed: output, status and sessions poll and subscribe automatically.
- The session row context menu adds Stop for running sessions. Archive from a row stays disabled while running; the detail view's archive confirms instead.
- Overflow menus reuse the plugin context menu: floating at the button on desktop, host sheet on compact.

## 7j. Images in the session transcript (2026-10-15, user report)

- Timeline text carries images as provider placeholders for pasted images (`[Image: source: /abs/path.png]`) and as markdown in agent replies (`![alt](src)`). `extractImages` removes them from the text and renders them under the message: user images right-aligned under the bubble, agent images under the markdown. Thumbnails keep their aspect ratio (bounded), fade in when loaded, and open larger in a sheet.
- http(s) images load directly. Local paths live on the daemon machine, so the plugin daemon serves them (`sessions.image`) as data URIs, with these limits:
  - the session must belong to the card;
  - the path must be an image (png/jpg/gif/webp, ≤ 8 MB) referenced in that session's recent timeline — never a general file reader.
- Failures show the alt text with the reason.
- Verified live: a pasted-image placeholder and an agent markdown image rendered in the drawer preview ([screenshot](verification/session-images.png)).
- Composer data of archived (wrapped-up) cards is pruned automatically.

## 7h. Session settings (2026-10-15, user request)

- Session detail header → "Session settings" (live sessions):
  - **Reasoning** (the current model's `thinkingOptions` from the SDK model catalog) and **Permissions** (the session's `availableModes`) apply on selection.
  - **Stop** interrupts a running session.
  - **Model** and provider **features** (e.g. Codex Fast mode) are shown read-only with "Change in Paseo".
- Why: the plugin SDK (`PaseoApi`) exposes no session-settings API. The daemon's `setAgentModel/Feature` live only on the private DaemonClient or the agent-facing `/mcp/agents` endpoint, which plugins must not impersonate. The official Paseo CLI supports `agent update --thinking`, `agent mode` and `agent stop`, so the plugin daemon runs the bundled CLI (resolved from the app bundle, argument arrays, `--home` = daemon home).
- RPC `sessions.configure` validates:
  - the session belongs to the card's workspace, is not archived, and the mode is offered;
  - IDs must start with a letter or digit (no option injection).
- Verified live: reasoning Medium→High and permissions →Plan Mode on a fixture Haiku session, confirmed with `paseo agent inspect` (thinking=high, mode=plan); fixture wrapped up ([screenshot](verification/session-settings.png)).
- When the SDK gains model/feature setters, the read-only rows become pickers with no other change.

## 7l. Project order (2026-10-15, user request)

- Projects carry an optional `position`; the chooser and default selection use `projectOrder` (position, then creation time). Legacy records without a position keep their creation order.
- The Projects chooser shows up/down buttons on every row (larger touch targets on mobile); the first/last buttons are disabled.
- `projects.move` (`up | down | top`) renumbers all projects in one serialized write. Ordering is presentation metadata: it does not bump the board revision, so it never invalidates an open edit.
- Verified: reorder, persistence across reload, and restoring the original order on the live board.

## 7m. Collapsed agent activity (2026-10-15, user request)

- Consecutive thinking and tool-call entries in the session transcript merge into one activity block, collapsed by default to a summary ("Thought · 7 tool calls"). User and agent messages are never grouped.
- While the session is running, the trailing block reads "Working" with a pulse dot and the latest tool, replacing the separate "Agent is working…" row.
- Expanding shows each step as a short preview: tools on one line, thinking clipped to two lines. The full thinking stays in Paseo ("Open in Paseo").
- The block's key is its first entry, so expanded state survives streaming updates. Expand uses the shared Enter motion; the chevron rotates.
- Verified on a live running session: two blocks collapsed, expand works, no console errors (`docs/verification/activity-groups.png`).

## 8. Acceptance

| Check | Expected |
| --- | --- |
| Typecheck and `npm test` | Pass before reload |
| Reload | Only `paseo-ultra-kanban` reloaded; no daemon restart; board data untouched |
| Behavior parity | Project select/CRUD, filters, drag, actions menu, drawer resize, status change, edit/archive, session create/preview/send/mark-read/tools/open in Paseo all reachable with unchanged rules |
| Modal theme | Every host `Modal.Content` body still installs `Theme.Provider` |
| Appearance | Light/dark use only theme tokens and alpha tints |
| UI acceptance | User review in the real app; Luna UI acceptance UNRUN by user decision |
