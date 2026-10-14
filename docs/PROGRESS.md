# Implementation progress

## Sidebar attention badge (F2) — 2026-10-15

- [x] Wrote [sidebar badge spec](SIDEBAR-BADGE-SPEC.md) before code. Confirmed from the 0.11.2 public types and installed app bundle that `SidebarRow.trailing` renders nothing when null and otherwise sits in a non-accessible host Pressable sharing the row press; nested pressables press on their own.
- [x] Sidebar row shows a warning count pill (`99+` cap) only when the count is > 0; pressing the row still opens the board, pressing the pill opens the board with the Needs attention modal (unique `view=attention&open=<token>` per press). Board and sidebar both count through the shared pure `attentionFromSources`; badge pill extracted to `CountPill` and reused by the board button.
- [x] Sidebar polls board/agents/read receipts every 10 s with host-scoped query keys through plugin `useRpc`/`usePaseo` only; observers end on unmount. Board/agent failure hides the badge.
- [x] PASS: `npm run typecheck`; `npm test` 95 passed / 56 renderer-only skipped (2 new focused tests in `client/attention.test.ts`).
- [ ] UNRUN: plugin install/reload, real desktop/compact sidebar rendering, pill press and modal opening in the app, screen-reader focus of the pill. Not permitted in this card (no install/reload, no UI driving).
## Card latest agent output (F1) — 2026-10-15

- [x] Wrote [card output spec](CARD-OUTPUT-SPEC.md) before code. Agent snapshot has no assistant-text field, so cards use a bounded 20-entry projected tail fetch keyed by session ID + `updatedAt`, only for mounted cards, at most 3 concurrent, no polling/retry.
- [x] Card shows one muted, non-selectable, single-line plain-text summary of the newest assistant message plus relative time; quiet for no session/loading/failure/no text; accessibility label includes it. Drag/press/Actions unchanged.
- [x] PASS: typecheck; full `npm test` 99 passed / 59 renderer-only skipped; focused helpers 6/6; synthetic renderer card 3/3; legacy card responder 8/8 after fixing its stale mock. [Verification](verification/card-output.md).
- [ ] FAIL (pre-existing, unchanged): session-attention renderer fixture 4 failures from stale mock, same on baseline.
- [ ] UNRUN: plugin install/reload, real desktop/phone UI, screen reader, live request rate.
## F3 drag reorder within/between columns — 2026-10-15

- [x] Wrote [drag reorder spec](DRAG-REORDER-SPEC.md) before implementation: insertion line, midline hit testing, `tasks.place` contract (CAS, single serialized atomic write, position/status only, no-op without write).
- [x] Implemented `tasks.place` (`BoardStore.placeTask`, fractional neighbor midpoint, normalization only when neighbors tie), pure `dropSlot`/`placementUpdate`, column insertion line and drop wiring; new cards append after the column's max position. Menu up/down and phone/touch paths unchanged.
- [x] PASS: typecheck; `npm test` 110 passed / 60 renderer-only skipped; focused store 10/10, geometry 12/12, service append 1/1, columns renderer 4/4 (temp `react-test-renderer`). [Evidence](verification/drag-reorder.md).
- [ ] FAIL (pre-existing, unchanged): 45 legacy renderer fixtures fail identically on the base commit due to stale `client/ui` mocks.
- [ ] UNRUN: actual desktop UI/drag feel and live conflict error — no plugin install/reload by instruction.
## F4 desktop keyboard shortcuts — 2026-10-15

