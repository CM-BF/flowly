# Upstream sync to 19e9662 (v1.8.0 line): live verification

Branch `sync/upstream-1.8`: merge commit e58b324 (upstream JasprW/flowly up to 19e9662) plus five fix commits (0eeadd0 to dadae9d) from an independent three-reviewer check. Upstream 9547db0 (#92) and later need Paseo >= 0.15 and were left out: the daemon `srv_BSheQn5lzdEE` runs Paseo 0.14.0. Installed with `install-exact.py` (data, settings and source backed up; all 24 existing automation jobs unchanged); plugin `running`, no startup errors. Screenshots under `~/.paseo/verification/flowly-sync18-20261108/` hold fixture content only.

Checks: `npm run typecheck`; `npm test` (293 files, 2788 tests).

## Fixture runs (codex/gpt-6-luna, low; Auto review on by default in every new project)

| Project | Card | Result |
| --- | --- | --- |
| f, adaptive | `units`, split requested by the first session only | Split into 2 items: 2 fresh item sessions, then an integrator; delivered without review. Flowly's MCP reached the session at launch (upstream #88) and offered `flowly_split`. 0 Auto review events. The delivered tests pass. | 
| g, managed with reviewer | `vowels` | The implementer used the card tools (acceptance list 3/3) and delivered; one review round by Flowly's reviewer, approved. 0 Auto review events (automation reviews automation cards). |
| h, managed, acceptance + tournament of 2 | `top_words` | The candidates delivered; the judge got its two tools at launch, activated c1 → c2 → c1 and chose c1. 0 Auto review events. |

## Web UI (https://app.paseo.sh, desktop 1600 px and phone 430 px)

No page errors. The board shows upstream's Guardrails and Search entries next to the fork's chips; the Tree chip appears only when a project has sub-cards (unchanged). Search and Guardrails pages open. The drawer shows Agent automation and the acceptance list. Edit project shows the fork's Mode (Adaptive / Managed), Acceptance tests and Tournament, and upstream's Auto review. On the phone, upstream's lane pager swipes between lanes, with the floating New task button.

## Cleanup

All three projects were removed from the board and Paseo through the UI (their sessions archived with them). Adaptive, tournament and acceptance data, removed copies, preparation files and the repositories were deleted. `paseo project ls`, `paseo workspace ls` and `paseo ls` show nothing of the fixtures.

## Not verified live

- Auto review on a card without automation (upstream's own path; covered by upstream's tests).
- A Done blocker's live branch fallback, and handoff branch hints for cards delivered before the sync.
