# Card tree: live verification

Date: 2026-10-24 (UTC).
Environment: host `srv_BSheQn5lzdEE`, Paseo `0.12.0`, `127.0.0.1:6767`. Flowly was installed from `feat/card-tree` at `60d0284` with `paseo plugin update flowly --ref`. The owner's three live jobs (C5, C5b, C5b.3) were identical before and after the install.
UI: real `https://app.paseo.sh` in headless Chrome. Screenshots come from `docs/promo/shot-lib.mjs`, which excludes the host sidebar and other projects.

## Fixture

- Project `be8e50db-4219-4f64-97ae-a1fd1c11086a`, title `plugin-test-2026-10-24-card-tree`, git root `/Users/citrine/Projects/plugin-test-flowly-card-tree`.
- 16 cards, created and linked over the plugin RPC like `docs/promo/setup.mjs`.
- The tree is shaped like the owner's pipeline: a main item with two research cards and C1→C5 (blocks); C3 with C3a→C3b→C3c; C3b with C3b.1→C3b.2; and a second top-level item with two sub-cards.
- Depth reaches 3. There are 8 blocks links.

## Results

| # | Scenario | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Levels chip and menu | PASS. "Levels: All" sits in the overview bar. Its menu offers exactly the levels the tree has: "Top-level cards only · hides 14", "Down to level 2 · hides 5", "Down to level 3 · hides 2", "All levels". | `card-tree/01-board-all.png` |
| 2 | Fold by level | PASS. All shows 16 cards, Level 1 shows 2, Level 2 shows 11, Level 3 shows 14. The chip reads "Levels: 1 · 14 hidden", and the header shows "2 shown". | `02-board-level1.png` |
| 3 | Roll-up on visible ancestors | PASS. "Main item" shows "12 hidden below" and "Other item" shows "2 hidden below"; their accessibility labels say the same. Running and needs-you roll-ups were not exercised live, because the fixture had no sessions (see below). | `02-board-level1.png` |
| 4 | Lane footer | PASS. Empty lanes read "5 sub-cards hidden at this level". "Show 5 hidden sub-cards" reveals the 5 cards of that lane, for 7 cards in total. | `03-board-level1-footer-open.png` |
| 5 | Persistence | PASS. Level 1 survives a page reload. | Script output |
| 6 | Card tree page | PASS. "Card tree (T)" opens the outline of the 2 items, and the page shows only this project. Step numbers: research cards 1 1, C1..C5 1→5, C3a/C3b/C3c 1→3, C3b.1/C3b.2 1→2. Waits-for chips appear on blocked cards (C4 ⧗ C3: integration and others). Each item has a "Next:" line, a sub-card progress bar, and a 1/2/3/All Levels control in the header. | `04-card-tree.png` |
| 7 | Card face | PASS. A parent breadcrumb ("↰ C3: integration") and "Waiting on 1" appear on blocked cards. | `05-drawer-dependencies.png`, `06-compact-board.png` |
| 8 | Drawer Dependencies | PASS. The breadcrumb reads "Sub-card of Main item: new workspace › C3: integration". The map shows "Waits for: C3a (Done)", the card itself and "Blocks: C3c (Todo)", and the accessibility labels start with their relation. Below it are the sub-card steps 1 → 2 and "Show in tree". | `05-drawer-dependencies.png` |
| 9 | Phone width (430 px) | PASS. The board shows the Levels chip, breadcrumbs and the Tree chip in the bar. The tree page shows "Levels: All" in its header. The Dependencies map is stacked with "Waits for" and "Blocks" captions. | `06-compact-board.png`, `07-compact-tree.png`, `08-compact-dependencies.png` |
| 10 | One-time tip | Shown: "Open Tree in the bar above to see each item from the whole to its parts, with its steps in order. Levels hides deeper sub-cards on the board." | `02-board-level1.png` |
| 11 | Page errors | None in any run. | Script output |

## Not verified

- **Roll-up of running, needs-you, error and unread states from hidden sub-cards.** The fixture had no sessions. `client/board-levels.test.ts` covers these.
- **Held / "Queued after blockers" wording.** It needs automation jobs; unit tests cover it.
- **Phone timings and the cold-start cost of the +87 KB client source.** The `[perf]` marks exist but nothing was measured on the Samsung phone.
- **Physical phones.**

## Cleanup

The fixture project was removed with "Also remove from Paseo", which removed its 16 cards. The fixture repository and this test's own `removed/` records were then deleted (see PROGRESS).
