# Session pane independent verification

Date: 2026-10-14  
Scope: SDK capability gate and focused synthetic React component callback verification. This verification owns evidence only; implementation and spec were not changed.

## PASS

- **Public SDK API gate:** Installed `@getpaseo/plugin` 0.11.2 does not export `AgentPane`, `AgentPanel`, or `AgentCreatePane`; there is no `openAgentDraft`. Public navigation supports `openAgent({ agentId, serverId? })` and `openWorkspace({ workspaceId, serverId? })`. The in-memory TypeScript probe produced the expected TS2305/TS2339 diagnostics and both supported navigation calls compiled. Evidence: [original probe](fixtures/session-pane/native-pane-capability.json), [independent gate probe](fixtures/session-pane/native-pane-api-gate.json). No private host module was imported.
- **Overview and navigation:** The rendered SessionCard callback selects its actor; TaskDrawer lists sessions newest first, opens the selected actor preview, calls native navigation with the exact actor ID and `hostId`, and Back restores the overview.
- **Creation:** Host modal mounts with advanced settings collapsed. The callback checks verified empty-provider, empty-model and non-selectable-model states; unavailable creation is disabled and hidden models are excluded. Provider `listModels` and `listModes` payload errors become rejected query functions and render as modal errors. Two immediate submit callbacks take one operation; failed create retains title/instruction and retry recovers the prepared actor without repeating create or the initial prompt.
- **Membership and fresh state:** Moved actors do not enable timeline or access queries, do not subscribe, and cannot send. Each opened preview uses a fresh `['ultra','agent',sessionId,'preview',useId()]` query with `gcTime: 0`; a second mount gets a distinct key. Back releases the active subscription.
- **Provider availability and readonly reason:** Card and preview surface provider-unavailable status. Preview disables writes, while native navigation remains available for diagnosis. The actual `workspaceSession(..., writable=true)` rejects provider-unavailable actors and `sendCardInstruction` does not call `send`. A task/workspace unavailable reason is rendered in preview.
- **Drafts and locks:** Drafts stay isolated by actor across Back and reselection. The TaskDrawer-owned per-actor busy lock survives Back/reopen, prevents a duplicate send, leaves another actor's draft writable, and clears only the completed actor's matching draft.
- **NativeOpen lifecycle:** A delayed fresh-membership result does not navigate after Back unmounts the preview. A React StrictMode fixture observed effect `setup → cleanup → setup`; NativeOpen still called the exact actor/host afterward, verifying that the mounted flag is restored by effect setup.
- **Focused component suite:** 7/7 passed using the temporary `react-test-renderer@19.1.0` harness. Output: [session-components-output.txt](fixtures/session-pane/session-components-output.txt).
- **Typecheck after final StrictMode change:** `npm run typecheck` passed. Output: [final-acceptance-typecheck-output.txt](fixtures/session-pane/final-acceptance-typecheck-output.txt).
- **Broad suite before the final mounted-flag setup fix:** `npm test` passed 55 tests, 13 skipped. It was intentionally not repeated after that one-line lifecycle fix, per instruction. Output: [final-sealed-npm-test-output.txt](fixtures/session-pane/final-sealed-npm-test-output.txt).
- **Temporary dependency cleanup:** The renderer was installed only under one unique `mkdtemp` directory, linked to the repository's pinned React, and removed in `finally`; `renderer_temp_exists_after_cleanup=false`. Evidence: [cleanup record](fixtures/session-pane/session-components-temp-cleanup.txt). The renderer is absent from project dependencies.

## FAIL

- None in the final focused component or typecheck runs. An earlier temporary harness attempt failed before tests due to an already-present peer React in its temporary directory; the runner was corrected, cleaned that directory, and final focused runs passed.

## UNSUPPORTED

- Native Agent pane embedding and native draft/create-pane navigation are unsupported by the public 0.11.2 plugin SDK. The supported fallback is the plugin modal/preview plus explicit native navigation.

## UNRUN

- Real Paseo desktop/compact rendering, native focus, and message delivery were not exercised. No Paseo window was operated; synthetic callbacks do not establish native rendering or focus behavior.
- The main agent owns the final plugin reload/runtime result; it was not independently verified by this component run.
- No project, workspace, card, child session, native test prompt, daemon restart, or plugin reload was created/performed by this verifier. The test-session identity/mode was not independently queried in this report.

## Parent closeout

- The parent created test session `18121ba1-252f-4a1c-93d7-2253918805ba` with provider/model `codex/gpt-6-luna` and `settings.modeId: "full-access"` in existing workspace `wks_1b4e2fc48dd38d30`. Creation metadata was checked at launch; these identity/mode statements are parent evidence rather than an independent query by the verifier.
- After the final typecheck, the parent reloaded only `paseo-ultra-kanban`. Reload completed successfully; a subsequent native plugin inventory confirmed `enabled: true`, `status: "running"`. The daemon was not restarted. Runtime liveness does not validate native rendering, focus or message delivery.
- The parent deleted the exact test session; deletion returned `deletedCount: 1` for that ID. Subsequent native inspection returned `AGENT_NOT_FOUND`. The temporary renderer directory was independently checked absent at closeout.
- No fixture native project/workspace/card or child session was created. The board retained its existing one project and one task; no activity event referenced this test session. Existing resources were preserved.
- Closeout evidence: [parent-cleanup-state.json](fixtures/session-pane/parent-cleanup-state.json). Real desktop/compact UI, native focus and message delivery remain UNRUN. Implementation and verification are closed for user review.
