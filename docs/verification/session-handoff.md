# Hybrid session handoff: live verification

Branch `sw/hybrid-boundaries` (P1 card handoff plus P2 boundaries, comment routing and predecessor history), based on review-levels main `2e471e6`. Daemon `srv_BSheQn5lzdEE`, Paseo 0.12.0, real `https://app.paseo.sh` in headless system Chrome through `docs/promo/shot-lib.mjs`. Every install used `install-exact.py` (data, settings and source backed up; every automation job compared before and after). Evidence and full reports are kept locally under `~/.paseo/verification/flowly-session-handoff-20261024/` (`live-luna/retry/REPORT.md`, `live-P2/REPORT.md`); they contain fixture content only.

## Installed revisions

| Revision | What | Jobs compared |
| --- | --- | --- |
| `684a8fd` | P1 first install | 18 unchanged |
| `786d9cd` | P1 acknowledgement fix | 18 unchanged |
| `69422d8` | Capture-gap noise fix | 19 unchanged |
| `ca93c13` | P2 with idle-write, entry-collection and round 4 fixes | 18 unchanged |

## P1: fresh-session continuation (2026-10-25)

The first attempt (`684a8fd`) stopped with `no_delivery` before any fresh session; the cause was a product defect (acknowledgements refused again when only a checkpoint changed), fixed in `786d9cd`.

The retry on `786d9cd` passed: Stage A recorded seed facts and a nonce and asked through `flowly_report_progress kind=question`; an operator comment with a three-line Unicode marker was posted in the UI; the old session only recorded it; **Continue in a fresh session** in the drawer produced `automation_handoff_requested`, a finalize turn, `automation_rotated` and a different implementer in the same workspace; the successor read all five pages (174 records), acknowledged with its understanding, wrote the marker byte-identically (checked with `cmp`), passed `verify.mjs`, resolved the comment only after verifying and delivered; a Standard review approved.

It also found the capture-gap flood: 112 open gaps on a 30-minute card (one per Codex `exec` script call, plus unclassified record types), 89 of which the successor had to acknowledge. Fixed (`69422d8` and later): replaying the same rollouts now gives 0 open gaps and a 1-page full read instead of 15 pages; a compaction becomes a note, and background work that really keeps running still surfaces.

## Idle rewrites

After `69422d8` was installed, 18 of 22 cards' records gained a revision every 1-3 minutes with nothing changed but the operations ring. Fixed: a transaction that changes nothing writes nothing, Git is polled only for a session in a turn, and in-place observation writes touch a small observation file only. A 30-minute idle loop over several cards now writes 0 bytes (old: 64 writes, about 700 KB); a running turn with new data every minute writes about 335 KB per hour instead of 2.8-9.9 MB, with no unreferenced entry bodies.

## P2: comment routing and history-triggered rotation (2026-10-25, `ca93c13`)

| Scenario | Result |
| --- | --- |
| Clarifying comment, default recipient | PASS: delivered to the same warm implementer; one comment event; the agent recorded it as a decision |
| Save on the card | PASS: no turn started; the successor later followed it |
| Fixture-only `rotation.json` (bytesRotate 1 MiB for one task), reload | PASS: other jobs unchanged; override removed and reloaded afterwards |
| Marker comment, default recipient | PASS: `automation_rotated` after history; route `auto / fresh` to a new implementer |
| Fresh session's first message | PASS: equal to the comment text after the provider's own environment context |
| Successor | PASS: acknowledgement, marker byte-identical, `verify.mjs` PASS; Standard review approved |
| Handoff record afterwards | 0 open gaps, all inputs resolved |
| Predecessor history search | PARTIAL at the time: the index kept only ~300 characters of tool arguments and no tool outputs, so the codeword was not found |

Fixed after this run: the composer no longer says "only live sessions are reviewers" when a person chooses Save on the card (`189507f`); the history index now keeps full tool arguments (head and tail), bounded redacted tool-output excerpts with the omitted middle located by byte range, and decoded escaped text; replaying the run's rollouts finds the codeword and the error and test lines within the 2 MiB bound; an approved card with nothing unresolved shows a neutral "recorded before later activity" line instead of a yellow warning, and names open problems when there are any (`f25b7e0`).

## Not verified live

The 1-hour cold-cache rotation, context-fill rotation, rotation in the middle of a review cycle, a second review cycle, Claude-provider sessions, the history search on an installed build after the coverage change (replayed on the real rollouts only), and phone hardware. Known limits: long test or module names of 40 or more letter-and-digit characters in tool outputs are redacted by the shared credential rule; workflow and sub-agent transcripts are not indexed.
