# Phase 2 verification

Status: Phase 2 live non-UI acceptance completed on 2026-10-13. PASS: live MCP lifecycle, existing-session CLI flow, repo scope/revision freshness, ownership and identity isolation, concurrent writes, replay, reload recovery, and negative lifecycle cases. PARTIAL: UI-dependent portions, live request expiry/capacity/port-collision cases, and v2 live migration. UNRUN: all UI checks because the available CUA API cannot enumerate and uniquely bind the non-fullscreen Paseo window. No product code, spec, dependency, or daemon changes were made by this verification run.

## S0 smoke — 2026-10-13

### Environment and scope

- Paseo daemon: `0.11.2`, local `127.0.0.1:6767`.
- Provider/model: `codex/gpt-6-luna`, discovered available before creation.
- Session mode: `full-access`, supplied at creation time and confirmed by `paseo inspect`.
- SDK: public `@getpaseo/client` `0.11.2`; test-only `DaemonClient` plus `createPaseoApi`; session created through public `workspace.agents.create`.
- Official MCP v2 packages: `@modelcontextprotocol/server` `2.3.1` and `@modelcontextprotocol/node` `2.1.1`, installed only under `/tmp/ultra-kanban-phase2-20261013/npm`.
- Workspace directory: `/tmp/ultra-kanban-phase2-20261013/repo`.
- Session: `a87d7587-a62c-4ed4-b5b5-b1b03f643368`.
- Corrected provider retry session: `cd656f5b-8245-4aef-b4de-59e23456765f`, title `Phase 2 MCP provider probe retry 2026-10-13`.
- Workspace: `wks_11b1087c2ef29080`.
- Both sessions used the same isolated workspace and `codex/gpt-6-luna` with `full-access` passed at creation. The corrected retry's preallocated ID exactly matched the `workspace.agents.create` result, daemon record, tool argument, and Luna-reported `PASEO_AGENT_ID`.
- The stub binds only `127.0.0.1`. The retry reused the original `Authorization` value from the original Paseo session configuration; the raw credential was not printed or copied to evidence. A SHA-256 comparison is recorded in the redacted result.
- The original failed session and corrected idle retry session are retained, unarchived, and undeleted. No acceptance assistant or child session was created. The probe server and listener are stopped.
- No CUA API or Paseo window was operated; the fixture session was explicitly instructed not to use GUI/CUA or create/delegate to children.
- Installed `paseo-ultra-kanban` remained at Phase 1. No plugin reload, daemon restart, project/global configuration change, or implementation/dependency/spec edit was made.

### Initial attempt (superseded)

| Check | Result | Evidence |
| --- | --- | --- |
| Discover exact provider/model and creation mode | PASS | `evidence/agent-inspect.json`; provider discovery returned `codex/gpt-6-luna` and `full-access`. |
| Preallocate `agentId` and preserve it exactly | PASS | Runner equality assertion completed before `waitForFinish`; created ID, daemon ID, and Luna-reported `PASEO_AGENT_ID` all equal `a87d7587-a62c-4ed4-b5b5-b1b03f643368`. |
| Isolated fixture and resource scope | PASS | Agent cwd is the dedicated `/tmp/.../repo`; no other host/project was selected. |
| MCP initialize request reaches the stub during first provider turn | PARTIAL | `evidence/initial-mcp-events.jsonl` records `initialize` 324 ms after creation, before the provider's first response. The stub threw before returning a response. |
| MCP initialize response and `tools/list` | NOT VERIFIED | The initial stub harness mistakenly invoked the `createMcpHandler` result as a function rather than calling its `.fetch()` method. It returned an empty response; no `tools/list` was observed. |
| Actual probe tool call and reported identity | NOT VERIFIED / FAILED ATTEMPT | Luna's first-turn response says the probe was unavailable and not run. See `evidence/agent-timeline.txt`. |
| Same-session follow-up after the first handler repair | FAILED TO REACH MCP | The original provider process had cached the startup failure; its follow-up reported the tool unavailable and emitted no MCP requests. |

Cause: the first stub incorrectly treated `createMcpHandler()` as a Node `(req, res)` handler, then a partial repair called `.fetch()` directly with a Node request. This first attempt is superseded by the supported Node adapter below. Its exact error is retained in `evidence/initial-stub-error.txt`.

### Corrected provider smoke

The stub now uses the official `toNodeHandler`, `localhostHostValidation`, and `localhostOriginValidation`; it creates a fresh `McpServer` in the request factory, reads Authorization from `requestInfo.headers`, and pins `responseMode: "json"`. It validates the bearer credential and verifies the passed `agentId` against the retry session ID.

