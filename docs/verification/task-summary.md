# Task Summary live acceptance

Date: 2026-10-15 (Asia/Singapore)  
Test session: `dddf746d-0f5c-4a25-8ab7-ec45a17ea610` — `codex/gpt-6-luna`; fixture worker created with `modeId: full-access`.  
Plugin was already installed/reloaded. This run did not reinstall it, restart the daemon, or interact with either Paseo desktop window.

Raw RPC/CLI snapshots, IDs, timings and cleanup results: [live-evidence.json](fixtures/task-summary/live-evidence.json). Reproduction/cleanup harness: [live.mjs](fixtures/task-summary/live.mjs). The harness and this report are the only files written by this test, both under `docs/verification/`.

## PASS

- `npm run typecheck`: PASS, exit code 0.
- `npm test`: PASS — 42 files passed, 12 skipped; 219 tests passed, 63 skipped (4.35 s).
- Baseline snapshot: 25 Paseo projects and 33 listed agents. The fixture project/card and worker session were created only after this snapshot. Fixture project `311fddb7-d5d3-4500-bd18-b24e64fa793f`; card `e0613a90-eb63-48df-badc-68628f6ace83`; no-session card `f737f8e9-fd65-4bbf-821d-72ab1369d969`; workspace `wks_779c065a5e93ae76`; temp directory `/private/var/folders/0b/f1crzdg95g5fwbq49s_3pw9c0000gq/T/ultra-task-summary-hgCLYx`.
- Managed worker `0ea09b25-ebac-4f11-828d-e521eb6e8ea5` used `codex/gpt-6-luna`, full access, and finished each requested turn. The substantive turns created/appended only `summary-fixture.txt` inside its fixture workspace.
- The first substantive turn produced a Haiku 5.5 summary; the RPC poll observed it 12.0 s after the turn completed. State: “文件 summary-fixture.txt 已创建，等待验证”. Recap: “- 已读取 PASEO_AGENT_ID：0ea09b25-ebac-4f11-828d-e521eb6e8ea5\n- 已在当前 fixture workspace 创建 summary-fixture.txt，包含两条 bullet：文件已创建；下一步是验证\n- 这是一次小改动：新增一个文件，内容为指定的两条要点”. Next: “等待你进行验证，或给出下一条指令”.
- After the second substantive turn, history contained two versions newest-first. Newest Haiku 5.5 summary (31.9 s after the earlier version): State: “Fixture file has two bullets plus the appended verification line, waiting for verification”. Recap: “- PASEO_AGENT_ID reported: 0ea09b25-ebac-4f11-828d-e521eb6e8ea5\n- Created summary-fixture.txt in the fixture workspace with two bullets: file created; next step is verification\n- Appended a line stating the second verification pass completed\n- Change is small: one new file, plus one appended line”. Next: “Run verification, or wait for the next instruction”. This confirms cumulative recap and newest-first history.
- After `thanks`, version count remained 1 at the observation point (12 s later); no new version was added for that turn.
- `summaries.refresh` on the managed card returned `{queued:true}` and created an archived summarizer run. No third Haiku version appeared within the following 180 s; later automatic Luna update did produce the third version. Refresh therefore queued and ran, but did not yield a distinct saved version in this transcript.
- `summaries.refresh` on a card with no managed sessions rejected with “This card has no Kanban sessions to summarize yet.”
- Settings RPC original values were `{summaryEnabled:true, summaryModel:""}` (revision `missing`). With `summaryEnabled:false`, the next completed turn left the version count at 2. With `summaryModel:"codex/gpt-6-luna"`, the next completed turn wrote a third version in about 12 s, recorded with model `codex/gpt-6-luna`. Original settings were restored and reread as `{summaryEnabled:true, summaryModel:""}`.
- All six fixture-tagged summarizer agents (five Haiku and one Luna) were archived; inspected records had empty pending-permission lists. The fixture worker is archived (`ArchivedAt: 2026-10-15T07:26:09.058Z`). At final verification, `paseo agent ls` returned no non-archived summarizers with this fixture task label.
- Cleanup PASS: `projects.remove` with `alsoPaseo:true` returned `removed:true`, `workspaces:2`, no error. The fixture project is absent from the board and native project registry; both fixture workspaces are absent from native resources; history for the removed task is empty; the temp directory is gone; both project-owned backup files were deleted. `summaries.json` has no fixture-card entries/errors. The summarizer runtime directory was left in place.

## FAIL

- **Summarizer directory creates native Paseo resources.** The baseline project list had no `/Users/bofan.wang/.paseo/plugin-data/paseo-ultra-kanban/summarizer` project and the baseline agent list had no summarizer sessions. During the live run, Paseo registered project `prj_412511933770de17` (`summarizer`) and `resources.list` showed eight workspaces under that directory (all status `done`). These records persist after the test. They include sessions from this fixture and from a concurrent Kanban test/session; I left the shared project/workspaces untouched. This contradicts the intended isolation noted in the spec and makes summarizers visible through Paseo project/workspace listings.
- A fixture-task summary error was recorded at `2026-10-15T07:22:41.818Z`: “The summary model's output did not match the schema.” The error was later cleared by a successful version. The captured per-turn evidence cannot attribute this transient error conclusively to `thanks` versus the subsequent refresh, so it is reported as an observed intermittent error, not a proven cause.

## UNRUN

- UI/settings-screen verification: UNRUN. No desktop windows were touched; no separate headless web client was prepared.
- Automatic summary from a failed/cancelled worker turn and attention-specific summarizer behavior: UNRUN.

## Follow-up after the user chose option B (2026-10-15, implementation session `17975bba`)

- Fix for the FAIL above: summarizers now run as a child (`parent` = the session whose turn ended) inside the card's own workspace via `paseo.workspaces.ref(id).agents.create`. Board views hide them by label (`client/resources.ts`, `server/agent-service.ts`). The remove/wrap-up running checks still count them.
- Leftover cleanup: native project `prj_412511933770de17` (`summarizer`) deleted with `paseo project delete`, which removed 9 workspaces. Its 9 sessions were all summarizers created by this feature and none were running. The empty `plugin-data/.../summarizer` directory was removed.
- Root cause of the intermittent schema error: Haiku returned `recap` as a JSON array (Paseo's Claude provider does not enforce `outputSchema`). The parser now joins arrays into `- ` lines, accepts `"true"`/`"false"` and missing fields when `update=false`, and the prompt states that values are strings.
- Live re-check (plugin reloaded): `summaries.refresh` on card `8c22cc02` wrote a Haiku 5.5 version 12 s later with no error. Native project count stayed 24, i.e. no new project/workspace, and 0 unarchived summarizers (`paseo ls -g --label ultra-kanban=summarizer`).
- `npm run typecheck` PASS; `npm test` 220 passed / 63 skipped.
- Still UNRUN: UI rendering (card line, Progress section, settings page) in the real app; whether Paseo shows a finished notification for the child summarizer.
