# Automation/sub-card review hardening

The interrupted Claude workflow was recovered, not restarted. Its resumed run completed 10 reviewers, 252 verification calls and one critic; only synthesis failed at quota. Latest result: 114 confirmed entries, four plausible entries and eight rejected entries. Fifty-four duplicate entries collapse into about 64 concerns. [Recovered plan and complete finding mapping](automation-review/recovered-plan.json).

## Changes

- Role-bound session preparation, distinct implementer/reviewer identities, preserved role sessions across runs, fresh ownership/generation checks before external effects, and serialized sends. Stop/archive/take-over cannot be overwritten by an old decision.
- One durable pending instruction per job with immutable message identity and original payload. Native completed receipts replay safely; unknown receipts pause for a person. Busy sessions and active peer roles defer sends. Stale missing starts recover; missing idle turn outcomes release capacity conservatively without inventing lifecycle facts.
- Human-stopped and failed children require human Run again. Creation has atomic per-card and lineage budgets; signed requests share the normal receipt namespace. Card/link/queue/receipt commits are atomic. Current parent relationship, scope and revisions are rechecked. Link capacities and mixed hierarchy/dependency cycles are checked before workspace creation.
- Parent wake respects enabled/archive/capacity and physical directory ownership. Transitive sibling dependencies can settle for parent acceptance; external prerequisites still hold. Bounded handoffs expose real delivery/workpad/branch/blocker evidence. Rework preserves the parent's note. CLI fallback now supports create-card, update-card and submit-review.
- Consecutive failure counters reset on success; explicit provider limits cool down with a bounded budget and shared provider gating. Actual new delivery events distinguish rework from casual answers. Reviewer-only nudges, accurate verdict/held-blocker signals, available Stop, functional picker updates, narrower drawer subscription, automation Attention, honest memory/summary attribution and translated onboarding.

## Passed

- `npm run typecheck`.
- `npm test`: **980 passed, 65 skipped**, 119 test files passed and 13 skipped. [Output](automation-review/full-tests.txt). The 65 skips predate this work.
- Key added regression cases copied to an isolated checkout of **d143a86**: **25 failed**, as expected before the fix; [output](automation-review/base-regressions.txt). The temporary tree used symlinked dependencies, had no daemon access and was removed.
- Native project inventory before/after offline tests: four projects before and after, no additions/removals. CLI test stubs now fail closed; resolver tests cover executable override, invalid override and app bundle layout. Dispatchers are drained before test stores are deleted.
- Independent read-only audit found stale handoff snapshots, fast creation acknowledgments, provider attribution, unknown receipts, physical ownership after Stop, and lifecycle freshness races; these were fixed before the final test run.

## Live acceptance

Luna validator: `a0c74ff7-e334-4309-9aad-965ea5f93d01`, `codex/gpt-6-luna`, explicitly full-access. Real daemon: `srv_BSheQn5lzdEE`, `127.0.0.1:6767`, Paseo 0.12.0. The installed code revision `0caefa58` passed real project-setting persistence and lane validation, one-child parent orchestration, wait/wake with branch/check handoff, integration/acceptance and real reviewer approval, plus desktop/compact board inspection. [Live report and cleanup](automation-review-live.md). Stop/Run again, project-disable, blocker-reason display and reviewer-changes rework remain live UNRUN; their relevant core paths were checked offline. No physical Android device test is claimed. All fixture resources and the validator were removed or archived; final native inventory was reconciled with the concurrent fixture cleanup.

## Deliberate decisions and limits

- Preserve the accepted independent-card `subCard=false/start=now` behavior; bound the whole creation lineage instead of silently removing it.
- Preserve the spec's Done/Cancelled-only child completion counter. Archived unfinished cards are settled for supervision, not completed work. Optional invalid-parent picker affordances and warnings about existing ordinary sessions remain polish; server validation is authoritative.
- Keep ordinary bounded failure policy for authentication/model-configuration errors; no additional speculative terminal-error classifier was added.
- Paseo 0.12 has no atomic idle-only send. The refreshed busy check plus explicit steer avoids the known default-interrupt path, but the host can fall back to interruption if a new turn races the request and steering is unavailable. This limitation is documented; strict non-interruption needs a host API change.
- When an entire native outcome is absent, idle proves only that execution stopped. Recovery asks a person rather than fabricating success or retrying uncertain paid work.
- A session creation already accepted by the daemon can finish after Stop. The plugin cannot revoke that request and does not interrupt sessions; it rechecks all subsequent effects and never attaches the stale generation to a new job.

## Source and recovery

Original Flowly source: managed Git installation from `file:///Users/citrine/Projects/flowly-kanban/flowly`, revision `d143a86366e502569aa9b59157b8f8f2cee55946`. Data backup: `/Users/citrine/.paseo/backups/flowly-review-20261022-162621/plugin-data`; source metadata is beside it. The separately installed kanban plugin is untouched. The final installation remains a managed checkout from this stable repository/ref, not a disposable worktree.

To restore the original source: `paseo plugin update flowly --ref d143a86366e502569aa9b59157b8f8f2cee55946`. New create/update-card receipt actions and subtask links require a compatible board when downgrading. Use the saved data only if no later real writes would be lost; otherwise migrate current records first. No automatic data rollback was performed.
