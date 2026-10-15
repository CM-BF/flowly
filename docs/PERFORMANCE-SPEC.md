# App performance: smooth animation, fast session cards, typing that keeps up

Status: card “性能优化” (2026-10-15). User report: in the app, animations stutter, session cards load slowly, and the input lags, drops characters and sometimes closes the keyboard. Goal: close to native smoothness. This amends the motion, session UX and session input specs; business contracts (single root, card/workspace/session ownership, CAS writes, exact follow-up text) are unchanged.

## 1. Diagnosis

The animations already run on the native driver, and the composer already owns its text on native. The stutter comes from a JS thread that is busy most of the time:

- **Polling volume.** With the board open, the client fetched the full board every 3 s (about 180 KB: every task's every event), resources every 5 s, every live agent every 5 s, summaries every 5 s and managed sessions every 10 s. With a session open, it also fetched every agent on the host including archived ones every 3 s (the drawer list), the session's agent every 2 s, a 35-entry projected timeline with full tool payloads (diffs, file contents, sub-agent logs) every 3 s plus on every stream event, tool health every 5 s and access state every 3 s. Off the LAN, every response is decrypted, base64-decoded and parsed on the JS thread (relay E2EE), then deep-compared by react-query.
- **No render containment.** No component used `React.memo`. Each poll that changed anything (an agent's `updatedAt` changes constantly while it runs) re-rendered the board, every card, the open drawer, the whole transcript and the composer. The host's theme object could also change identity on unrelated host renders, which invalidates every `useTheme` consumer.
- **Mount work during transitions.** On a phone, opening a card unmounted the whole board and Back remounted it (every card, query and animated value) in the same commit that starts the exit animation. Opening a session mounted the transcript only after two sequential round trips with no cache.
- **JS-driven loops.** The running pulse used `Animated.loop(sequence)`, which cannot loop on the native driver, so every running dot needed a JS callback every 800 ms and froze whenever the JS thread was busy.
- **Input.** The composer re-rendered the session view on every wrapped line (JS height round trip, applied a frame late) and on keyboard events. Text typed while a send was in flight could be erased when the send cleared the box. A daemon draft restore that arrived after the user focused an empty composer remounted the input, which closes the keyboard.
- **Unstable transcript keys.** Entries without a message ID were keyed by their position in the sliding 35-entry window, so blocks remounted (and collapsed) as output arrived. The key used `entry.seq`, which projected entries do not have.

## 2. Behavior

Nothing the user sees changes, except that it is faster:

- Board, drawer and sessions show the same data. Freshness is at least as good as before: live agent changes arrive through a Paseo subscription within about half a second (updates are batched per 500 ms), and polling only reconciles.
- Opening a card shows its sessions at once (from the board's live agent list). Archived sessions follow from a slower read.
- Opening a session shows the cached transcript at once when it was seen recently. Otherwise the agent and transcript load in parallel.
- Sending clears the composer at once. If the send fails, the text returns: into the empty box, or before anything typed since. The error is shown as before. Text typed while a send is in flight is never erased.
- The keyboard never closes because of background data. An outside change that would replace the text (restore, queued-message edit) never remounts a focused input that the user has typed in.
- On a phone, Back from a card returns to the board with its scroll position, without rebuilding it.

## 3. Changes

### Daemon (no storage migration)

- `board.read-changed` `{ etag? } → { etag, board? }`: the board view with a content hash; the board is omitted when the hash matches. `summaries.read-changed` and `resources.read-changed` do the same. The original RPCs stay for other callers.
- `sessions.tail` `{ taskId, agentId, limit } → { entries }`: a session's projected timeline tail, reduced to what the UI shows (`seqStart`, item type, text, tool name/status, message/call IDs). Text is clipped (agent and user messages at 12 000 characters, reasoning at 2 000). The session must belong to the card's workspace, like `sessions.image`.

### Client data

- One shared query definition per key (`client/queries.ts`). Board, summaries and resources poll with their etag: an unchanged response is tiny and leaves the cached object as it was, so nothing re-renders. The cache holds plain values; the etag is only sent when the cache still holds the value this reader stored (any `setQueryData` forces a full read).
- Live agents (`["ultra","activity"]`): `paseo.agents.list({ subscribe: {} })` with a one-entry page establishes a filter-scoped update stream. Upserts and removals patch the cache, batched per 500 ms. Archived agents and progress summarizers leave the list; an update never replaces a newer snapshot. The full list still reconciles every 20 s, or every 5 s until the stream is ready or after it fails. The subscription is released on unmount.
- Drawer sessions: live sessions come from the shared live agent list, filtered by workspace (`select`, so other workspaces' updates do not re-render the drawer). Archived sessions are read every 30 s, after any session action, and as soon as a session leaves the live list. Workspace availability and task context poll every 10 s instead of 3 s/5 s.
- Session preview: the agent query is keyed by session (shared with other views, normal cache time) and seeded from the live agent list. The transcript query starts in parallel and uses `sessions.tail`. Stream events refresh only the transcript, coalesced at 400 ms. Polling falls back to 15 s while the stream is ready. Tool health and access state are read only while the Kanban tools section is open.
- Card output: the latest-output line uses `sessions.tail` with a short limit, and cached outputs live for 5 minutes.
- Session images: native skips `Image.getSize` (a second decode of the same data URI); `onLoad` reports the size.

### Client rendering

- Memoized components with stable callbacks: task cards, task drawer, transcript (and each entry, markdown block, inline run and activity block). The native composer does not re-render the session per keystroke (it owns its text), so focus, keyboard and draft-report renders now skip the memoized transcript. Board-wide derivations (events by task, agents by workspace, available workspaces) are computed once per data change, and cards read them by lookup.
- The board root receives a theme object whose identity changes only when a color changes. The context-menu opener is stable, so opening a menu does not re-render the board.
- Phone: the board stays mounted under an open card (`display: none`, so it is not focusable or reachable by accessibility). A lane switch still starts its list at the top.
- Transcript keys use `seqStart`, else the message or call ID. The extra scroll-to-end effect before layout is gone; the transcript follows its tail from its own content-size/layout events, so it lands on the new end in one step.
- Native composer grows by itself between its minimum and maximum height (no JS height round trip). Web keeps the measuring mirror. The keyboard hook applies the transcript padding when the keyboard animation finishes, not at its start.

### Motion

- The running pulse is one native-driver timing looped natively (`Animated.loop(timing)`, opacity interpolated 1 → 0.35 → 1), so it never needs the JS thread.
- Cards no longer fade in on every mount; the list's own reveal covers navigation. The status-change flash overlay is mounted only while it is visible.

### Follow-up: open transitions (user report: opening a card or a session still stutters)

The transitions run on the native driver, but they started in the same frame that mounted the whole drawer or session view and fired its reads. One of those reads paged every agent on the host to find archived sessions. On a phone, the UI thread was busy creating views and the JS thread was busy decoding during the slide.

- `useSettled(key)` (`client/motion.tsx`) turns true one frame after the forward transition (220 ms), and at once under Reduce Motion.
- Opening a card shows its header, questions, description, progress and sessions (from the cache) at once. Details, Usage and Activity, and the workspace, context, archived-session, composer and usage reads, start once it has settled. The late sections sit below the sessions and fade in, so nothing above them moves.
- Opening a session shows its header, notices and composer at once. The transcript, its tail read, the model list and the composer state start once it has settled; the transcript fades in.
- `sessions.archived { taskId }`: the daemon returns the card workspace's archived, non-summarizer sessions. The client no longer pages every agent (hundreds of KB) on each open.
- Phone: the open card is an opaque overlay above the board, which stays laid out (covered, not focusable, hidden from accessibility). Opening and Back change no layout underneath. The board no longer replays its own reveal when a card opens or closes.

### Follow-up: sideways drift while scrolling (user report with an Android capture)

The open card's content (its header included) sat offset to the left while the host header did not, i.e. the details view's own reveal transform (it slides from the left) stayed at a stale start value. Two weaknesses in the shared primitives made that possible on Android's new architecture: every render built new interpolation nodes (re-attaching the native graph and committing the JS-side value mid-animation), and nothing forced the end value into the committed props.

- `lerp(value, outputRange)` (`client/motion.tsx`) returns one cached interpolation node per value and range; every plugin animation uses it.
- Shared transitions set their final value from JS when the native animation finishes, and an interrupted reveal resets to its rest value.
- `MotionReveal` no longer animates on first mount (the surrounding card or board already brings it in); only identity changes animate.

## 4. Constraints kept

- No second Paseo connection: the subscription uses the supplied SDK. No new dependency, no DOM, no private host import.
- Fresh authorization before every send is unchanged (`sendCardInstruction` still refreshes the actor and the scoped context first). Ordinary follow-ups send exactly the user's text.
- Reduce Motion, interruptible transitions and cleanup rules from `MOTION-SPEC.md` hold. An inactive drawer or preview still stops its subscriptions and polling.
- `AGENTS.md` records the performance rules for future work (§5).

## 5. Rules for future work (also in AGENTS.md)

- Poll only what is on screen, and only as often as it changes; prefer the SDK subscription, an etag/unchanged response, or a daemon-side slim RPC to re-downloading a large payload.
- List items and panes that receive frequently changing parents are `React.memo` components with stable callbacks (`useStableCallback`) and primitive or identity-stable props.
- Loops and transitions run on the native driver. Do not loop a `sequence`; do not animate layout properties in hot paths.
- Do not unmount and remount large trees for navigation on phones; hide them.

## 6. Acceptance

Results: [verification](verification/performance.md).


- PASS needed: typecheck; focused unit tests for the etag reader (unchanged keeps the cached object, a foreign `setQueryData` forces a full read), live-agent patching (upsert/insert/archive/remove/summarizer filtering), the tail reducer (fields, clipping, key stability) and the send-clear/restore helper; full suite; plugin reload; live RPC check of `board.read-changed` and `sessions.tail` against this daemon.
- UNRUN unless done on a device: perceived smoothness, frame rate, IME and keyboard behavior on real iOS/Android phones and tablets over LAN and relay. Synthetic tests do not prove frame rate.
