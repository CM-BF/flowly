<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo/flowly-lockup-dark.svg">
    <img src="docs/brand/logo/flowly-lockup-light.svg" alt="Flowly" height="56">
  </picture>
</h1>

**Flowly** — the agent-native workflow for Paseo.

**English** · [简体中文](README.zh-CN.md)

**A Paseo plugin that turns agent sessions into a workflow that runs itself, with a kanban board as its face.** You hand out work, make the calls, and review. Progress, reminders, summaries, follow-up ideas and daily stats are kept up to date by the board.

> Plugin ID `flowly` · requires Paseo `>=0.11.2` · runs on desktop, tablet and phone clients.

![Board: cards move across Design, Development, Test and In review as agents work](docs/promo/screenshots/01-board-auto-status.png)

<details>
<summary>Dark theme</summary>

![Board, dark theme](docs/promo/screenshots/01-board-auto-status-dark.png)

</details>

## Install

```sh
paseo plugin add jasprw/flowly
```

This installs the version reviewed in the [Paseo plugin registry](https://paseo.sh/plugins). The package is also on npm as [`paseo-flowly`](https://www.npmjs.com/package/paseo-flowly) (`paseo plugin add npm:paseo-flowly`). To install the latest `main` straight from Git instead, use `paseo plugin add git:JasprW/flowly`.

Open **Flowly** from Paseo's sidebar. The daemon needs the `paseo` CLI on its path to register a new native project.

## Highlights

### 1. Automatic status flow

Start a session from a card and the card follows the work: **Design → Development → Test → In review**. The agent sets its stage through scoped Kanban tools; the daemon also moves cards when a session starts or resumes a turn. A finished turn never marks a card Done. Done and Cancelled stay your decision. Cards show running, finished, unread and needs-attention session counts, and the latest agent output. Cards that finished more than 14 days ago (configurable in *Settings → Workflow*) fold under **Show older** at the bottom of Done and Cancelled, so the board stays about current work.

Turn it off globally (*Settings → Moving cards*) or per project.

### 2. Needs-you reminders

When an agent needs a decision it asks one clear question and stops. The card lights up **Needs you**, the **Attention** dropdown and the sidebar badge count it, and **Reply** jumps straight to that session. Approvals and errors are surfaced the same way. Not ready to decide? **Dismiss** a card from Attention: the count drops, the card keeps its signals, and it comes back as soon as something new happens. Questions an agent asks with its ask-user tool, and approvals, can be answered right on the card's detail page or in the Flowly session.

When a turn ends, the agent can leave its **suggested next steps** ("Verify with Luna", "Commit and push") above the session's message box. Tapping one only fills the box; you edit it or send it yourself. Once the work is committed and pushed, an agent can also offer **Move to Done**: that one doesn't fill the box, tapping it moves the card (Done stays your decision). They disappear once your next message starts a new turn.

**Comments** go right on the card, as on a Multica issue: ask how far it got, give an opinion or request changes in the card's **Comments**, without first finding the right session. A comment stays on the card (it shows in Activity, and agents see the latest ones in `flowly_get_task`) and its exact text goes to the card's agent through the same path as the session's message box, with the same *When a session is running* choice (Settings → General → Sending messages): by default the automation implementer, otherwise the most recently active session that is not a reviewer; **To:** picks another one. A card without a session keeps the comment until an agent starts; a failed send keeps it too and offers **Resend**. Comments never move the card, and Done stays yours.

The same features follow a Flowly session into **Paseo's own session view**: each progress summary appears as a **Progress** row in the conversation, the suggested next steps appear as a card under the agent's last reply: tapping one fills in Paseo's message box on web and desktop (or copies it; you choose in Settings → AI features), and nothing is sent until you send it. An **Ideas** chip next to Paseo's message box lets you continue an idea in this session, start a new task from it, or dismiss it. Optionally (off by default; Settings → AI features), sessions Flowly does not manage get the same progress row, next steps and ideas, kept with the session rather than in a project; their ideas can continue there or start in a new session or workspace.

![Suggested next steps above the message box: Verify with Luna, Commit and push, Add 429 tests](docs/promo/screenshots/06-next-moves.png)

![An agent's question on a card, with a Reply button](docs/promo/screenshots/02-needs-you-drawer.png)

### 3. Run summaries

After every completed turn a cheap model (Haiku 5.5 by default, configurable) updates the card's **state / target / recap / next**. Past versions are kept, so you can still see how far a card got after it is Done. Summaries never change the card's status.

![Card summary: state, target, recap and next step](docs/promo/screenshots/03-card-summary.png)

Agents also keep a **Workpad** on the card: acceptance criteria, the checks they run (passed, failed or not run, each on a named commit, with the exact command) and what in the card confused them. Their plan comes from their own todo list. The card shows **Checks 3/5**; a check that ran on an older commit than the workspace's HEAD reads *out of date*. You can tick criteria and set a check's state yourself. Before they start, agents set the card's type and tags and write the workpad; until they do, every Flowly tool result reminds them. An agent delivering to In review with open items, or without a type, tags or workpad, has to acknowledge that with a note, and with open items the card then says **Delivered with N open items**. Turn it off per project with *Card workpad* in the project settings.

### 4. Follow-up ideas

Work an agent discovers along the way (a bug it tripped over, a limitation, the next step) lands in the project's **Ideas** inbox instead of being lost in a chat. **Good idea** gives you two paths: continue in the same session, or start a new card or new session with the context pre-filled. **Dismiss** removes it. Ideas are suggestions for you; work that must be done goes to cards and sub-cards (below).

![Ideas inbox with source cards](docs/promo/screenshots/04-ideas-inbox.png)
![Good idea: start a new task, continue in the session, or use a new session](docs/promo/screenshots/04b-good-idea-two-paths.png)

What should outlive a card goes to **project memory**: decisions you made (including the options you turned down), pitfalls and dead ends, how you want work done, and the people and systems involved. Agents suggest entries with `flowly_remember`, and a cheap model reviews each card you move to Done and suggests at most one more, only when it holds beyond that card; nothing counts until you confirm it on the project's **Memory** page (`M`). Confirmed entries go into the first instructions of the project's new sessions (all of them while they fit, otherwise the pinned and most relevant ones; agents look up the rest with `flowly_recall`). You can edit, pin, archive or delete any entry, copy one as an `AGENTS.md` rule, and turn memory off per project. It is stored on your machine, never in the repository.

### 5. Inputs and outputs

Each card has an **Artifacts** list: the documents, links and deliverables it worked from (inputs) and produced (outputs). Agents register them through the board tools as they work; you add, edit or remove your own from the card. Only references are stored; files stay where they are and open in a read-only preview. Every entry shows whether you or an agent added it, and agents can't remove the ones you added.

**Tickets, docs and pull requests** can be inputs too: Jira tickets, Confluence pages, and GitHub or GitLab issues, pull requests and merge requests. Connect a service in Settings → Connections (self-hosted or cloud, with a personal access or API token), then start a card with **From Jira / From GitLab / …** or add an item from the one **+** in a card's Artifacts. The picker lists your recent items (assigned to you, awaiting your review, or pages you edited) and searches by key, link, number or title words; GitHub and GitLab search the project's own repositories first, found from its git remotes. Agents read the item with `flowly_read_external` (description or page content, comments, and for pull/merge requests the branches, head commit and changed file names) and see when it changes. Flowly only reads: it never comments, approves, merges or changes anything, and an item's status never moves a card. Tokens stay on the daemon machine.

Once an agent understands the work it fills in the card's metadata itself. It sets the **task type** (feature, bugfix, research, refactor, docs, chore) when the card has none, never overriding one you chose. It also adds **tags** for the modules and directions the card touches (`drawer`, `performance`, `a11y`), separate from the fixed task type. Agents reuse the project's existing tags rather than inventing synonyms; you add or remove tags in the card or the form. Filter the board by tag, or search `#tag` (`#module/` matches a prefix). Agents can't remove tags you added.

### Describe once, start working

New task has one task input and starts an agent by default. The agent organizes the card's title, description, type and tags while preserving the original task. Expand **More options** to choose a workspace, adjust metadata or park this card. **Edit project** includes model, reasoning, permissions and provider-supported speed controls for the project default, implementer and reviewer. With Agent automation enabled, **Create and start** queues the card for supervised execution, including sub-card wait/wake.

### 6. Agent automation (optional)

Turn on **Agent automation** for a project (*Edit project*) and choose **Run with agent** on a card. Flowly queues it, starts an agent in the card's own workspace once the cards that block it are Done and one of the project's slots is free (highest priority first), and supervises it the way Hermes Kanban supervises its workers: a turn that ends without a delivery, a question or a blocker gets a reminder, a failed turn is retried with backoff, and when the limits run out the card moves to Blocked with the reason. Set a **reviewer** model and every delivery is first reviewed by a second agent in the same workspace: it approves (the card stays In review for you) or sends concrete changes back to the implementer, for up to the number of rounds you choose. Give the implementer and the reviewer a **fallback model** each: when a model reports a rate or usage limit, a new session on the fallback takes over (the implementer from the workpad and workspace, the reviewer by rerunning the round) instead of the card waiting for the limit to reset. The card shows what the agent is doing (*Agent working*, *Agent reviewing*, *Agent waiting for you*, *Agent review passed*); questions still reach you as Needs you. Done stays your decision. Automation never archives sessions and never deliberately interrupts them: it steers a busy session rather than interrupting it, but Paseo 0.12 has no idle-only send, so a message that races a turn you just started can still interrupt it when steering is unavailable (see the limit in [AUTOMATION-SPEC](docs/AUTOMATION-SPEC.md) §10).

**Review levels** match the review to the card. A card is reviewed **Light** (one reviewer, at most two rounds by default), **Standard** (the serial rounds above, with a panel once rounds keep requesting changes) or **Deep**: a panel of reviewers from the first round, each with a fixed angle (contract and correctness; design and scale; failure, data safety and security; then execution and integration), and the design-and-scale reviewer answers the same questions every round: what the stored data looks like after 10,000 operations or six months, what one operation costs as history grows, how old data is cleaned up, how the format is upgraded, what happens if the process dies mid-operation, and which permission boundary it touches. Set the level in *Edit task*, or leave it on **Auto**, which follows explicit levels and review tags (`deep-review` or `foundation`, also on ancestors; `light-review` on the card), then asks the Summary models what this card itself changes. The result is cached until the card changes; keywords are only a fallback when classification is unavailable. The editor shows the result, model and reason, and you can always override it. Agents creating sub-cards give foundation work `review_level=deep`. At every level the reviewer also lists **risks beyond the acceptance criteria** (growth, cost per operation, cleanup, upgrades, failure recovery, security): they never block an approval, but the card shows how many (*Agent review passed · 2 risks*), the card's Agent automation block lists them, and a parent card's agent reads them before it accepts the sub-card. Each level's model, panel size and rounds are in *Edit project → Agent automation → Review levels*.

**Card handoff** keeps the work on the card when its agent changes. Open **Handoff** in the card sidebar for the current state, ordered next steps, decisions and reasons, abandoned approaches, open problems, pitfalls, still-running work and how to check it, original instructions and their status, linked answers, each review round’s delivery and findings, repository checks, current/previous sessions and acknowledgement. It is separate from a progress summary or an artifact list. You can add a note or mark an instruction done, superseded or standing without rewriting its original text. Long originals and older records are read page by page; shortened previews and missing information are labelled. A new agent verifies the record against the actual workspace and acknowledges what it received. Uncaptured conversation details and unspoken reasoning cannot be promised back; capture gaps remain visible.

The existing **200 MiB history guard**, **provider fallback**, **Run again** and **Continue in a fresh session** share a recoverable handoff path. Run again starts a fresh implementer and reviewer; a safe, idle previous session can first update its handoff. Unknown creation results keep the same prepared identity, instead of creating another agent. No running turn is interrupted. **Continue in this session** explicitly opens the session you chose after safety checks and ends automation supervision; a rejection never silently selects another session. Earlier automatic context/idle/64 MiB boundaries are not enabled in this first stage.

**Cards and sub-cards**, like sub-issues in Multica: an agent splits a card that is too big for one session into sub-cards (`flowly_create_card`), each with its own workspace, ordered with *blocked by* and started now or parked, and creates separate cards for other work that must be done. The parent card shows **Sub-cards 2/3**; under automation it waits without taking a slot and is woken with every sub-card's lane, state and branch once none of them is still moving, then accepts the delivered ones (`flowly_update_card`), starts the next or delivers. You add sub-cards yourself with **New sub-card** in any card's menu. **Card tree** (the **Tree** chip, `T`) shows each item from the whole to its parts: sub-cards nested under their parent, siblings numbered by their *blocked by* order (the same number runs in parallel), what each card waits for, and every item's *Now · Next · Needs you* line; tap a step number to highlight a card's whole chain. On the board, **Levels** (`1` `2` `3` `0`) hides sub-cards below level 1, 2 or 3 per project, while their questions, errors, running and unread sessions roll up onto the nearest card still shown. A card's sidebar has a **Dependencies** map of what it waits for and what it blocks, and a queued card whose blocker was cancelled says **Held by …** until you remove the link. In a project that is not a git repository, cards share the project folder: automation never runs one of its agents where another card's automated agent is working, but it does not see your own sessions, so coordinate those yourself (or use a git project, where each card gets its own worktree).

### 7. Project insights

One page for the day: cards done, new and reworked, turns, agent time, commits and tokens (with cache hit rate), the list of what is **waiting on you**, rule-based suggestions, an AI-written daily summary, per-card token use and a 7-day trend.

![Project insights: tiles, waiting on you, suggestions, summary and token use](docs/promo/screenshots/05-insights.png)

<details>
<summary>Dark theme</summary>

![Project insights, dark theme](docs/promo/screenshots/05-insights-dark.png)

</details>

**Agent habits** (always on, no tokens): a small block on the Insights page shows, for the last seven days, how often agents' deliveries come with suggested next steps and ideas, by day and by model, how many suggestions you took, and flags a model or session that made none over ten or more deliveries, so a rule that stops being followed shows up within a day.

**Workflow insights** (optional, off by default): Flowly keeps a redacted log of the shell commands agents run on your cards, and on the schedule you pick (daily when tokens are plentiful, up to every two weeks when they are not) a model you choose reads the last week of it. It suggests what is worth keeping: `paseo.json` scripts and worktree setup, small repo tools for work agents keep redoing with inline code, AGENTS.md rules and skills. Each run replaces the previous run's suggestions, so the list always shows the latest analysis; each suggestion becomes a card with one click; quiet weeks are skipped without calling the model. Agents see the project's `paseo.json` scripts in their task context and run them instead of retyping commands.

## Languages

The interface follows your device language, or pick one in **Flowly settings → Language**: English, 简体中文, 繁體中文, 日本語, 한국어, Español, Français, Deutsch, Português (Brasil) and Русский. Agent instructions, daemon error details and the text agents and summaries write are not translated. AI-written text (summaries, the daily digest, Workflow insights, suggested next steps and ideas) has its own language, **Flowly settings → AI features → AI output language**; it follows the interface language until you pick one.

| 日本語 | Deutsch |
| --- | --- |
| ![Board in Japanese](docs/promo/screenshots/i18n/ja-JP-board.png) | ![Board in German](docs/promo/screenshots/i18n/de-DE-board.png) |

## Quick start

The first time you open Flowly, a short welcome tour explains projects, cards and sessions and sets the basics: interface and AI output language, the progress model, whether progress, next steps and ideas also apply to sessions outside Flowly (on by default; each of their turns then runs the summary model once), and whether Project memory and Insights are on. Skip keeps the defaults. Change any of it later from the gear at the bottom left.

1. **New project**: pick a directory (or several repositories) to register as a native Paseo project.
2. **New task**: describe the work; optionally start an agent together with the card.
3. Watch the card move. Answer **Needs you** cards, review **In review** cards, accept or dismiss **Ideas**, and open **Insights** at the end of the day.

## How it works

- **One board project = one native Paseo project root.** To work across repositories, put them under one directory and register it, or let the plugin create a linked root with one symlink per repository (removing a link never touches the target).
- **One card = one workspace**, with any number of sessions in it. You choose which session receives an instruction; ordinary follow-ups send exactly what you type.
- **Agent tools.** Sessions created from a card get scoped MCP tools: `flowly_get_task`, `flowly_update_status`, `flowly_report_progress`, `flowly_propose_idea`, `flowly_suggest_next_moves`, `flowly_set_tags`, `flowly_set_type`, `flowly_add_artifact`, `flowly_remove_artifact`, `flowly_update_workpad`, `flowly_read_external` (`flowly_read_ticket` remains as an alias for older sessions) `flowly_create_card` and `flowly_update_card` (cards and sub-cards) and, for reviewer sessions of agent automation, `flowly_submit_review`, plus the `flowly` skill that explains them. An agent can move its card between the work stages and In review; a person decides Done and Cancelled. The call that delivers or asks (`flowly_update_status`, `flowly_report_progress`) can also carry `nextMoves`, the suggested next steps shown above the message box, or `[]` when nothing needs the user. A CLI fallback is provided for sessions without MCP.
- **Card status and session status are independent.** A turn ending never completes a card.
- **Also included:** drag and drop (including within a column), card links (follow-up, blocks, related), task types and priorities, wrap-up of Done cards (archive their sessions and own workspace, after a preflight), keyboard shortcuts (`?`), per-card token usage, a compact phone layout, and *Settings → Cards* to choose what board cards show (with a live preview).

### Models

Pick the model new sessions start with under **Settings → Models**. A project can set its own default in its settings, which wins over the global one; with neither, new sessions start from the latest session's settings.

Summary models are an ordered fallback list in Settings → Models: add models and move them up or down to set priority; the default is Haiku → Luna.

![Settings → Models: default model and summary model](docs/promo/screenshots/settings/models.png)

### Data and safety

Board data is stored on the daemon machine in `~/.paseo/plugin-data/flowly/` (`PASEO_HOME` selects the daemon home). Writes are serialized and atomic, stale edits are rejected, and invalid files are preserved rather than reset. Removing or permanently deleting a project or card writes a backup to `removed/` first. Archiving plugin records never deletes Paseo resources or directories. The tool service listens on loopback with private per-session credentials.

## Development

To run from a checkout (for development):

```sh
git clone https://github.com/JasprW/flowly.git && cd flowly
npm install
paseo plugin install "$PWD" --id flowly
paseo plugin reload flowly   # after later changes
paseo plugin logs flowly
```

```sh
npm run typecheck
npm test
```

GitHub Actions checks every PR and main push (Node 22/24, types, tests and a real package install). `make release VERSION=x.y.z` checks an already merged version and pushes an annotated tag; the tag workflow publishes the tested tarball to npm using OIDC and creates a GitHub Release. `DRY_RUN=1` previews local release steps. See [CI/CD setup and recovery](docs/CI-CD.md).

To add or change text, wrap it in `t()` / `tn()` and add the translation to every file in [`shared/i18n/`](shared/i18n/); `npm test` lists what is missing. See [`docs/I18N-SPEC.md`](docs/I18N-SPEC.md).

Root code is limited to `index.client.tsx` and `index.server.ts`; everything else lives in `client/`, `server/` and runtime-neutral `shared/`. Design decisions, specs and acceptance evidence are in [`docs/`](docs/): start with [`SPEC-OUTLINE.md`](docs/SPEC-OUTLINE.md), [`SINGLE-ROOT-SPEC.md`](docs/SINGLE-ROOT-SPEC.md) and [`PROGRESS.md`](docs/PROGRESS.md). Project rules for contributors and agents are in [`AGENTS.md`](AGENTS.md). Release and promo material (copy, demo project script, screenshot script) lives in [`docs/promo/`](docs/promo/README.md).

## License

[MIT](LICENSE) © 2026 Bofan Wang

The separately installed `paseo-kanban` plugin is a different plugin and is never overwritten.