| Check | Result | Evidence |
| --- | --- | --- |
| Correct Node adapter control | PASS | Separate MCP client control traffic lists only `probe` and successfully calls it. Request order: `initialize → notifications/initialized → tools/list → tools/call(probe)`. |
| Provider initialization and tool discovery on its first turn | PASS | The provider's first request sequence is recorded in `evidence/provider-retest-events.jsonl`; Luna negotiated `2025-06-18`, completed `tools/list`, then made its first `tools/call`. |
| SDK create timing | PASS | `initialize` and `tools/list` arrived before `workspace.agents.create()` returned. Exact UTC timings and deltas are in `evidence/retest-timing.md`. |
| Preallocated session identity | PASS | New ID `cd656f5b-8245-4aef-b4de-59e23456765f` exactly matches the create result, MCP probe argument, daemon inspect and Luna's `PASEO_AGENT_ID`. |
| Actual provider tool execution | PASS | Probe returned `probe-ok:cd656f5b-8245-4aef-b4de-59e23456765f`; `probe_result.ok=true`; agent ended idle. Luna's response records both the ID and result. |
| Isolated test/cleanup requirements | PASS | Same fixture workspace, reused loopback port and credential; retry runner one-shot guard; no CUA, child session, daemon restart, plugin reload, or unrelated resource action. |

Do not rerun `run-smoke.mjs` or `retest-provider.mjs`: both use one-shot markers under `/tmp/ultra-kanban-phase2-20261013` to prevent duplicate session creation.

### v3 migration fixture maintenance

Updated [revised-migration.test.ts](fixtures/revised-migration.test.ts) for the current Phase 2 v3 store: v1 read and the first persisted mutation now expect version 3, with the unrestricted `repoPaths: []`, no-write-on-read bytes, and exact v1 backup assertions retained. The focused test passed **1/1** with `npx vitest run docs/verification/fixtures/revised-migration.test.ts`. The Phase 1 historical verification report/output were left unchanged; Phase 2 item 9 is PARTIAL because v2 and malformed-store cases were not run live.

### S0 artifacts

- [Smoke runner](fixtures/phase-02-smoke/run-smoke.mjs)
- [Loopback MCP probe stub](fixtures/phase-02-smoke/probe-server.mjs)
- [Same-session follow-up diagnostic](fixtures/phase-02-smoke/continue-same-session.mjs)
- [Corrected provider retest runner](fixtures/phase-02-smoke/retest-provider.mjs)
- [Agent inspect snapshot](fixtures/phase-02-smoke/evidence/agent-inspect.json)
- [Initial agent timeline](fixtures/phase-02-smoke/evidence/agent-timeline.txt)
- [Initial MCP events](fixtures/phase-02-smoke/evidence/initial-mcp-events.jsonl)
- [Follow-up result](fixtures/phase-02-smoke/evidence/followup-result.json)
- [Follow-up MCP events](fixtures/phase-02-smoke/evidence/followup-mcp-events.jsonl)
- [Temporary npm dependency lock](fixtures/phase-02-smoke/evidence/smoke-npm-lock.json)
- [Initial stub exception and runner cleanup note](fixtures/phase-02-smoke/evidence/initial-stub-error.txt)
- [Corrected retry result](fixtures/phase-02-smoke/evidence/provider-retest-result.json)
- [Corrected retry session record](fixtures/phase-02-smoke/evidence/retry-session-record.json)
- [MCP Node adapter control sequence](fixtures/phase-02-smoke/evidence/adapter-control-events.jsonl)
- [Actual provider request sequence](fixtures/phase-02-smoke/evidence/provider-retest-events.jsonl)
- [Corrected retry agent inspect](fixtures/phase-02-smoke/evidence/retry-agent-inspect.json)
- [Corrected retry agent timeline](fixtures/phase-02-smoke/evidence/retry-agent-timeline.txt)
- [Create/MCP/first-call timing](fixtures/phase-02-smoke/evidence/retest-timing.md)

## Full Phase 2 acceptance checklist

Implementation readiness was confirmed by the user. Each live fixture actor was created as `codex/gpt-6-luna` with `modeId: "full-access"`; see per-session evidence. Fixtures are isolated under `/tmp/ultra-kanban-phase2-20261013`; all resources and evidence are retained. UI steps were not attempted because no API here can identify and bind the non-fullscreen Paseo window.

