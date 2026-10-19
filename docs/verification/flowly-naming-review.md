# Flowly rename-only review and publish validation — 2026-10-19

Input: the user's explicit instruction to review, commit and push only this card's rename changes while preserving other tasks. Base: `50965f99686192f7cb027b94c4e4bda12531f824`, branch `main`, remote `origin/main`.

## Review

No functional defect found in the reviewed naming changes. MCP tool names, both session creation paths, CLI/environment names, packaged/runtime skill, new helper labels and compatibility readers agree. Signed inputs, authorization, schemas and receipts keep their contracts. Legacy provisioning keys intentionally stay stable to avoid duplicate resources on a retry.

The original worktree mixed this card with uncommitted Workflow insights and Attention dismiss implementations. A separate index was built from HEAD using only naming transformations and the task-owned compatibility/tests/evidence. For mixed files, only the rename was staged; unrelated feature code, catalogs, onboarding changes and untracked feature modules remain in the working tree. The two skill copies in the staged tree both omit the other feature's `projectScripts` addition and still match each other. Renames inside uncommitted feature-only additions remain with those additions.

An automated added-line audit found no `attentionDismiss`, `WorkflowInsights`, `insightFinding`, `projectScripts` or `WORKFLOW-INSIGHTS-SPEC` addition in the publish candidate. Byte hashes of all 869 existing tracked/untracked workspace files were unchanged during index construction. Only this task's own spec/progress/evidence was then updated. No stash, reset or working-tree checkout was used.

## Validation

Tested candidate tree before documentation-only review updates: `b6b469778b537f8e354f0243eab9ee65adb28f00`. The SHA-256 of the index's non-documentation entries is `23573305344b374698adb8f62f30cf219d3e4247f1491345e28c9d3f8a040efb`; the final publish candidate must retain this exact source/test manifest.

| Command and environment | Result |
| --- | --- |
| `npm run typecheck` in the isolated candidate checkout | PASS |
| `npm test -- --maxWorkers=2` in the isolated candidate checkout | PASS: 80 files / 534 tests; 12 files / 63 tests skipped |
| `git diff --cached --check` on the rename-only index | PASS |
| Added-line scope audit and worktree byte-hash comparison | PASS |

The first archive-only attempt had one Git-environment precondition failure (the git-stats test expects `.git`) plus seven 5-second test timeouts under default concurrency. With two workers, those seven passed and only the missing `.git` failure remained. Initializing a local test Git repository and rerunning the full suite with two workers passed all 534 tests without changing product code or test expectations. Exact temporary directories named by the failed cleanup were subsequently confirmed absent.

The original live [full-access Luna verification](flowly-naming-luna.md) remains the actual installed MCP read/progress-write and new environment/skill evidence. It ran before commit isolation; the isolated suite above validates the rename independently of other feature code. No native project, workspace or card is created during this review. Any final post-commit Luna verification session is test-owned; its identity, results and cleanup receipts are recorded on the card. Desktop/compact UI remains UNRUN because no UI interaction or layout changed.

The isolated checkout under `.test-data/flowly-naming-review` is removed after validation. Commit/push identity and remote alignment are recorded on the card after completion.