- [x] Researched Paseo 0.11.2 before implementation. The plugin SDK has no shortcut API, and Command Center items have no key field. The host shortcut registry is internal, and a global DOM listener is forbidden. The trade-off is recorded in the [shortcuts spec](SHORTCUTS-SPEC.md), written before code.
- [x] Board-scoped keys on desktop web: N new task, P projects, / or F filters, A attention, ? help, Esc (session Back, then close the sidebar), and J/K/H/L card navigation. The root `View` is focusable and receives the RN-Web `onKeyDown`. Plugin text inputs and all plugin modals block shortcuts through a ref-counted guard (`useShortcutBlock`, `client/modal.tsx`). Modifier chords, repeats and IME input pass through.
- [x] Discoverability: a desktop header Keyboard button opens a help modal; header button labels include their key. Five global Command Center items open the board with a once-only, 30-second `intent` param.
- [x] PASS: `npm run typecheck`. PASS: focused `client/shortcuts.test.ts` 10/10. PASS: full `npm test` (103 passed / 56 renderer-only skipped). An initial run failed 3 renderer fixtures because `Modal.Content` was read at import time and their host mocks omit `Modal`; it is now read lazily, and the re-run passed.
- [ ] UNRUN: real desktop key handling, how focus enters the board, focus after a host modal closes, Command Center item display and navigation with params on an already-open board, and help modal appearance. Per card instructions, the plugin was not installed or reloaded and no Luna test session was created. [Verification](verification/shortcuts.md).

## Compact task status label — 2026-10-14

- [x] Updated [drawer spec](DRAWER-SPEC.md) before implementation. The [user capture](verification/fixtures/status-label/before.png) showed `T...`: installed host `SettingsSelect` reserves a 160 pt label while the plugin capped its wrapper at 240 pt.
- [x] Compact detail header now shows the full selected status in a full-width button; the seven options appear only after opening a themed host Modal. Same-value no-op, stale/inactive/archived/pending guards, exact task revision and success toast are preserved. Wide host selector has a larger width budget.
- [x] Focused 9/9, legacy renderer 43/43 and immediate-close 2/2 passed after updating stale test mocks; full suite 84 passed / 56 renderer-only skipped, final typecheck PASS, detector no findings. Reloaded only `paseo-ultra-kanban`, which reports running. Temporary renderers removed; no native resources created. [Evidence](verification/status-label.md).
- [ ] Android pixel visibility and sheet interaction remain UNRUN under the user's current code-only acceptance choice. Synthetic checks prove the selected label and actions passed to components, not the phone's pixels.

## Phone session composer — 2026-10-14

- [x] Updated [session UX spec](SESSION-UX-SPEC.md) before implementation from the user's Android [before screenshot](verification/fixtures/mobile-composer/before.png). Compact preview now uses a 48–96 pt growing input with a 48 pt Send target on the same row, one 48 pt Steer/Interrupt row only while running, and an inline Jump to latest target. Wide composer and send authorization remain intact.
- [x] Final typecheck PASS; focused real-component callback fixture 18/18 PASS (including compact growth, mode/send, paused follow and readonly); one full `npm test` 84 passed / 55 renderer-only skipped. Impeccable detector returned no findings. Reloaded only `paseo-ultra-kanban`; it reports running. No native resource was created.
- [ ] App E2E is UNRUN and deferred by the user's code-only acceptance choice. Paseo desktop CUA `getApp` timed out; AndroMeld `devices.list` returned `[]`, so no Android Phone Screen session existed. No desktop window or phone UI was operated. AI mirror control was disabled after the attempt. [Verification detail](verification/mobile-composer.md).

## Android project chooser theme crash — 2026-10-14

- [x] Amended [UI/UX spec](UI-UX-SPEC.md) before implementation. The user screenshot shows `Error: Theme missing` in the plugin `Button` when the compact project chooser opens. Source inspection found the custom theme provider outside the host Modal body.
- [x] Reprovided the current theme inside all seven host modal bodies: board project/filter/status/task-action choosers, project/task forms and session creation. No RPC, board data or resource contract changed.
- [x] `npm run typecheck` passed. Source inspection found a provider immediately inside every `Modal.Content`. Reloaded only `paseo-ultra-kanban`; plugin inventory reports enabled and running. No tests or new Paseo resources were created.
- [ ] Android opening/dismissing those modals is UNRUN: no safely addressable Android UI target was available; the ADB device inventory did not return and was interrupted. The plugin's `running` state is not proof of the mobile fix. [Verification and user screenshot](verification/android-modal-theme.md).

## Follow-up composer Enter submission — 2026-10-14

