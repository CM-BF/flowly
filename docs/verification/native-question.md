# Native question tool under the Flowly skill (SESSION-QUESTION-SPEC §2.2)

Date: 2026-10-20. Card "提问方式优化". Script: `docs/verification/fixtures/native-question/run.mjs`, raw output: `fixtures/native-question/evidence.json`.

Setup: a temporary Tinylink card "[test] Default short-code format" (`a24e77c2-f500-4f58-ab4d-706fa822ee87`, its own workspace `wks_25d254d91f9697d2`). The card leaves two decisions to the user (code length, alphabet) and says not to edit files. One `claude/claude-sonnet-5-5` session (`fcbad8f1-a9bc-42a3-83fc-4ff97d1384e4`, `bypassPermissions` = full access) was created the way the card's "New session" does: `tools.prepare-session`, Flowly MCP, skill as system prompt, prompt "Work on this card." The prompt did not name a question tool.

| Check | Result |
|---|---|
| Asks through AskUserQuestion | PASS: one pending `kind: "question"` request, tool `AskUserQuestion`, both decisions in one call (headers "Code length", "Alphabet"), two options each |
| Card shows Needs you | PASS (data): the session had a pending question while running, which is the input to `sessionAttention().question` → workspace summary `questions` → the card's **Needs you** signal (`client/card.tsx`). The board UI was not looked at |
| No kind=question report | PASS: 0 `reportKind: "question"` events, both while waiting and at the end |
| Continues in the same turn after the answer | PASS: answered "6 characters" / "base62" with the drawer form's reply format (`{ behavior: "allow", updatedInput: { ...input, answers } }`, keyed by header). There was 1 `turn_started` and 1 `turn_ended` in total, and the agent then reported `kind=result` with exactly those choices, plus `nextMoves: []` |
| Cleanup | PASS: `tasks.delete` with archive (backup in `removed/`): 1 session archived, workspace archived. Card gone from the board, session `archivedAt` set, workspace not in `paseo workspace ls`. The Tinylink project, its directory and its other cards were untouched |

Not covered: answering by clicking the card drawer UI (the script sends the same SDK call the drawer makes, `respondToPermission`); a Codex session; Luna 6.

Observation: the session never set a work stage. The card stayed in Todo, because a decision-only card has no design/development work. This is not part of this change.
