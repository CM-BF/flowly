# Session attention independent verification

Date: 2026-10-14  
Status: **FOCUSED PASS; full suite and typecheck PASS; parent reload and exact session cleanup confirmed**
Ownership: This verifier wrote only this report and `fixtures/session-attention/`.

## Scope and safety gate

- Read `AGENTS.md`, `docs/SPEC-OUTLINE.md`, `docs/SESSION-ATTENTION-SPEC.md`, `docs/PROGRESS.md`, and `docs/SINGLE-ROOT-SPEC.md` before testing.
- Native public SDK gate: snapshots expose `requiresAttention`, `attentionReason`, and `attentionTimestamp`; public `PaseoApi` has no `clearAgentAttention`. No native attention was cleared, and no existing session received a prompt or acknowledgement.
- Used only temporary directories, fake SDK descriptors/actors, and synthetic React Native callbacks. No native project, workspace, card, child session, actual Paseo GUI, plugin reload, or daemon operation was used.
- Actual UI/focus/gesture/native read flow are **UNRUN**. The required non-fullscreen Paseo window cannot be unambiguously targeted by CUA.
- The checkout has no `.git` entry, so Git status/diff attribution was unavailable. No implementation/spec/dependency/old fixture path was edited by this verifier. Renderer installs used unique OS temporary directories; both were removed in `finally`.

## PASS

### Focused behavior

- `shared-attention.test.ts`: exact native generation, newer token becomes unread, native false authoritative, invalid/missing timestamp unread without invented token, unknown read state, mixed counts and workspace/archive exclusion, newer prompt/turn-start/error superseding finished, and read acknowledgement preserving error/permission attention.
- `server-session-reads.test.ts`: serialized concurrent mark, idempotent bytes/readAt, persistence after store recreation, stale retry protection, membership validation on idempotent retry, unknown generation rejection, invalid-store preservation, and board bytes unchanged.
- Fake `SessionReadService` SDK used actual Paseo workspace descriptor fields: `id`, status values `running`, `attention`, `needs_input`, `failed`, `done`, and `archivingAt`. All five non-archiving states allowed acknowledgement; non-null `archivingAt` was rejected without changing the read store.
- `session-attention-components.test.tsx`: preview render/selection does not acknowledge; explicit action sends exactly `{ taskId, agentId, token }` for its selected session; double click makes one RPC; changed generation remains unread; mark RPC failure retains unread and shows error; query failure is unavailable and disables action; draft/composer remain present; TaskCard unread summary, whole-card mouse drag callbacks and non-selectable text remain intact.
- Read-after-attention does not resolve error/approval: separately asserted for an error session and a permission session after matching receipt.
- Legacy `session-pane` and `session-layout` component fixtures were run read-only through a new renderer runner with both `UIUX_TEST_RENDERER` and `SESSION_LAYOUT_TEST_RENDERER`; 16/16 passed. Existing fixture source, outputs and assertions were not modified by this verifier.

Focused total: **30/30 passed** (10 shared/store/service, 4 new synthetic UI callbacks, 16 legacy renderer regressions). A later isolated shared test rerun after adding the explicit error-read assertion passed 5/5.

### Full project checks

- `npm test`: **65 passed, 27 skipped** across 12 passed and 3 skipped files.
- `npm run typecheck`: passed (`tsc --noEmit`).
- These were run once after focused PASS, as requested. The 27 skips are the standard suite's skipped tests; renderer-dependent pane/layout tests were independently run above.

Evidence outputs: [focused UI output](fixtures/session-attention/renderer-output.txt), [legacy regression output](fixtures/session-attention/legacy-renderer-output.txt), [full suite output](fixtures/session-attention/full-suite-output.txt), [final typecheck output](fixtures/session-attention/final-typecheck-output.txt), [temporary dependency cleanup](fixtures/session-attention/renderer-cleanup.txt), [legacy renderer cleanup](fixtures/session-attention/legacy-renderer-cleanup.txt).

## FAIL

- No product defect was confirmed. The first run exposed only two incorrect fixture assumptions (a duplicate synthetic agent and a valid empty-store document mislabeled as invalid); both fixtures were corrected before focused PASS.

## UNRUN

- Actual wide/compact Paseo rendering, native focus/read flow, real drag gestures, and live message delivery: no GUI action attempted because the non-fullscreen window could not be safely identified.
- Native integration beyond liveness was not independently exercised by this verifier. The parent's final runtime/cleanup confirmation is below.
- Git status/diff audit: unavailable because this checkout has no `.git` entry.

## Parent closeout

- Parent-created test session `9ba46f22-fa8e-4925-95c0-5bcb1ea908d8` used `codex/gpt-6-luna`, `settings.modeId: "full-access"`, and existing workspace `wks_1b4e2fc48dd38d30`. Creation returned `currentModeId: full-access`. No native project/workspace/card or child session was created.
- After final independent typecheck, the parent reloaded only `paseo-ultra-kanban`. Reload and subsequent inventory confirmed enabled/running; daemon not restarted. Implementation hashes below still matched at closeout. Runtime liveness is not actual UI/native read-flow proof.
- Exact deletion returned `deletedCount: 1` for this test agent; subsequent native inspection returned `AGENT_NOT_FOUND`. Both recorded renderer directories and all OS temporary directories with the current-run `kanban-session-attention-` prefix were checked absent.
- Board SHA-256 remained exactly equal to the current-run baseline, retaining one project/one task and zero activities for the test agent. No live session acknowledgement was made, and the daemon watermark file still did not exist: an empty read query does not provision a file. Existing native resources and board records were preserved.
- Evidence: [parent-cleanup-state.json](fixtures/session-attention/parent-cleanup-state.json). Delivery stops for user review; actual wide/compact UI and native read/focus flow remain UNRUN.

## Source snapshot at closeout

The main agent's source-stable notice was received before the focused run. SHA-256 values below record the source snapshot inspected at closeout:

```
819c1124f711e2e273a571b26ce8a4275f8ed472b1a4bb47ea316c002f006375  shared/session-attention.ts
fbdf2ce37be64d1afbdba40165955f3ae0b4c9f458389bbded1a98a4388c3db4  server/session-reads.ts
37b6da94b12ac814780afe0f8c12391c126e4511cfc375cd4663faf4f8613fc1  client/session-reads.ts
ebfef599bd3d35e330f35363ca2d2d20d205aa983a0691c6f71b8d3024a82951  client/card.tsx
034d6ef41f34347e4139c11f01c9a122ecafdea0ae1210cf4cf72ffbbb961310  client/session-preview.tsx
2a80c162949ad354028b14f1a6c7ca30ee8ca45c039e82b3bc960030f2a5abcb  client/session-card.tsx
ae0d920c665b1247569071b217f106dbd9a7ca59c75fbc565836a59553904c19  client/board.tsx
d4a4e3611a44f3ee0eae7de6087d09e913aab10119855acd9d97a164747031cc  shared/rpc.ts
7ae50338c9988c2c03666eb18afb0e4877b21fee9bb8414335b6803a41ac700a  index.server.ts
```

Test-session creation ID/provider/mode are parent-managed metadata; this verifier did not query Paseo for them. Requested identity was `codex/gpt-6-luna`, `full-access` at creation.
