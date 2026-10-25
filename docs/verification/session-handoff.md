# Hybrid session handoff verification

P1 implementation branch: `feat/session-handoff`, based on review-levels main `2e471e6`. Runtime and real UI verification are still pending. P2 automatic boundary decisions have not been enabled.

## Scope and evidence

Card records retain original instructions, full questions and review notes, decisions with reasons, unresolved findings and gaps, Git observations, background handles and session lineage. Current files are bounded; long originals and older entries have explicit full-read paths. Acknowledgment proves that all current obligations have a disposition, not that an agent's understanding is correct.

Independent evidence is under `/Users/citrine/.paseo/verification/flowly-session-handoff-20261024/`: `capture-observer-independent-review.md`, `outbox-independent-review.md`, `id-independent-review.md`, and `cross-review/FINAL-RECHECK.md`. Formal regressions cover late/failed hooks, two successive replacement rollbacks, interrupted creation, review-round/model preservation, retired ownership, image retry conflicts, original message identities, destructive backup/restore, confirmation recovery after writer retirement, and duplicate IDs across current/archived sections.

The first full run passed 1848 tests and failed seven existing classifier timing cases. The classifier file passed alone; its 10 ms fake-model deadlines included real durable filesystem writes. Test-only budgets were separated from that unrealistic limit, and the shared-helper case now waits for observable creation. Product deadlines are unchanged. The original failed log is retained as `P1-tests.log`; the intermediate rerun is `P1-tests-recheck.log`. It exposed one more supersession test that edited the card before helper creation; that test now waits for the actual created helper. The final `P1-tests-final.log` passes all **185 files / 1855 tests**, and `P1-typecheck.log` passes. Product code and timeouts were unchanged by this test stabilization. The three final send/attachment/retired-owner mutations each failed without their guard and passed with it (`H/P1-root-mutations.json`).

## Client size

Using the installed daemon's esbuild 0.25.12 options and the existing reproducible `review-classifier-bundle.cjs`: main `2e471e6` is 1,404,034 bytes / 27,235 lines; P1 is 1,460,955 bytes / 27,948 lines, an increase of 56,921 bytes (4.05%). Phone startup timing is unrun.

## Pending real verification

- Exact-SHA managed installation with before/after snapshots of every original automation job.
- Full-access Codex GPT-6-Luna continuation through real card/agent tools, including original instructions and acknowledgment.
- Desktop and compact Handoff view, draft preservation and refresh.
- Exact-ID cleanup of fixture projects, cards, workspaces and sessions.

Unknown provider formats, skipped long lines, omitted narration and out-of-band processes are visible coverage limits. Flowly does not guarantee complete transcript capture or filesystem exclusion of an already-running external process. P1 does not activate the new 64 MiB/context/cold automatic rules.