| # | Status | Exact checks and evidence required |
| --- | --- | --- |
| 1. New-session MCP + skill lifecycle | PARTIAL | Real Luna full-access session `85914006-1bfe-4743-9683-b1104e04f554` called `kanban_get_task`, status `in_progress`, progress report, and status `in_review`; revisions/activity and `turn_ended` behavior verified. A human RPC then completed the isolated fixture card. UI create/refresh and user UI completion remain UNRUN. Evidence: `evidence/new-mcp-session.json`, `evidence/mcp-lifecycle-agent-timeline.txt`, `evidence/mcp-lifecycle-board-evidence.json`, `evidence/mcp-lifecycle-human-completion.json`. |
| 2. Existing-session CLI lifecycle | PARTIAL | Existing Luna session `809c5bb7-e6dd-40d3-990b-bd3705a31e79` received only CLI instructions; six `current/status/note/status` commands exited 0, final In review revision 3, no repo changes. UI draft preservation/selection routing remain UNRUN. Evidence: `evidence/existing-cli-session.json`, `evidence/existing-cli-agent-timeline.txt`. |
| 3. Repo scope and revision freshness | PASS | Verified default all repos (including add/remove), one repo, multiple repos, external worktree path mapping, workspace source path separation, stale project revision rejection with card unchanged. Evidence: `evidence/scope-revision-worktree.json`, `evidence/scope-path-normalization.md`. |
| 4. Resource ownership and identity isolation | PASS | Cross-native-project workspace remained under its original owner; same-canonical-cwd workspaces with distinct IDs were isolated and wrong workspace/session identity rejected. Evidence: `evidence/scope-revision-worktree.json`, `evidence/same-cwd-identity-isolation.json`. |
| 5. Concurrent sessions and human-edit precedence | PASS | At identical revisions exactly one state write succeeded and the other returned `REVISION_CONFLICT`; two parallel progress writes appended without task revision increment; human priority edit won over stale write. Evidence: `evidence/mcp-concurrency-replay.json`. |
| 6. Idempotency, expiry, capacity, reload | PARTIAL | Live exact replay produced one activity and `replayed:true`; changed args returned `REQUEST_REUSED`; cross-session request returned `SESSION_MISMATCH`; after plugin reload, receipt replay persisted. Live expiry and capacity saturation were not run; focused unit coverage is in `evidence/focused-unit-tests.txt`. Evidence: `evidence/mcp-concurrency-replay.json`, `evidence/reload-readiness-receipt.json`. |
| 7. Invalid, archived, finished and lifecycle cases | PARTIAL | Live done/cancelled returned `TASK_FINISHED`, archived card returned `ARCHIVED` while Paseo workspace/directory stayed active, absent agent returned `SESSION_MISMATCH`, and missing/incompatible workspace links were rejected. Wrong credential, archived actor/workspace and permission-request event are covered by targeted unit tests, not live provider calls. Evidence: `evidence/negative-lifecycle.json`, `evidence/focused-unit-tests.txt`. |
| 8. UI-close, readiness recovery, port collision | PARTIAL | Reloaded the same plugin without daemon restart. Port 56670 stayed stable; unauthorized request returned 401; cold MCP read returned `PASEO_UNAVAILABLE`; health/context recovery restored reads and exact receipt replay. UI-close and live port-collision/manual-UI behavior remain UNRUN; service-level port collision is covered by unit tests. Evidence: `evidence/reload-readiness-receipt.json`, `evidence/runtime-health.json`, `evidence/service-security-precheck.txt`, `evidence/focused-unit-tests.txt`. |
| 9. v1/v2-to-v3 persistence and recovery | PARTIAL | v1 read preserved original bytes, unrestricted `repoPaths: []`, first mutation persisted v3, and v1 backup bytes stayed exact; focused migration, store, agent service, and tool server tests passed 28/28. Live v2 migration and malformed/unknown data preservation were not run against a live service. Evidence: [migration fixture test](fixtures/revised-migration.test.ts), `evidence/focused-unit-tests.txt`; Phase 1 historical report/output remain unchanged. |
| 10. UI states and real closed-loop proof | UNRUN | No Phase 2 UI captures or UI interaction were performed. Window targeting constraint and reason are recorded below. Phase 1 screenshots are historical only and are not used as Phase 2 proof. |

### Focused test result

`npx vitest run docs/verification/fixtures/revised-migration.test.ts server/store.test.ts server/agent-service.test.ts server/tool-server.test.ts`: **4 files, 28 tests passed**. Raw output: `fixtures/phase-02-live/evidence/focused-unit-tests.txt`. The user separately reported the complete `npm test` (7 files/42 tests), typecheck, and skill validator passed before this live verification; this run did not repeat the full suite.

### Delivery gates

- Record completed, failed, and unrun checks separately; do not treat `running` status or MCP configuration presence as a successful tool call.
- Preserve all pre-existing Paseo resources and unrelated user data. Use explicit fixture names/IDs for new resources.
- Test sessions may write evidence/scripts only; no implementation changes. Stop leftover running test tasks when a phase closes, while retaining fixture resources and evidence.
- After implementation and Luna acceptance are complete, stop for user review; do not begin another phase without instruction.

### UI window targeting constraint (2026-10-13)

**UI checks: UNRUN.** The macOS CUA inventory identified Paseo (`sh.paseo.desktop`) but returned no per-window records; `cua.listWindows` is unavailable on this runtime. It provided no IDs, titles, or geometry, so I could not distinguish the non-fullscreen window. No Paseo window was targeted or manipulated. Evidence: [window inventory](fixtures/phase-02-live/evidence/ui-window-inventory.md) and its [machine-readable snapshot](fixtures/phase-02-live/evidence/ui-window-inventory.json). Continue the non-UI acceptance checks.