- Complete [input spec](SESSION-INPUT-SPEC.md) before code: desktop Enter/Shift/IME, native Send, shared lock/draft semantics, plain tool-purpose copy and exact user-message delivery without the repeated task preamble.
- [x] Shared button/key submission, native Send behavior, latest-draft buffer/writable guard, Shift/IME/repeat protection and purpose/hint copy implemented; parent typecheck PASS, detector no findings.
- [x] User correction applied: ordinary card follow-ups now send only the typed text after fresh actor/scope checks. Initial session context and explicit Kanban work instructions remain separate. Updated the existing wire-payload unit assertion and passed parent typecheck.
- [x] Independent full-access Luna passed 17 focused composer checks, 46 renderer regressions, final typecheck and one full suite (83 passed / 54 renderer-only skipped) before the wire-payload correction. The bounded post-correction wire check passed 4/4 and final typecheck passed; the broad suite was not repeated. [Chronology and evidence](verification/session-input.md).
- [x] Reloaded only `paseo-ultra-kanban`, confirmed running, deleted exact test session `6cbf1980-bcac-4b6b-9693-2731c7b611c4` and confirmed `AGENT_NOT_FOUND`. Its derived CLI context and all seven recorded renderer directories are absent. Two projects/two cards remain; six normal session lifecycle events are preserved. [Cleanup evidence](verification/fixtures/session-input/parent-closeout.json).
- [ ] Actual desktop/compact UI, hardware Shift/IME, focus and message delivery remain UNRUN: fresh CUA could not identify the required non-fullscreen window by ID/title/geometry. No GUI action was attempted. Delivered for user review.

## Task sidebar hierarchy — 2026-10-14

- Complete [drawer spec](DRAWER-SPEC.md) before implementation: grouped native Status/Edit/Archive, grip-only resizing and collapsed metadata/workspace.
- [x] Grouped public host Status selector/Edit/Archive, removed width controls and workspace action, primary Sessions and collapsed read-only metadata implemented. Shared measured-height motion and adjustable boundary grip retained; parent typecheck passed and detector returned no findings.
- [x] Full-access Luna: focused 8/8, corrected legacy 43/43, reduced-motion immediate-close 2/2, final typecheck PASS; the single full suite passed 72 / 48 renderer-only skipped before the bounded follow-up. Exact stale accordion completion and archived-project guard are covered; [chronology and limits](verification/drawer.md).
- [x] Reload/inventory enabled and running. Exact test session `5a68229e-51a2-4b3c-8d66-d20a373d5374` deleted (AGENT_NOT_FOUND); derived CLI context removed; all six recorded renderer paths and current scoped temp inventory absent. Source hashes match verifier evidence. Project/card counts remain 2/2; six normal test-session lifecycle events preserved, live read-state hash unchanged with no test-agent receipt.
- [ ] Actual desktop/compact appearance, host dropdown/keyboard/path wrapping and gesture/motion feel remain UNRUN: fresh CUA lacks window ID/title/geometry; no GUI interaction. Delivered for user review.

## Board feedback and navigation motion — 2026-10-14

- Complete [motion spec](MOTION-SPEC.md) written before code; AGENTS.md requires shared, interruptible motion and native toast feedback.
- [x] Native success toast, non-selectable lane text, shared motion/preference primitives, inert drawer exit, forward/Back session transition and direct-coordinate drag feedback implemented; parent typecheck passed and design detector returned no findings.
- [x] Independent full-access Luna: motion 8/8, legacy renderer 42/42, retained-preview exit fixture 10/10 and final typecheck PASS. One full suite passed 72 tests / 39 renderer-only skipped before the final exit case; chronology and unexercised criteria are in [verification](verification/motion.md).
- [x] Final plugin reload/inventory running. Exact testing session `363ff97e-8a55-491a-bdfe-34d9e73c934b` deleted, inspection AGENT_NOT_FOUND; derived CLI context removed and renderer paths absent. No project/workspace/card created; existing board remains two projects/two cards. Eight normal test-session lifecycle history entries preserved; live read-store hash unchanged with zero test-agent receipts.
- [ ] Actual desktop/compact motion, toast/selection/gesture feel and additional listed criteria remain UNRUN. Fresh CUA lacks native window ID/title/geometry; no GUI interaction. Delivered for user review.

