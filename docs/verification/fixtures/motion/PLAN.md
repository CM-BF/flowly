# Motion fixture plan

Prepared before source stabilization; source-stable notice received and planned synthetic checks executed. See `docs/verification/motion.md` for chronology, evidence, and explicit coverage limits.

## Fixture shape

- Add a focused synthetic motion component test and a runner in this directory.
- Mock host `useToast` through existing host-module conventions and assert its call contract; do not create an inline toast substitute in the UI tree.
- Provide deterministic React Native `Animated.Value`, timing/spring/sequence/parallel, `Easing`, and `AccessibilityInfo` mocks that expose start/stop/listener calls and let each completion callback be fired in chosen order (including interrupted and stale callbacks).
- Reuse `react-test-renderer` from a unique OS temp prefix and link the repository's React 19.1.0; do not update dependencies or lockfiles.
- If existing legacy mocks cannot load the changed shared modules, make only minimal mock compatibility edits in verification fixtures and preserve all current evidence/output files.

## Required focused cases

1. Reduced-motion safe initial state, preference resolve/change/failure, StrictMode replay, listener unsubscribe, and stopped animations on cleanup.
2. Native success toast after successful status action/drop, exact destination wording and default duration contract, successive success replacement, no success on mutation failure, and no extra inline layout node.
3. Lane/card text unselectable during idle and drag; detail/conversation text and inputs preserve selection.
4. Drawer enter/exit timing direction, immediate inactive state during shell exit, interruption/reopen, newer-target identity, stale completion fence, and unmount cleanup.
5. Session forward/Back and native chip target transitions; Back immediately disables/unmounts old preview; late membership resolution cannot navigate; draft/selection/lock/chip-consumption semantics remain intact.
6. Direct pointer-coordinate handling, lane emphasis animation, drag start/source/ghost presentation, cancellation, superseding drag, destination arrival, and exactly-once captured-revision write.
7. Streaming/project/status rerenders do not restart navigation; run legacy session-pane/layout/attention renderer checks with a new runner and new output names.

## Run and receipt discipline

- Record every generated temp path before use; all removal occurs in `finally`; receipt records the exact path and confirms absence.
- Runner output files must be motion-specific and live only under this fixture directory; never overwrite historic outputs in other fixture directories.
- Report synthetic callback coverage separately from unavailable visual/frame-rate evidence.
- No Paseo GUI, plugin lifecycle, native resources, child session, or test-session deletion is part of this fixture.
