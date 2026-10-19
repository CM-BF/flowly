# Flowly naming verification (Luna)

- Session: `bc10675f-1b10-49dd-8cba-6ebbf2f18fd0` (`codex/gpt-6-luna`, full access at creation).
- Scope: source/runtime verification only; no implementation files changed. Card remains in Test.
- Runtime binding: `flowly_get_task` returned this session's task `bb3e8868-2a5c-4914-97f3-7b0c01896be4`; a progress checkpoint was recorded through `flowly_report_progress`.

## Results

- **PASS — MCP runtime and discovery:** the live Flowly MCP tool inventory exposed exactly 11 tools, all named `flowly_*`. A live scoped `flowly_get_task` call succeeded. `server/tool-server.test.ts` also asserts initialize server identity `flowly`, exact eleven-name list, and scoped calls.
- **PASS — session launch configuration:** `FLOWLY_CONTEXT_FILE`, `FLOWLY_CLI`, and `FLOWLY_SKILL` were set; CLI path ends in `flowly.mjs`; runtime CLI/context files exist. `index.server.ts` injects all three variables. No values containing credentials were printed.
- **PASS — skill packaging:** runtime `SKILL.md` is byte-identical to `skills/flowly/SKILL.md`; frontmatter declares `name: flowly`. Preparation uses MCP key/server identity `flowly` and generated instructions use the Flowly tool names.
- **PASS — compatibility paths:** tests cover `ULTRA_KANBAN_CONTEXT_FILE` fallback, old `ultra-kanban.mjs` compatibility after reload, stable endpoint and replay receipt, and copy-once non-destructive legacy data/settings migration. Summary tests retain recognition of `ultra-kanban` summarizer labels; new helpers use the `flowly` label.
- **PASS — requested tests:** `npx vitest run server/tool-server.test.ts server/naming.test.ts shared/summary.test.ts client/session.test.ts` — **4 files passed, 22 tests passed** (3.58s).
- **UNRUN:** full suite, typecheck, live scoped write (only the explicitly requested progress checkpoint was written), plugin reload, UI. These were outside this partial verification request.
- **Defects found:** none in reviewed launch paths or requested checks.

## Reviewed sources

`docs/FLOWLY-NAMING-SPEC.md`; `index.server.ts`; `server/tool-server.ts`; `server/cli-source.ts`; `server/skill-source.ts`; `server/service.ts`; `shared/summary.ts`; `server/tool-server.test.ts`; `server/naming.test.ts`; `shared/summary.test.ts`.