## Native session chip — current request

- [x] Public 0.11.2 composer pill/screen params gate; complete [SESSION-CHIP-SPEC.md](SESSION-CHIP-SPEC.md) before implementation
- [x] Host-scoped paginated chip discovery/cleanup and fresh navigation validation; cold route validation, stale board-fetch cancellation and one-time card/sidebar/session entry. First typecheck passed
- [x] Full-access Luna 6: helper 7/7, new synthetic navigation 3/3, old regressions 30/30; complete suite 72 passed / 30 skipped and final typecheck passed
- [x] Final reload running; exact test session deleted, native inspection AGENT_NOT_FOUND; both renderer directories/current scoped temporary directories absent. Live read-store hash unchanged; standard test-session lifecycle history retained on the user card
- [ ] Real native chip/wide/compact focus: requires safely bound non-fullscreen Paseo window

Testing session `d380e718-8a0a-42a6-bc1e-cabe0ef8f483`, `codex/gpt-6-luna`, created with `modeId=full-access` in existing workspace `wks_1b4e2fc48dd38d30` and deleted at closeout. No test project/workspace/card or child was created. [Verification and limits](verification/session-chip.md). The development workspace is now linked to a user card; its four normal test-session lifecycle entries are retained as history. The board hash changed and is not reported as unchanged. Two existing user projects/cards and the read-store file were preserved. Delivered for user review; actual native chip/focus/wide/compact UI remain UNRUN.

## Task-card session attention — current request

- [x] Complete [SESSION-ATTENTION-SPEC.md](SESSION-ATTENTION-SPEC.md) before implementation: snapshot capability gate, counts/read semantics, separate daemon watermark store, validated RPC and failure/race/cleanup criteria
- [x] Implemented workspace-scoped session totals, run/finished/unread/attention counts, sidebar read state, explicit generation acknowledgement, and separate serialized daemon store; corrected workspace lifecycle check against the SDK and passed typecheck
- [x] Full-access Luna 6: focused 30/30 (10 logic/store/service, 4 new UI, 16 legacy UI), full suite 65 passed / 27 skipped, typecheck passed; additional error-read shared assertion rerun 5/5
- [x] Final reload running; exact testing session deleted and inspection returns AGENT_NOT_FOUND. Both renderer directories and all current-prefix test-store directories absent; board bytes/source hashes unchanged
- [ ] Actual wide/compact UI/native read flow: requires unambiguous non-fullscreen window targeting

Testing session `9ba46f22-fa8e-4925-95c0-5bcb1ea908d8`, `codex/gpt-6-luna`, created with `modeId=full-access` in existing workspace `wks_1b4e2fc48dd38d30` and deleted at closeout. No fixture native project/workspace/card or child was created. [Verification and UI limits](verification/session-attention.md). Delivered for user review; real desktop/compact rendering and native read/focus flow remain UNRUN.

## Session preview layout and tail — current correction

- [x] Updated [SESSION-UX-SPEC.md](SESSION-UX-SPEC.md) section 8 before implementation: native Markdown subset, fixed bottom composer, responsive metadata and follow-tail pause/resume
- [x] Implemented native Markdown rendering, fixed composer, wrapping metadata, follow-tail pause/resume and cancellable trailing subscription refresh; first typecheck passed and initial plugin reload running
- [x] Independent full-access Luna 6: combined focused checks 20/20; final full suite 55 passed / 23 renderer-only skipped; final typecheck passed. Timeline error/empty-state defect corrected; prior fixture collection failure fixed with test-only mock compatibility changes
- [x] Final reload running; exact test agent deleted and native inspection returns AGENT_NOT_FOUND. Both temporary renderer directories removed; board bytes and verified implementation hashes unchanged at closeout
- [ ] Actual desktop/phone rendering and keyboard/gesture checks: current CUA inventory has no window ID/title/geometry for the required non-fullscreen window

Testing session `1ea62ff1-6a08-4e88-bd17-1873cd76e53b`, `codex/gpt-6-luna`, created with `modeId=full-access` in existing workspace `wks_1b4e2fc48dd38d30` and deleted at closeout. No test project/workspace/card or child was created. [Verification and remaining UI limits](verification/session-layout.md). Delivered for user review; real rendering, keyboard positioning and gestures remain UNRUN.

