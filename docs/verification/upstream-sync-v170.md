# Upstream sync to v1.7.0: live verification

Merge of JasprW/flowly `e79d1d0` (v1.6.0 and v1.7.0, 61 commits) into CM-BF/flowly main `c42adc7`, merge commit `769f2b8`. Installed on daemon `srv_BSheQn5lzdEE` (Paseo 0.12.0, Electron 44.2) as local integration build `235bb5a` (this merge plus `fix/unattended-review`, PR #14) with `install-exact.py` (label `sync-v170-int-235bb5a`; data, settings and source backed up; all 19 automation jobs unchanged). Real `https://app.paseo.sh` in headless system Chrome through `docs/promo/shot-lib.mjs`, read-only. Evidence: `~/.paseo/verification/flowly-upstream-sync-20261026/` (screenshots of the owner's own board, kept local).

## SQLite migration

| Check | Result |
| --- | --- |
| Rehearsal on copies of the real board (1.7 MB, 26 cards, 1,175 events, 19 jobs, 22 handoff entries, 661 receipts) with upstream's code | FAIL on the first start, every time: "statement has been finalized" (a temporary statement finalized by garbage collection in the middle of `iterate()`), so Flowly stayed on JSON; a second start succeeded |
| Same rehearsal after reading rows with `all()` | PASS 3 of 3 fresh copies on the first start, about 0.1 s each; every collection byte-identical in the board read back and on disk |
| Live migration at install | PASS: "moved the board to SQLite in 256 ms (26 cards, 1175 events)"; `board.json` is the retirement marker, the original is in `migrations/`, the first daily backup exists |

## Web UI

| Check | Result |
| --- | --- |
| What's new after the update | PASS: shown, with the fork's telemetry text ("It is off in this build") |
| Board (overview) | PASS: automation signals ("Agent working"), the handoff signal ("Handoff needs checking · 7 unresolved items"), sub-card and check counts, upstream's running sweep |
| Drawer (card detail) | PASS: the automation section with the job's state and Stop, the handoff section, the parent's Dependencies and sub-cards; detail loading finishes |
| Settings → General | PASS: "Send anonymous usage data" switch off, "Off unless you turn it on … Sent to the upstream Flowly maintainer" |
| Settings → Storage | PASS: SQLite and backups listed |
| Edit project | PASS: PR #14's Unattended switch still present |
| Page errors | none |

## Not verified live

The compact drawer (the card was not on the first compact screen), restore from a backup and Export to JSON on the real board (covered by upstream's tests and the rehearsal copies only), a sent telemetry event (off by design), Azure DevOps (no connection), Insights v3 on real data, phone hardware.
