# Verification: app performance (card “性能优化”, 2026-10-15)

Spec: [PERFORMANCE-SPEC](../PERFORMANCE-SPEC.md). Implementation session `f77e536f-3fed-4317-a34f-dc8e9e346baa` (this card's own session; no test session or fixture resources were created).

## PASS

- `npm run typecheck`.
- `npm test`: 266 passed / 63 skipped (renderer-only fixtures). New focused tests:
  - `client/queries.test.ts`: an unchanged etag read keeps the cached object; a foreign `setQueryData` forces a full read; a write during an in-flight etag read is not kept; live agent updates replace/insert/archive/remove, never go back in time, drop summarizers, and never mutate the cached list.
  - `shared/session-tail.test.ts`: the tail keeps type/text/name/status/IDs/`seqStart`/timestamp, drops tool payloads, clips messages (12 000) and reasoning (2 000).
  - `server/session-tail.test.ts`: slim projected tail of a card session; refuses another workspace's session (from the timeline's agent, or the refreshed one when absent) and unknown cards.
  - `server/etag.test.ts`, `client/session-input.test.ts` (failed-send restore order).
- Plugin reloaded (`paseo plugin reload paseo-ultra-kanban`): running.
- Live RPC check against this daemon (short-lived local client, closed afterwards; temporary script removed):

  | Read | Before | After |
  | --- | --- | --- |
  | Board poll (3 s), unchanged | `board.read` 147 097 B | `board.read-changed` with etag 38 B |
  | Summaries poll (5 s), unchanged | 6 492 B | 38 B |
  | Resources poll (5 s → 15 s), unchanged | 10 258 B | 38 B |
  | Session transcript, 35 entries | projected timeline 68 528 B | `sessions.tail` 9 432 B |
  | Drawer session list (3 s) | every agent incl. archived: first page alone 562 119 B (200 entries) | from the live stream; archived every 30 s |
  | Live agents (5 s) | 117 313 B (33 agents) | stream bootstrap 8 596 B, then updates; full list every 20 s |

  `sessions.tail` refused an unknown session. The agent stream (`agents.list({ subscribe: {}, page: { limit: 1 } })`) delivered 7 upserts in 30 s for the running session, then was released.
- Renderer fixtures (`docs/verification/fixtures`, temporary react-test-renderer 19.1.0 outside the repo, removed afterwards): 46 failed / 48 passed with this change, against 45 failed / 49 passed for an export of `HEAD` with the same renderer. The failures are stale mocks that predate this card (missing `configureSession`, `noFocusRing`, `touch`, `font`, `useWindowDimensions`, `readComposer` exports and similar). The single extra failure (`drawer › resize grip …`, missing `touch` in the ui mock) comes from the already-uncommitted tablet grip change in `client/resize.tsx`, not from this change. One fixture assertion changed intentionally: recent-output keys use `seqStart` (projected entries never had `seq`).

## Follow-up: open transitions

- PASS: typecheck; `npm test` 267 passed / 63 skipped (new `server/archived-sessions.test.ts`: only the card workspace's archived non-summarizer sessions, across pages; unknown card refused); plugin reloaded; live `sessions.archived` on this card: 0 entries, 2 B, 30 ms. The client used to page every agent incl. archived on each card open (first page alone 562 KB).
- UNRUN: perceived smoothness of opening a card/session on a real phone.

## Follow-up: sideways drift

- PASS: app typecheck (`client/`, `server/`, `shared/` clean); `npm test` 266 passed / 1 failed / 63 skipped, the failure being `server/tool-server.test.ts` tool count from the concurrent Ideas-card work (new tool), not this change; plugin reloaded.
- At the time, `tsc` also reported fixture type errors from that concurrent work (`TaskDrawer` gained `onCreateFromIdea`/`onOpenTask`).
- UNRUN: the Android device check that the drift is gone.

## UNRUN

- Real-device smoothness, frame rate, IME/keyboard behavior and typing on iOS/Android phones and tablets, over LAN and relay. Synthetic tests do not prove frame rate.
- Luna (`codex/gpt-6-luna`) UI acceptance on desktop/compact.
- Repairing the stale renderer fixtures (owned by test sessions).