## Session creation and preview — latest UI request

- [x] Native pane API gate first: installed 0.11.2 SDK has no embeddable Agent pane or draft/create navigation; public existing-session native navigation supported
- [x] Complete fallback contract: [SESSION-UX-SPEC.md](SESSION-UX-SPEC.md)
- [x] Creation host Modal with collapsed settings and existing MCP/skill/recovery flow; overview session cards with execution state; explicit preview Back/native actions
- [x] Per-session draft and in-flight operation isolation; live membership checks; preview-only observation and cleanup
- [x] First typecheck and 55 passed / 7 renderer-only skipped regression checks; plugin reload running
- [x] Full-access Luna 6: final focused component checks 7/7 and typecheck passed; temporary renderer removed and exact test agent deleted
- [x] Broad suite before the final mounted-ref StrictMode fix: 55 passed / 13 skipped. No broad rerun after that fix; the final focused suite covers StrictMode navigation and cancellation after Back
- [x] Final plugin reload/runtime running; cleanup inspection returns AGENT_NOT_FOUND and no test lifecycle events remain in the board
- [ ] Real Paseo UI/native focus/message delivery remain UNRUN: no unambiguous non-fullscreen window target

Testing session `18121ba1-252f-4a1c-93d7-2253918805ba`, `codex/gpt-6-luna`, created full-access in the existing development workspace and deleted at closeout. No fixture native project/workspace/card or child session was created. The existing board project/card and native resources were preserved. [API gate and verification](verification/session-pane.md). Delivered for user review; native focus and actual message delivery remain UNRUN.

## Whole-card drag amendment — latest UI request

- [x] Updated UI/UX spec: whole-card primary-mouse drag, independent Actions, card/preview text non-selectable
- [x] Implementation, typecheck and plugin reload running; native/compact vertical task list unchanged
- [x] Full-access Luna 6: focused checks 8/8, typecheck passed, full suite 50 passed / 7 renderer-only skipped. Temporary renderer removed; exact test agent deleted and native inspection confirms AGENT_NOT_FOUND

This supersedes the handle-only presentation below. Verification session `2fdbb024-4ddb-4793-bad5-d281470910ae`, `codex/gpt-6-luna`, created with `modeId=full-access` in the existing development workspace and deleted at closeout; no fixture native project/workspace/card created. Plugin is running; real desktop/phone gestures remain UNRUN. [Whole-card drag verification](verification/whole-card-drag.md). Delivered for user review.

## UI/UX refinement — 2026-10-14

- [x] Complete incremental contract: [UI-UX-SPEC.md](UI-UX-SPEC.md)
- [x] One-row toolbar with project management/filter menus; desktop columns and phone status chooser/vertical list
- [x] Status drag from a dedicated card handle, captured-revision writes, target feedback and horizontal edge scroll
- [x] Adjustable drawer grip and accessible width controls; bounded scrolling and wrapping choices/forms
- [x] First implementation typecheck, 49/49 regression checks, plugin reload running
- [x] Independent full-access Luna 6: 4/4 synthetic component checks; final normal suite 49 passed / 4 renderer-only skipped; final typecheck passed. Whole-card responder finding fixed by dedicated handle
- [ ] Live desktop/phone UI: current CUA inventory has no window identities/geometry, so the required non-fullscreen Paseo window cannot be bound. No Paseo UI action attempted

Testing session: `c8bfb6b3-40c8-40ec-8a0c-82a1909abe04`, `codex/gpt-6-luna`, created with `modeId=full-access` in the existing development workspace. Deleted after verification; exact native inspection now returns `AGENT_NOT_FOUND`. No fixture native project/workspace/card created. Renderer and current-run migration temporary directories removed; migration test now cleans each run automatically. Plugin remains running. [Verification and limits](verification/ui-ux.md). Implementation is delivered for user review; actual desktop/mobile gestures and live UI CAS rejection remain UNRUN.

