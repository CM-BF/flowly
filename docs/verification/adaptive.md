# Adaptive mode: live verification

Branch `feat/adaptive` (AUTOMATION-SPEC §5.6), installed on daemon `srv_BSheQn5lzdEE` (Paseo 0.12.0) with `install-exact.py` at each commit below; every existing automation job was unchanged. Pages were driven on the real `https://app.paseo.sh` in headless system Chrome. Evidence (screenshots) is kept locally under `~/.paseo/verification/flowly-adaptive-20261029/`; it holds fixture content only.

Fixtures: repositories `plugin-test-flowly-adaptive-20261029{a,b,c}` (one README commit each) and Flowly projects `plugin-test-2026-10-29-adaptive-{a,b,c}`, all with implementer `codex/gpt-6-luna` (low reasoning, 258,400-token window), full access, `mode: "adaptive"`. Projects b and c set `adaptive.threshold: 0.01`, so the reminder fires on the first reading.

## Runs

| Commit | Card | What happened | Outcome |
| --- | --- | --- | --- |
| b1e1800 | a: `vowels` | One session, delivered to In review without review in 30 s. Its opening was the card plus two lines. The session's MCP server (queried directly) offered exactly one tool, `flowly_request_split`; the agent itself answered "none" when asked, because it searched files instead of its tools. | PASS |
| b1e1800 | b: `shapes` | Finished in 30 s, before the first reading mid-turn, so it was delivered without a checkpoint. | PASS (nothing to observe) |
| b1e1800 | b: `minicalc` | Read mid-turn at 20,650 of 258,400 tokens, so the required checkpoint was steered in. The agent finished its step, wrote progress.md with no items (everything was done) and the card was delivered. | PASS |
| b1e1800 | b: `units`, with "call the split tool first" in the card text | **Runaway.** Every item session got the card text again and split again, and this build's split request did not check the depth: 58 splits and about 100 sessions before I stopped the job by hand. No running sessions were left. | FAIL → d0ad9f3 checks the depth; 8c401c9 adds a budget of 20 sessions per card |
| d0ad9f3 | (design change) | Owner direction: the agent decides. `flowly_split({ plan })`, a single reminder, one sentence about the tool in the opening; no forced checkpoint and no tiers. | — |
| 8c401c9 | c1: `minicalc` | Reminded once (usage). The agent decided not to split and delivered in one session. | PASS |
| 8c401c9 | c2: `units`, instruction scoped to the first session | The first session called `flowly_split` with 3 items. Three fresh item sessions ran in order (two got the reminder; none split again), then a fresh integrator. 5 sessions in total, delivered. Item 2's opening contained a decision that item 1 had added to progress.md ("length factors are meters per unit"). The delivered code passes `python -m unittest` (37 tests). | PASS |

## Edit project → Mode

| Scenario | Result |
| --- | --- |
| Adaptive is selected; the review, acceptance and tournament settings are hidden; the Check command field shows | PASS |
| Choosing Managed brings the reviewer settings back and hides Check command | PASS |
| Check command `python -m unittest`, Save, open again: still Adaptive, command kept | PASS (desktop and compact) |
| The Adaptive description says the agent decides to split and Flowly reminds it once (53885932) | PASS |

## Cleanup

Cards deleted with Archive and delete (the runaway card's sessions archived with it), projects removed from the board and Paseo through the UI, and adaptive data, `removed/` copies, preparation files and repositories deleted. `paseo project ls`, `paseo workspace ls` and `paseo ls` show nothing of the fixtures.

## Not verified live

- The check command gate failing and sending the work back (unit-tested only).
- A compaction reminder (luna never compacted on these small tasks), a Claude implementer, and a git worktree card.
- Whether agents split when they should and only then: that is the benchmark's E1 (no unneeded splits on Terminal-Bench) and E2 (long tasks).
