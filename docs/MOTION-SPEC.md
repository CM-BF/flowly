# Board feedback and navigation motion

Status: authorized by the user's 2026-10-14 request. This amends UI-UX, session UX and session-chip presentation; single-root and Phase 2 business contracts remain current.

## Observable behavior

- A successful status move shows Paseo's native success toast (`Moved to In progress`, etc.), for the host default 2,200 ms. It adds no board row or layout height. Mouse drop and action/status controls use this feedback. A rejected mutation retains its actionable error and never shows success. Another success replaces the previous toast through the host API.
- Board lane labels, counts, empty/drop hints and card text disallow selection through React Native Text, including while a mouse drag crosses lanes. Task details, conversation output and editable inputs keep their existing selection behavior. No DOM selection APIs or global event handlers.
- Opening a task sidebar slides/fades it in from the right; closing slides/fades it out faster. Compact detail uses the same bounded transition. Closing immediately disables interaction, conversation subscriptions and deferred native navigation, even while its visual shell exits. Rapid reopen reverses the exit; stale animation completions cannot close a new target.
- Opening a session preview slides/fades new content forward. Back reveals task detail in the reverse direction. Different card/session and native Task chip requests use the same transition. Selection, drafts, pending operation locks and one-time chip consumption retain existing semantics; animation does not delay selection or a write.
- Project/status changes have a short content transition. Host Modal/sheet, native screen/workspace/session navigation and toast retain Paseo's own transitions; do not layer a second animation over host-owned UI. Plugin-owned tool disclosure gets a bounded reveal.
- Drag feedback lifts/fades the ghost and subdues the source card. Pointer tracking is immediate, without easing or timers on coordinates. Eligible lane emphasis transitions quickly. Release/cancel fades the non-interactive ghost; committed card arrival transitions in its destination. Captured-revision single-write rules remain unchanged. Another drag supersedes an exiting ghost.

## Motion language and constraints

Operate surface: motion explains spatial relationships and confirms actions. Share a React Native Animated implementation and durations: feedback 120 ms, forward navigation 220 ms, reverse/exit 160 ms. Decelerating easing, no bounce, loops or list choreography. Animate opacity/transforms only; resizing and drag coordinates remain direct. Use native driver on native platforms and supported JS driver on web. No runtime dependency or private host import.

Read `AccessibilityInfo.isReduceMotionEnabled()` and observe `reduceMotionChanged`. Default to reduced motion until the asynchronous preference is known; keep that safe default on failure. Reduced motion applies final states immediately, while toast/error/state feedback remains visible. Stop animations/listeners and guard completion on interruption, replacement, StrictMode replay and unmount. Polling/streaming text must not replay navigation animation.

An exiting sidebar retains its presentation until exit finishes. Preview receives an explicit inactive flag: no subscription, polling, send/read/tool action or delayed native navigation. Pending operations already sent are not cancelled or duplicated. Back unmounts its old preview immediately so late membership checks cannot navigate. Animation completion never changes server state or acknowledges attention.

## Architecture

No schema/RPC/storage migration or resource provisioning. `client/motion.tsx` owns preference, interruption-safe presence and shared reveal/progress primitives. Board owns drawer presence, host toast and content transition; drawer owns session transition; columns/cards own drag feedback. Client remains React Native only. AGENTS.md requires motion for future plugin-owned opens/closes/navigation/drag feedback, reduced-motion support and cleanup coverage.

## Acceptance and evidence

Use one discovered `codex/gpt-6-luna` session created with `settings.modeId: full-access` in the existing dev workspace. Test ownership: `docs/verification/motion.md`, new motion fixtures, and minimal test-mock compatibility changes for RN Animated/host useToast. Preserve shared source edits and old evidence. No native fixture project/workspace/card or child needed; clean exact session and unique temporary renderer directories. Standard lifecycle history caused by testing in a user-linked workspace is preserved and reported separately.

Focused checks: success toast/no inline row; failure no toast; lane/card non-selection vs details; enter/exit/reopen/stale completion; reduced-motion initial/query/change/failure/cleanup; session forward/Back/chip entry and immediate closing cleanup; drag direct coordinates, ghost replacement/cancellation, exact CAS once, lane emphasis; navigation identity, drafts/locks, composer/follow-tail and attention regressions. Run final typecheck and one full suite after source stabilizes, then reload only this plugin. PASS/FAIL/UNRUN are distinct.

Actual desktop/compact motion, selection, smoothness and toast require the actual ID/title/geometry of the non-fullscreen Paseo window. If CUA cannot identify it, perform no GUI actions and mark UNRUN. Synthetic callbacks are not real frame-rate or gesture evidence. Stop for user review after delivery.