2026-10-14 清理：此前验收留下的 11 个测试看板 project、22 张卡片、7 个托管 worktree、4 个验收 session 和隔离临时目录均已移除；对应原生 fixture project 在清理开始前已不在 Paseo 列表。插件恢复 running/ready，当前看板为空。今后的测试必须在结束时清理自身 fixture。[清理记录](verification/cleanup-20261014.md)。

## M2.5 多任务人工管理 — 2026-10-14

- [x] Spec: [MULTITASK-SPEC.md](MULTITASK-SPEC.md)（A 需要关注总览、B 一键开 session、D 手动收尾；C/E 不做）
- [x] AGENTS.md 增补显式 Wrap up 例外
- [x] 实现：`client/attention.ts`、`client/wrapup.tsx`、`server/wrapup.ts`、board/drawer/session-create 接入
- [x] Typecheck；`npm test` 96 passed / 56 skipped（新增 attention 3 项、wrapup 6 项，含真实 git 临时仓库）；只 reload 本插件
- [x] Web 客户端只读渲染：桌面与 420pt 手机的工具栏 Attention、空状态弹窗、卡片菜单 Start session、预填创建框（取消，未创建）
- [ ] UNRUN：Attention 有内容时的跳转（当前无待处理 session）；Wrap up 弹窗与真实归档（当前无 Done 卡片，未对用户资源执行）；原生 iOS/Android；Luna 验收（用户暂缓）

## UI refresh — 2026-10-14

