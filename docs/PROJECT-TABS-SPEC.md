# Desktop project tabs and last-viewed project

Status: requested by the user on 2026-10-15 (card “优化project系统”).

## Behavior

- **Desktop (non-compact) header** replaces the project switcher button with a row of project tabs in chooser order (`projectOrder`; archived projects only while *Show archived* is on, with an Archive icon). One click switches project. Active tab: `surface2` background and foreground text; others muted, `surface1` on hover. All tabs use the same font weight so switching never shifts widths. Tabs are capped at 220 pt with ellipsis; overflow scrolls horizontally and the active tab is scrolled into view when it changes from elsewhere (chooser, linked session).
- After the tabs: **+** (New project) and **⇕ All projects** (the existing chooser: reorder, edit, archive; shortcut `P` unchanged).
- Compact/phone layouts and the no-project state keep the existing switcher button.
- **Which project opens:** an explicit choice in this board instance → the project last viewed during this app run → the first project in chooser order. "Last viewed" is client module state, so leaving Ultra Kanban and coming back restores it, while a cold start (new client bundle) opens the first project. Opening the board from a linked workspace/session still selects that card's project, and that becomes the last viewed one.
- The persisted `board-view.lastProjectId` setting is no longer read or written; the field stays in the schema for compatibility with stored values.

## Acceptance

- Unit (`client/project-memory.test.ts`): cold start → first; remembered project restored; explicit choice wins; vanished project falls back to the first.
- Headless web client at 1440×900 against the reloaded plugin: tabs render; switch → leave the board → return keeps the switched project; page reload opens the first project.
