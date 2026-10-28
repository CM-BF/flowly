# Acceptance-test review: live verification

Branch `feat/acceptance-review` (AUTOMATION-SPEC §5.4), installed on daemon `srv_BSheQn5lzdEE` (Paseo 0.12.0) with `install-exact.py` at each commit below (data, settings and source backed up; every existing automation job unchanged). Pages were driven on the real `https://app.paseo.sh` in headless system Chrome through `docs/promo/shot-lib.mjs`. Evidence (screenshots, run logs) is kept locally under `~/.paseo/verification/flowly-acceptance-20261027/`; it holds fixture content only.

Fixtures: repositories `plugin-test-flowly-acceptance-20261027` and `…-20261027b` (one README commit each), Flowly projects `plugin-test-2026-10-27-acceptance` and `…-acceptance-b`, implementer, reviewer and author `codex/gpt-6-luna` with low reasoning, full access, unattended, two review rounds. Each card was a small Python function with examples and a "no other files" prohibition.

## Runs

| Commit | Card | What happened | Outcome |
| --- | --- | --- | --- |
| 41ae497 | slugify | A hidden test contradicted itself; the reviewer asked the implementer to "fix the test" and quoted its path; the implementer edited the hidden test and passed round 2 | FAIL → 115182d: faulty tests are the test's error, holdout paths redacted from change requests, suites read-only with a pristine copy and a guard |
| 115182d | slugify (again) | Author wrote both suites in about a minute in its copy; round 1 visible+holdout 8/1 → changes, snapshot `cycle-1-round-1`; round 2 9/0 → approved | PASS |
| 115182d | count_words | Approved in round 1, but the reviewer put the counts only in its text (`acceptanceRuns` empty) | FAIL → 216eca0: `ACCEPTANCE_REQUIRED` refuses a verdict without counts once the tests are ready |
| 216eca0 | (cleanup) | Each author session had registered its env copy as a separate Paseo project "env", left pointing at a deleted folder | FAIL → 6ec0b1f: the author runs in a directory workspace of the card's own Paseo project, archived when it ends |
| 6ec0b1f | is_palindrome | Author workspace listed under the fixture project, archived when the tests were ready; no `env` project at any point; review 5/0 + 9/0 approved round 1. The implementer looked while the tests were still being written, then retyped the data path with a dropped character and delivered saying the suite was missing | PARTIAL → 62c6f79: get_task returns whole quoted commands (`run`, reviewer-only `holdoutRun`), and the implementer checks again before delivering while the state is writing |
| 62c6f79 | rle | Implementer started while the tests were being written, ran the visible suite once ready (`ACCEPTANCE passed=6 failed=0`) and quoted it in the delivery; reviewer 6/0 + 9/0, approved round 1; no `env` project | PASS |

## Edit project → Acceptance tests

| Scenario | Result |
| --- | --- |
| The switch and its description show under Review levels | PASS (desktop 1600 px and compact 430 px) |
| Turning it on shows the Acceptance author model group | PASS |
| Save | PASS: the project's stored `automation` gains `acceptance: {}` |
| A fresh page load, then reopening the settings | PASS: switch on, author group shown |

The page restores the last selected project after a reload, which is not necessarily the fixture; the reload check therefore opens the fixture project by name in a fresh page.

## Cleanup

Cards deleted with Archive and delete, projects removed from the board and Paseo through the UI, author workspaces archived, the two leftover `env` projects deleted with `paseo project delete`, acceptance data, `removed/` copies, preparation files and both repositories deleted. `paseo project ls`, `paseo workspace ls` and `paseo ls` show nothing of the fixtures.

## Not verified live

- Whether the mode improves results on real tasks: the benchmark agent runs a paired comparison on selected tasks.
- The revert path (`acceptance_reverted`) and the tamper guard on a real session: unit-tested only; no live rework made the counts worse.
- A Claude author or reviewer, a non-git workspace, and an author that times out.
