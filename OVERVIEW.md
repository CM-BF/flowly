# Flowly

The agent-native workflow for Paseo, shown as a kanban board. Manage projects and tasks in Paseo. Each board project links one native Paseo project and uses its root directory. Each task has one workspace, and its detail drawer shows the workspace's agent sessions and lets you send follow-up instructions.

Create or link a workspace from a task, inspect session output, change task status, and keep project context on the board. Multiple sessions can work in a task's workspace. Task completion is tracked separately from an agent finishing a turn.

Project management and task filters live in menus above the board. On desktop, drag a card to another status column and resize the detail drawer using its divider or width controls. Card text cannot be selected. On phones and narrow windows, choose a status to browse a full-width vertical task list; task actions also provide explicit status changes.

Create sessions in a focused dialog. Each session appears as a card with its title, model and execution state. Select a session to preview recent output and send follow-up instructions, return to task details, or open its full conversation in Paseo. Follow-ups send the text you enter without repeating the project/task header. A finished turn is separate from task completion. The plugin preview uses the public SDK; Paseo 0.11.2 does not expose its native Agent pane for embedding.

Linked sessions have a **Task** chip in Paseo's native composer track. It opens Flowly at the linked card with that session preview in the sidebar. **Back to task** returns to card details. The chip validates the current workspace link and reveals cards hidden by filters or archival settings.

The preview formats headings, lists and code; tables use vertical fields to fit narrow sidebars. The instruction input and send controls stay at the bottom. New output follows the latest message until you scroll up; choose **Jump to latest** to resume following.

Task cards show running, finished-turn, unread and needs-attention session counts. Unread sessions, errors and pending approvals highlight the card. In a session preview, **Mark as read** acknowledges that update in Flowly; errors and approvals still need action. Reading a native Paseo session also updates the board through its native attention state. Plugin acknowledgements are saved on the daemon and apply only to the current update; they do not clear Paseo's native badge or complete the task.

New tasks work from the Paseo project root. To work across repositories, place them under a common directory and register that directory as the Paseo project. A directory workspace starts there; a worktree requires the project root itself to be a Git repository. Existing workspaces within the root or matching a worktree of that root can be linked while preserving their native project ownership. Cards created before the single-root change retain their saved legacy directory scope and workspace links.

Requires Paseo 0.11.2 or newer. Board data is stored on the daemon machine. Archiving a card or board project preserves its Paseo resources. The daemon needs the Paseo CLI on its path to register a new native project. Desktop shows a task drawer beside the board; compact layouts show task detail on its own.

## Agent Kanban tools

Sessions created from a card receive eleven scoped `flowly_*` MCP tools for reading their card and ticket inputs, updating its work stage and workpad, reporting progress, proposing ideas and next moves, tagging and classifying the card, and managing artifacts. The plugin supplies the current card, workspace, effective repository directories, a skill, and a private session context. An agent can move its card between the Design, Development and Test stages or to In review; a person decides Done and Cancelled. A progress report leaves the card's status and task revision unchanged.

For a session already in the card's workspace, select it in the drawer and choose **Send Kanban work instructions**. That sends the CLI and skill instructions to that session; it does not change the ordinary follow-up draft or install MCP into a running provider session. The drawer shows which access was configured and when a tool call actually succeeded. It also shows tool service errors, including when the local listener cannot start.

Tool requests use the card and project revisions. On an uncertain response, retry the identical request and parameters to recover its durable receipt. The CLI calls the running plugin service and requires the matching `PASEO_AGENT_ID`; it does not edit the board file. The service listens only on loopback and uses private per-session credentials. Restarting or reloading the plugin preserves board history and receipts.

Usage statistics read the local Claude Code and Codex session logs on the machine that runs Paseo, only to add up token counts per card, session and day. That reading and counting happens locally. When automatic summaries are on, every completed turn also starts a short extra child session in the card's workspace. It receives the card title and description, the lane, the previous summary and a bounded excerpt of the turn's transcript, so the model you chose in Settings (Haiku by default, then Codex) can update the card's summary. The daily digest in Insights does the same for a project's day. Both are switches in Settings, and a manual Refresh always works. Board data, receipts and credentials stay in the plugin's data folder, and the tool service listens on 127.0.0.1 only.