- [x] Spec: [UI-REFRESH-SPEC.md](UI-REFRESH-SPEC.md) (native-blend direction, visual + IA changes, behavior parity)
- [x] Implementation: shared primitives/tokens (`client/ui.tsx`), status/priority glyphs (`client/status.tsx`), board toolbar and pickers, lanes, cards, drawer, session rows, session detail, forms
- [x] Typecheck; `npm test` 84 passed / 56 skipped; reloaded only `paseo-ultra-kanban`
- [x] Rendered check through a separate headless app.paseo.sh client connected to the local daemon (not the user's windows), read-only navigation only: desktop light/dark board, drawer, session detail, project/filter/action modals, card hover; 420 pt phone status chooser, list, drawer, session. No writes performed; no fixtures created.
- [x] Phone horizontal drift fix (spec §7a): vertical-only lists with clipped content width; compact status switch fades instead of sliding. Web 390 pt touch-emulated probe finds no horizontally overflowing scroller; not reproduced or verified on a native device (none connected)
- [x] Session composer keyboard inset and send button restyle (spec §7b); `keyboardOverlap` unit-tested (87 passed); web composer rendered empty/with draft. Native keyboard behavior not verified on a device
- [x] Android chip toast `Cannot read property 'id' of undefined`: chip action now only navigates; board validates (SESSION-CHIP-SPEC 2026-10-14 amendment). Step-prefixed errors. Chip fixture test updated to the new contract; 87 passed. Web compact chip flow re-run OK. Root cause on Android not confirmed (no device)
- [ ] Luna UI acceptance: deferred by the user's choice; user reviews in the real app first
- [ ] Not exercised live: drag/drop, resize grip drag, create/edit forms submission, session send/steer/interrupt, mark read, native iOS/Android

## Single-root amendment — latest user decision

- [x] Complete amended contract: [SINGLE-ROOT-SPEC.md](SINGLE-ROOT-SPEC.md)
- [x] New project and card flows use one native Paseo project root; common parent directories are managed as native projects
- [x] Existing multi-repo cards keep their saved scope and workspace links as read-only legacy data; v3 board storage is preserved
- [x] Typecheck, 43/43 tests across 7 files, and skill validator pass
- [x] Reloaded only `paseo-ultra-kanban`; `board.json` SHA-256 stayed identical across reload
- [x] Full-access Luna 6 isolated non-UI acceptance: 13/13 resource checks in both corrected runs; native binding immutability; real `kanban_get_task` root scope and identity. [Verification report](verification/single-root.md)
- [ ] UI acceptance: CUA cannot distinguish the user's non-fullscreen Paseo window; no UI action was attempted

The prior Phase 1/2 multi-repo scope below is historical. UI acceptance remains constrained to the non-fullscreen Paseo window; CUA currently cannot enumerate macOS windows, so no UI action is allowed without unambiguous targeting.

## Phase 1 — Kanban and Paseo resources

Current scope: revised on 2026-10-13. Cards default to all project repos or explicitly select one/multiple repos; existing workspaces are linked by actual repo membership, preserving their native owners. Phase 1 delivery stops for user acceptance.

- [x] Accepted outline and project invariants
- [x] AGENTS.md constraints
- [x] Complete Phase 1 spec
- [x] Implementation (first pass)
- [x] Final Luna typecheck and 21/21 checks across 4 test files (20 implementation tests plus isolated migration verification)
- [x] Installed Paseo plugin; Luna 6 acceptance session launched
- [x] Actual wide UI, ownership, persistence and selected-session message acceptance
- [x] Revised repo-scope implementation, migration and existing cross-project workspace eligibility
- [x] Luna 6 revised core acceptance, controlled retry/negative cases, stale UI draft, move/reorder/filter and project repo edit guards
- [ ] Revised compact light/dark UI: externally blocked by CUA `cgWindowNotFound`/window-coordinate errors; System Events also denied assistive access. Old compact captures do not validate the revised UI.
- [x] Stopped for user acceptance; subsequent instructions authorized Phase 2 design, implementation and testing

Delivery: implementation is ready for the user's review in Paseo → Ultra Kanban. [Verification report](verification/phase-01.md) distinguishes the passing revised core from the unresolved compact capture boundary and the historical unattributed duplicate workspace observation. No daemon restart or resource deletion was performed.

## Phase 2 — Agent tools and skill

- [x] Revised complete Phase 2 design, aligned with optional multi-repo scope and preserved existing workspace ownership
- [x] User authorization: implement Phase 2 and perform complete testing
- [x] S0 preallocated agent identity, explicit full access and real provider MCP probe (Luna)
- [x] Tool/CLI/MCP and skill implementation; installed under the existing plugin ID
- [x] Typecheck, complete `npm test` (7 files/42 tests), skill validator; daemon RPC health and board v3 view
- [x] Luna 6 full-access, real MCP and existing-session CLI behavioral acceptance; scope, identity, concurrency, replay, reload and core negative cases
- [ ] Phase 2 UI acceptance: CUA on macOS cannot identify/bind the user's non-fullscreen Paseo window; no Paseo UI action was attempted
- [ ] Full live expiry/capacity/port-collision/v2-service migration scenarios; focused service/store tests pass, limits are recorded in the verification report

Phase 2 spec: [PHASE-02-SPEC.md](PHASE-02-SPEC.md). Three current-card tools; automatic MCP/skill for drawer-created sessions; explicit CLI/skill instructions for existing sessions; Agent delivers In review and human confirms Done. Task/project revisions protect live scope, progress notes preserve task revision, and persistent receipts prevent duplicate retry writes. Testing used full-access `codex/gpt-6-luna` sessions. The complete non-UI acceptance and remaining boundaries are in [verification report](verification/phase-02.md). Work stops for user review after this phase.

## Environment

- Plugin ID: `paseo-ultra-kanban`; existing `paseo-kanban` is a separate installation.
- Daemon/client compatibility target: Paseo 0.11.2.
- Global plugins are already enabled.
- Testing model discovered: `codex/gpt-6-luna`. No configured launch profiles.
- Phase 1 test session: `8c65c2a2-960b-4d0b-b9b8-782a8bc29029`, workspace `wks_1b4e2fc48dd38d30`.
- Luna integration finding: Paseo rejects literal `HEAD` as a worktree base. Default now resolves the selected source repo's named branch; blank-default and non-default branch live retests passed.
- Revised card session: `6c18d210-afa6-4b36-9550-60301a87767c`, `codex/gpt-6-luna`; actual writes in both repos under default scope and only repo-two after a scope edit were verified.
- Duplicate directory workspaces observed after stale CUA element actions are not yet attributed to product provisioning; preserve evidence and test controlled same-operation retries separately.
- Project-local npm registry is public npm; SDK 0.11.2 was missing from the mirror used by the first install attempt.
