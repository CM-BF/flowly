# Unattended projects and requirement-driven review: live verification

Branch `fix/unattended-review` at `d123025` (AUTOMATION-SPEC §5.3), installed on daemon `srv_BSheQn5lzdEE` (Paseo 0.12.0) with `install-exact.py` (label `unattended-d123025`; data, settings and source backed up; all 18 automation jobs unchanged). The pages were driven on the real `https://app.paseo.sh` in headless system Chrome through `docs/promo/shot-lib.mjs`. Evidence (screenshots, run log, ledger) is kept locally under `~/.paseo/verification/flowly-unattended-20261026/`; it holds fixture content only.

Fixture: repository `plugin-test-flowly-unattended-20261026` (one README commit), Flowly project `plugin-test-2026-10-26-unattended` (`152f15f1`, native `prj_09f3ef6d15225b7a`), implementer and reviewer `codex/gpt-6-luna` with low reasoning, full access, one review round.

## The Unattended switch (Edit project → Agent automation)

| Scenario | Result |
| --- | --- |
| The switch and its description show under Full access | PASS (desktop and compact 430 px) |
| Turn it on and save | PASS: the project's stored `automation` gains `unattended: true` |
| Reload the page and reopen the settings | PASS: the switch is on |
| Turn it off and save, reload | PASS: the key is removed, not stored as `false`; the switch is off |

Flowly's switches render `role="switch"` without `aria-checked` on the web, so a script (or a screen reader) cannot read their state from the page; the states above come from `board.json` after each save and from the screenshots. That is an existing accessibility issue of every Flowly switch, not part of this change.

## A real agent asks in an unattended project

A card (review level Light) told the agent to ask a person first with `flowly_report_progress kind=question`, record what Flowly answered, create `NOTE.md` with one exact line and deliver.

| Check | Result |
| --- | --- |
| The implementer's first instruction | PASS: contains "This project runs unattended: nobody answers questions…" and the best-effort rule ("Doubt is not a reason to stop") |
| The question call | PASS: the MCP call returned `UNATTENDED` with the implementer message; no question event, the job never entered `needs_human` |
| What the agent did next | PASS: recorded the refusal in the workpad, created `NOTE.md` (bytes `unattended fixture\n`), delivered with the error code quoted, no reminders |
| Review | PASS: Light review round 1 of 1 approved in 23 s, citing the delivery note |
| Cleanup | PASS: card deleted with Archive (2 sessions archived), project removed from the board and Paseo, no native project or workspace left, preparation files, `removed/` copies and the repository deleted |

The whole card took about two minutes.

## Not verified live

- The review changes (requirement and prohibition audit, convergence, the reviewer deciding instead of asking) and the narrowed Deep criteria on real tasks: the benchmark agent reruns the Flowly group on this branch against `69422d88` and the native group.
- The classifier helper's speed settings on a fast project (unit-tested with the fake SDK only).
- A reviewer's question refused live, `status=blocked` refused live, and provider question tools (Claude AskUserQuestion, Codex ask-user) in an unattended project, which Flowly cannot intercept (documented limit, §5.3.4).
