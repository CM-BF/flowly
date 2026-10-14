# Session attention fixture plan

Preparation only. Do not run before the main agent's source-stable notice.

This fixture is independent of `session-pane` and other historical outputs. It will contain only newly created synthetic tests, runner, and evidence for session-attention. It will not alter project dependencies or existing tests.

Planned files after stabilization:

- `shared-attention.test.ts`: pure token and aggregation checks using synthetic sessions and turn evidence.
- `server-session-reads.test.ts`: fake SDK membership and uniquely temporary serialized store checks; `mkdtemp` plus `try/finally` cleanup.
- `session-attention-components.test.tsx`: synthetic RN callbacks and isolated host/RPC/query mocks, including card, sidebar session card, and preview behavior.
- `run-renderer.mjs` (only if needed): temporary `react-test-renderer` install under unique OS temp directory, repository React symlink, guaranteed removal in `finally`.
- Raw output and cleanup evidence created only after tests are authorized to run.

Expected component invariants: acknowledgement sends one `{taskId, agentId, token}` for the selected session; opening/rendering a preview performs no acknowledgement; native `requiresAttention=false` remains authoritative after refresh; read/write failures do not create an all-clear state; composer and follow-tail controls remain available; card drag callback and non-selectable text remain intact.

No native Paseo project/workspace/card/session fixture is required or permitted for this run.
