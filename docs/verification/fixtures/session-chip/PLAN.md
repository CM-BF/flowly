# Session chip focused fixture plan

Prepared before implementation stabilization. Do not run until the user/root agent explicitly says the source is stable.

## Fixture shape

- Add only synthetic tests and runners in this directory.
- Import `client/session-link.ts` helper exports once available; fake the public SDK surface, `board.read` RPC, agent-directory pagination, composer-chip registrations, host ID, navigation and timers.
- For component coverage, adapt the existing fake React Native renderer conventions from the session-pane/layout/attention fixtures without editing those files. `BoardScreen` and `TaskDrawer` receive synthetic props and callback/navigation spies only.
- Any renderer module is supplied through a temporary prefix and environment variable; no package/dependency manifests or lockfiles are changed.

## Coverage matrix

| Surface | Cases |
|---|---|
| Link parsing/resolution | Valid full target; absent/partial/bounded-invalid params; stale card; moved workspace/session; archived target remains read-only linkable; exact session identity |
| Chip registry | Linked and unlinked agents; two sessions on one card; archived actors; host isolation; title update; workspace/card unlink removal; initial and subsequent lookup failures do not expose stale targets |
| Poll/actions | Five-second polling, pagination, reads do not overlap; click revalidates fresh membership; screen ID and all four params; repeated click gets new request ID; older slow action loses; teardown cancels timer/removes only owned chips and fences late completions |
| Board entry | Select project/card; clear title/priority filters; reveal archive/finished state and compact status; exact workspace/session; invalid newer params close previous target and surface an error |
| Drawer lifecycle | Entry consumed once; Back returns to overview/details; Close remains closed through URL poll/rerender; manual card open is details-only; fresh nonce reopens exact session; second target wins |
| Regressions | Draft isolation, subscriptions, composer/follow behavior and read/attention state remain unchanged; chip entry does not send prompts or mark read |

## Run discipline

1. Wait for explicit source-stable notice.
2. Inspect final source and adapt this matrix to actual exported signatures without changing production code/spec/dependencies.
3. Record each temp path before creation. Wrap install/render/run/cleanup in `try/finally`; verify every recorded path is absent afterward.
4. Record commands, exact counts, output paths and PASS/FAIL/UNRUN in `docs/verification/session-chip.md`.
5. Leave plugin reload and exact test-session deletion to the main agent.
