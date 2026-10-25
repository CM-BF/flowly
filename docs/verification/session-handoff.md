# Hybrid session handoff verification

P1 implementation branch: `feat/session-handoff`, based on review-levels main `2e471e6`. Exact P1 `684a8fd` is installed; its first real continuation drill failed before replacement and is being repaired and retried. P2 `sw/hybrid-boundaries` is implemented and independently reviewed but remains uninstalled.

## Scope and evidence

Card records retain original instructions, full questions and review notes, decisions with reasons, unresolved findings and gaps, Git observations, background handles and session lineage. Current files are bounded; long originals and older entries have explicit full-read paths. Acknowledgment proves that all current obligations have a disposition, not that an agent's understanding is correct.

Independent evidence is under `/Users/citrine/.paseo/verification/flowly-session-handoff-20261024/`: `capture-observer-independent-review.md`, `outbox-independent-review.md`, `id-independent-review.md`, and `cross-review/FINAL-RECHECK.md`. Formal regressions cover late/failed hooks, two successive replacement rollbacks, interrupted creation, review-round/model preservation, retired ownership, image retry conflicts, original message identities, destructive backup/restore, confirmation recovery after writer retirement, and duplicate IDs across current/archived sections.

The first full run passed 1848 tests and failed seven existing classifier timing cases. The classifier file passed alone; its 10 ms fake-model deadlines included real durable filesystem writes. Test-only budgets were separated from that unrealistic limit, and the shared-helper case now waits for observable creation. Product deadlines are unchanged. The original failed log is retained as `P1-tests.log`; the intermediate rerun is `P1-tests-recheck.log`. It exposed one more supersession test that edited the card before helper creation; that test now waits for the actual created helper. The final `P1-tests-final.log` passes all **185 files / 1855 tests**, and `P1-typecheck.log` passes. Product code and timeouts were unchanged by this test stabilization. The three final send/attachment/retired-owner mutations each failed without their guard and passed with it (`H/P1-root-mutations.json`).

## Client size

Using the installed daemon's esbuild 0.25.12 options and the existing reproducible `review-classifier-bundle.cjs`: main `2e471e6` is 1,404,034 bytes / 27,235 lines; P1 is 1,460,955 bytes / 27,948 lines, an increase of 56,921 bytes (4.05%). Phone startup timing is unrun.

## Installed P1 and first real attempt

`P1-install-result.json` confirms exact managed `684a8fd`, with all 18 original automation jobs retaining their lifecycle fields across installation. The current managed path is `/Users/citrine/.paseo/plugins/flowly/f0e180ca-0678-48ac-93a0-aee05bd02b1a/checkout`. Data/settings/source backups are in `P1-install-backup`; use a managed update to the saved prior revision and restore the matching saved data/settings for a complete rollback, rather than merely downgrading code that does not understand the newer private scheduling fields.

The full-access Codex GPT-6-Luna tester `119a3b24-85ef-49c4-96eb-1aa4a67cdece` created one external fixture and one actual implementer. Stage A, the byte-exact typed original/comment linkage, full paginated reads and initial desktop/compact views passed. The live cycle then stopped with `no_delivery`, before any fresh-session click or successor creation. Successor ACK/action, real review preservation and note-draft refresh are **not passes**. The original test also mixed a native asynchronous question with the card's waiting point and had a contradictory nonce fixture; the retry removes these ambiguities.

Independent service-level probes reproduced a product defect: unchanged requirements could be refused again solely because a checkpoint or passive cursor changed the handoff revision. A stable semantic refusal fingerprint is being implemented; new original inputs, reviews and critical gaps must still require a fresh refusal. Evidence: `P1-soft-ack-independent*` and `live-luna/REPORT.md`. Exact-ID cleanup was independently verified in `live-luna/cleanup-root-recheck.json`: project/task/workspace absent, implementer archived, zero permissions and external path removed. UI refresh after deletion was unrun in that first attempt.

## Pending real verification

- Fix installation and successful continuation retry, retaining original failed evidence.
- Full-access Codex GPT-6-Luna continuation through real card/agent tools, including original instructions and acknowledgment.
- Desktop and compact Handoff view, draft preservation and refresh.
- Exact-ID cleanup of fixture projects, cards, workspaces and sessions.

Unknown provider formats, skipped long lines, omitted narration and out-of-band processes are visible coverage limits. Flowly does not guarantee complete transcript capture or filesystem exclusion of an already-running external process. P1 does not activate the new 64 MiB/context/cold automatic rules.

## P2 focused evidence

`P2-measure-independent-review.md`, `P2-history-independent-review.md`, `P2-comment-fix-recheck.md` and `P2-policy-independent-review.md` close the independently reproduced measurement, credential, comment-commit/retry and boundary races. The original policy probes pass 3/3 after repair; the false-no-op minute writes have isolated mutation evidence under `A-noop-fix/`. `P2-CLI-links-regressions.md` covers the generated CLI's actual loopback requests and cross-card privacy/budgets. Root comment/history/settings checks pass 41 tests, including unchanged board bytes after repeated tool calls without a silence signal. These are controlled tests, not claims of actual native send deduplication, cold-cache savings, real 200 MiB histories or phone timings.

The first P2 integration run caught two SDK-invalid camel-case RPC method names and two 5 s filesystem-heavy test timeouts. Methods now use valid kebab-case names; only the 21 durable-rejection and 5,001-sidecar fixtures have 20 s test limits, with product deadlines unchanged. Retained failure log: `P2-tests-integration.log`. Repaired full suite: **194 files / 1978 tests passed**, plus typecheck (`P2-tests-final.log`, `P2-final-typecheck.log`). This includes the P1 semantic-refusal and known-usage-metadata fixes. Client bundle by the same daemon options: **1,470,818 bytes / 28,033 lines**, +9,863 bytes / +85 lines over P1 (0.68%), +66,784 bytes over pre-handoff main (4.76%). Real P2 acceptance and phone timing remain pending.
