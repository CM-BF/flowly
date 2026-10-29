# Tournament mode: live verification

Branch `feat/tournament` at `abb2964` (AUTOMATION-SPEC §5.5), installed on daemon `srv_BSheQn5lzdEE` (Paseo 0.12.0) with `install-exact.py` (data, settings and source backed up; all 24 existing automation jobs unchanged). Pages were driven on the real `https://app.paseo.sh` in headless system Chrome through `docs/promo/shot-lib.mjs`. Evidence (screenshots, the run's `tournament.json`, `plans.md`, the phase log) is kept locally under `~/.paseo/verification/flowly-tournament-20261028/`; it holds fixture content only.

Fixture: repository `plugin-test-flowly-tournament-20261028` (one README commit), Flowly project `plugin-test-2026-10-28-tournament` with implementer, reviewer, planner, judge and acceptance author `codex/gpt-6-luna` (low), full access, unattended, acceptance tests on, a tournament of 2. The card asked for `top_words(text, n)` and left the order of equal counts open on purpose.

## The run (5 min 23 s)

| Phase | What happened | Result |
| --- | --- | --- |
| Planning | The planner read its copy and wrote two plans that differ in the tie rule. The acceptance author started at the same time. | PASS |
| Implementing | Two candidates, each in its own copy (`tournament/<taskId>/c1`, `c2`), both delivered in under a minute. The planner and candidate workspaces were archived. No Paseo project was created at any point. | PASS |
| Waiting | The judge did not start until the acceptance tests were written. | PASS |
| Judging | The judge saw its two tools. It activated c1, then c2, then c1 into the real workspace, and ran both suites and its own probes. It ruled on 2 disagreements: the tie order, and one holdout check whose expected count was wrong (disputed with the card text). | PASS |
| Decision | Winner c1: 10 passed and 1 failed, with that failure disputed, so 0 undisputed. c2: 5 passed and 6 failed, 3 of them disputed, so 3 undisputed. Only c1's files are in the workspace (byte-identical to `c1/words.py`). The job is `delivered` (approved, no review rounds). The card moved to In review. The activity shows "The tournament delivered its winner" with the counts and the summary. | PASS |
| Evidence | `tournament.json` holds each candidate's plan, delivery note and file manifest (29 files with SHA-256), the judge's counts, disputed checks, probes, disagreements, winner and final counts, and the activation log. Both candidate trees and `pristine/` were kept. | PASS |

## Edit project → Tournament

| Scenario | Result |
| --- | --- |
| The choice (Off / 2 candidates / 3 candidates) and its description show under Acceptance author | PASS (desktop 1600 px and compact 430 px) |
| Click 3 candidates, Save, open the page again | PASS: stored as `tournament: { size: 3 }`; 3 candidates is selected after reload |

## Cleanup

The project was removed from the board and Paseo through the UI. The card went with it, and its judge session was archived. The repository, `tournament/` and `acceptance/` data, `removed/` copies and preparation files were deleted. `paseo project ls`, `paseo workspace ls` and `paseo ls` show nothing of the fixture.

## Not verified live

- The fallbacks: planner skip, no candidate delivering, and the judge never submitting and being picked automatically. These are covered by unit tests only.
- A Claude planner, candidate or judge; a git worktree card; 3 candidates; candidates with a `flowly-apply.sh`.
- Selection accuracy on real tasks: that is the benchmark's paired run.
- The card showed "Handoff needs checking · 2 unresolved items" after delivery: no implementer acknowledged the handoff record, because the candidates do not use card tools. This is harmless for benchmarks and is a follow-up for real use.

## Second run: independent candidates (`8fa510c`, default `plans`)

After the benchmark's 10-task run (1 of 18 candidates passed; the planner had spread different readings of the card over the candidates), candidates became ordinary implementers by default. Fixture project `plugin-test-2026-10-28-tournament-b`, same models, card `top_words` without the tie-order hint.

| Check | Result |
| --- | --- |
| No planner: both candidates started at once, each prompt beginning with the card's title and description (no "as data", no readings) | PASS |
| Candidates delivered in 30 s; the judge started once the acceptance tests were ready, activated c1 → c2 → c1, ruled on 2 disagreements (tie order; non-ASCII letters per the card's "a-z") and disputed one wrong check per candidate | PASS |
| Winner c1 delivered, card In review; whole run 3.5 min | PASS |
| Edit project → Candidates (Independent / Different approaches): Independent selected by default; choosing Different approaches and saving stores `plans: "approaches"`, still selected after reload; desktop and compact | PASS |
| Cleanup: card and project removed through the UI, data and repository deleted | PASS |

Seen, not changed: during the whole tournament the card shows "Starting agent…" (the held implementer job), and its one-line summary comes from the judge's messages.
