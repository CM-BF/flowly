# Answer agent questions and approvals in the session

Status: implemented 2026-10-18 (card "提问能力接入"). User request: when an agent asks through its ask-user-question tool, the card shows attention but the question is not visible in the Flowly session; the user has to jump to the native Paseo session. Show the question in the Flowly session and answer it there. This adds to SESSION-UX / SESSION-ATTENTION; no board, task, project or receipt contract changes.

## 1. Capability

- Paseo forwards a provider's ask-user tool (Claude `AskUserQuestion`, Codex async questions, OMP/Pi ask-user) as a pending permission request with `kind: "question"` and `input.questions: [{ question, header, options: [{ label, description? }], multiSelect?, allowOther?, allowEmpty?, placeholder?, dismissLabel? }]`. Tool, plan and mode approvals are pending requests of other kinds.
- The public SDK already exposes both halves: `PaseoAgent.pendingPermissions` on every agent snapshot (the streamed live agent list and `agent.refresh()`), and `PaseoAgentHandle.respondToPermission({ requestId, response })`. No private client, local daemon connection or new RPC is needed.
- Answer encoding is Paseo's own question form (read from the 0.11.2 app): `{ behavior: "allow", updatedInput: { ...request.input, answers } }`, `answers` keyed by question **header**; several chosen labels (and typed "Other" text in a multi-select) are joined with `", "`; typed text replaces the choice in a single-select. The provider maps headers back to the full question text. Dismiss sends `{ behavior: "deny", message: "Dismissed by user" }`, except when every question is free-text with `allowEmpty`, which submits empty answers.

## 2. Behavior

- Session preview: while the selected session has pending requests, a bounded box (scrolls past 420 px desktop / 320 px compact) sits directly above the composer, warning-tinted, so it stays in view however long the transcript is.
  - `question`: header, question text, options as radio buttons (single) or checkboxes (multi, "Choose one or more"), an "Other…" text box when `allowOther` or there are no options (placeholder from the request when given). On web, Enter in that box submits the form when every question is answered (Shift+Enter is a new line; IME composition and key repeat are ignored, as in the composer); on phones the return key stays a new line. **Submit answer** is enabled once every question is answered; **Dismiss** (or the request's `dismissLabel`).
  - Any other kind: title (or tool name) and description, "Open in Paseo for the full details.", then the provider's `actions` (e.g. plan implement/dismiss) or **Deny** / **Allow**. Full tool-call detail stays in Paseo.
- Responding counts as an interaction (reads the session), re-checks fresh membership (`workspaceSession(..., true)`: same workspace, not archived, provider available) and that the request is still pending; otherwise "This request was already answered or withdrawn." Then `respondToPermission`, toast **Answer sent** / **Response sent**, jump to the latest output, refetch the agent and tail. Errors appear in the composer's error notice; the form keeps what was chosen. Controls are disabled while any operation on the session runs or the session cannot be written.
- The form is keyed by request ID, so a new request starts empty and a request answered elsewhere (Paseo, another client) disappears on the next agent update.
- Sending a message while a request is pending keeps the existing behavior (a queue becomes interrupt, as in Paseo).

## 3. Status and attention

- A session whose pending request is a question shows **Waiting for your answer** (MessageCircleQuestion) instead of **Waiting for approval**; both use the warning tone and suppress the "· Unread" suffix.
- `sessionAttention` gains `question` (pending request is a question). The workspace summary counts such sessions under `questions` and no longer under `permissions`; the card shows **Needs you** for them rather than "1 approval". Attention items count them as `questions` (plus `asks`), not `permissions`; Needs-you totals, ordering and badges are unchanged.

## 4. Onboarding

- New one-time tip `agent-question` (highest priority, before `needs-you`): shown the first time a session in the current project waits on an agent question — "An agent is asking you something. Open the card's session to answer it right there, no need to switch to Paseo." As a new tip id it is shown once to existing users too.
- Tour feature "Needs-you reminders" adds "Answer questions and approvals right in the session."

## 5. Architecture

- `shared/permission-question.ts`: pure parsing, draft transitions (choose / type other), answered checks, answer and dismiss replies, `pendingRequests`, `asksQuestion`. Unit tests in `shared/permission-question.test.ts`.
- `client/session-question.tsx`: `PendingRequests` (memoized; RN primitives, `TextBox` for typed answers, shortcut block while focused).
- `client/session-preview.tsx`: renders it above the composer and owns the respond action.
- `client/session-state.ts`, `shared/session-attention.ts`, `client/attention.ts`, `client/card.tsx`: labels and counts above.

## 6. Verification

- PASS: typecheck; unit tests for parsing, single/multi selection, Other text, Paseo-compatible answers, dismiss rules, malformed host data; attention question-vs-approval counts; tip priority; i18n catalogs (19 new strings, 9 languages).
- PASS (live, user, 2026-10-18): single select "C", multi select "A, B, Z" (two options + Other), Other-only free text, and Dismiss (agent received "Dismissed by user"). User feedback: Enter in the Other box did not submit → fixed (above).
- PASS (live, user, 2026-10-18): tool approval (create and delete a file) shown and answered from the Flowly session after the user switched the session to an always-ask mode. A read-only command right after the switch ran without an approval request.
- UNRUN: phone layout, a plan approval from the session, and the Luna 6 test session. See `docs/PROGRESS.md`.
