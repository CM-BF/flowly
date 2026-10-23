# 智能体自动化：把 Hermes Kanban 的 agent 自动化搬进 Flowly（AUTOMATION-SPEC）

状态：2026-10-22 用户要求实现（“把 hermes 的 kanban 的 agent 自动化集成到 paseo 的 flowly 插件上”），已实现，待用户验收。方向来自用户此前在 “设计 Flowly × Kanban 整合” 卡上的决定：**在 CM-BF/flowly fork 内置**，不另做适配插件，不建第二套看板。来源：Hermes `hermes-agent` 的 `cron/AGENTS.md` Kanban 一节、`website/docs/user-guide/features/kanban.md`、`agent/prompt_builder.py` 的 `KANBAN_GUIDANCE`、`skills/devops/sdlc-review`；Flowly 的 [ROADMAP-V2](ROADMAP-V2.md) M4–M6 与 [SYMPHONY-RESEARCH](SYMPHONY-RESEARCH.md) §3 “远期”。两轮评审后的修订已并入各节（[verification/automation-review.md](verification/automation-review.md)）。

## 1. 范围与约束变更

Hermes Kanban 的 agent 自动化有四块：**dispatcher**（依赖、并发、优先级、认领、启动 worker）、**worker 协议**（交付 / 阻塞 / 提问，静默退出算违规，有界提醒与重试，熔断后自动 block）、**review 回路**（交付后由 reviewer profile 审，`request_changes` 打回实现者）、**编排**（triage 自动拆卡、orchestrator 建子卡、goal 模式、定时开始）。本 spec 实现前三块；第四块见 §9。

| AGENTS.md 原约束 | 变更 |
| --- | --- |
| “Automatic assignment, multi-agent handoffs, role orchestration … are outside v1” | 例外（用户要求，2026-10-22）：**按项目开启、默认关闭**的智能体自动化可以自动启动已排队卡片的 session、在实现者与评审者之间交接、对静默/失败的回合发送提醒与重试。跨 host 调度、PR 自动化仍不做。agent 建卡与子卡片由 [SUB-CARDS-SPEC](SUB-CARDS-SPEC.md) 补上（用户决定，2026-10-22）。 |
| “ordinary follow-up sends exactly the user's text” | 不变。自动化发出的消息（开工、提醒、重试、评审、修改要求）是插件发起的显式 Kanban 消息，统一以 `[Flowly automation]` 开头，不冒充用户。 |
| “A turn ending never automatically completes the card” / Done 由人决定 | 不变。自动化从不把卡片移到 Done/Cancelled。评审通过时卡片留在 In review。 |
| 自动化可以改卡片状态吗 | 只有两处，均为系统事件并带 rule：放弃时把卡片移到 Blocked（`rule="AUTO"`，同 Hermes 熔断 auto-block）；评审要求修改时从 In review 回到工作阶段（`rule="REVIEW"`，与人的评审反馈触发 A1 落到同一阶段）。 |

与此前设计稿的取舍（`flowly-hermes-design.md`，已读回）：保留“单一卡片身份、状态与卡片同一事务、显式排队、依赖必须 Done、不自动 Done、无 PR 自动化”；协议版本/能力探测/多仓库 fingerprint 不做——Flowly 的 store 已是唯一写者，session 创建用已有的 prepared-identity + idempotencyKey 保证不重复，足以覆盖重启恢复（§4.4）。outbox 只做每个 job 一条待发指令（§10）。

## 2. 项目设置

`project.automation?: AutomationSettings`（缺省 = 关闭），`projects.update` 整体替换；编辑项目 → **Agent automation**。

| 字段 | 默认 | 含义（Hermes 对应） |
| --- | --- | --- |
| `enabled` | — | 总开关。关闭后不派发、不监督；已有 job 保持原状，再打开继续。关闭期间这些 job 也不出现在 Needs attention 与侧栏角标里（§6）。 |
| `maxRunning` | 2 | 同时占用名额的卡片数（`max_in_progress`）。`starting/working/reviewing/retry_wait` 占名额；等人回复的、`waiting` 的父卡不占。 |
| `implementer` | 无 | 实现者模型；无则用项目默认模型 → 全局默认模型 → 第一个可用 provider 的默认模型。 |
| `reviewer` | 无 | 评审者模型；无则不做 agent 评审（`review_dispatch=false`）。 |
| `implementerFallback`、`reviewerFallback` | 无 | 角色的备用模型：该角色的模型报告频率或用量上限时，换到它继续（§4.5，用户决定 2026-10-23）。无则按 provider 冷却等待上限重置。 |
| `maxReviewRounds` | 3 | 一个**评审周期**内最多几轮评审（周期的定义见 §5）。 |
| `fullAccess` | true | 开着时，所有自动化 session（执行者和评审者）都用 provider 的免审批模式（claude `bypassPermissions`、codex `full-access`），**覆盖**角色自己设的 Permissions 和同 provider 项目默认模型的 Permissions（用户决定，2026-10-23）；没有已知免审批模式的 provider 保留选定的权限。关着时按 [TASK-INTAKE-SPEC](TASK-INTAKE-SPEC.md)：角色的 Permissions → 同 provider 项目默认模型的 Permissions（包括显式的 “Provider default”）→ provider 默认。自动化开启时 New task 表单默认显示同样的结果；有人在表单里为某张卡改了权限，那张卡按其选择启动。速度等其它执行设置仍按角色 → 项目默认继承。 |
| `nudgeLimit` | 2 | 静默结束后的提醒次数（stop nudge）。界面不暴露。 |
| `failureLimit` | 2 | 连续失败回合上限（`failure_limit`）。界面不暴露。 |

自动化需要 In review 泳道：保存设置与 Run with agent 都拒绝 “自动化开启但 In review 关闭” 的组合。此前保存下来的这种旧配置被**冻结**：排队的卡不启动，到期的重试不恢复，等待的父卡不唤醒，也不发任何消息；job 保留、不关闭，重新打开 In review 后继续。这样的项目里 agent 用 `flowly_create_card start=now` 建卡会被拒绝（`STATUS_UNAVAILABLE`，SUB-CARDS-SPEC §3）。

保存项目设置后 dispatcher 立即跑一次，但 RPC 不等它：设置保存好就返回，由此引起的 job 变化在下一次看板读取时出现。

## 3. 数据

`board.json` 新增 `automation: AutomationJob[]`（缺省读作空数组，看板版本仍为 5），随 etag/patch 看板读取到达客户端（`automation` 按 `taskId` 匹配）。删卡、移除项目时一并删除。job 不改 task revision，agent 手里的签名请求不受影响。

```
AutomationJob {
  taskId, projectId,
  state: queued | starting | working | needs_human | waiting | retry_wait | reviewing | delivered | stopped | failed,
  role: implementer | reviewer,          // 当前被监督的是谁
  implementerId?, reviewerId?,            // 两个 session（都在卡片自己的 workspace，都是 Flowly 管理的 session）
  generation,                             // 每次排队 +1
  nudges, failures, reviewRounds,
  verdict?: approved | changes | incomplete,
  code?: question | blocked | permission | interrupted | stopped | card_moved | card_finished
       | no_delivery | failed | start_failed | session_unavailable | workspace_unavailable | taken_over | ancestor_finished
       | review_rounds | review_incomplete | sub_cards | cooldown,
  detail?,                                // daemon 文本（错误、评审摘要），不翻译
  retryAt?, turnAt?, pendingOp?, pendingRole?, launchKey?, launchConsumed?,
  instruction?: { id, role, text, fresh, reviewDelivery?, dispatched? }, // 唯一的待发指令（§10）
  deliveryEvent?,                         // 最近一轮评审看的那次交付
  reviewedEvent?,                         // 最近一次结论针对的那次交付
  latestDelivery?,                        // 最近一次交付身份，历史裁剪后仍保留
  unconfirmed?, unconfirmedStart?,        // 未确认的create/send：绑定role、session、原因及交付
  reviewPause?, takenBack?,               // 暂停评审的等待/重试状态；人已接回失败的卡片
  reopened?,                              // 交付后有反馈，新交付开始新的评审周期
  feedback?,                              // 父卡给子卡的修改要求（SUB-CARDS-SPEC §4）
  restarts?,                              // 父卡 agent 重新启动本卡的次数（SUB-CARDS-SPEC §4）
  provider?, cooldowns?,                  // 当前 session 的 provider、provider 限额重试次数
  fallback?: { implementer?, reviewer? }, // 本次运行中已换到备用模型的角色（§4.5）
  providerLimit?: { provider, model?, until }, // 让角色换模型的那次上限；到期前新 session 直接用备用模型
  subSeen?,                               // 父卡上次看到的子卡签名（SUB-CARDS-SPEC §5）
  queuedAt, startedAt?, updatedAt
}
```

- `turnAt`：早于或等于它的回合结束不归本 job 处理（已处理，或早于最后一条指令）。`pendingOp`：正在创建的 session 的 preparation，重启后用同一个 op 再建同一个 id，绝不建第二个；`pendingRole` 标明它属于哪个角色。
- “交付”指实现者**自己**把卡片设为 In review 的那条状态事件。`deliveryEvent` 是最近一轮评审所看的交付，总是实现者自己的事件（A1r 把卡恢复到 In review 不算交付）。`reviewedEvent` 是最近一次结论（approved、changes 或 incomplete）所针对的交付：回合结束时卡片仍停在这次交付上，就是没有新交付（随口回答）；其它交付都是新工作。`reviewedEvent` 出现之前保存的 job，有结论时以 `deliveryEvent` 代替。`latestDelivery` 将最近一次交付身份存在 job 上，不依赖只保留最近 100 条的活动历史；没有 agent 交付事件时用该回合身份。历史裁剪或没有新交付的闲聊都不使已给出的结论失效。交付身份与失败卡片被人接回的 `takenBack` 都在相应事件的事务中、裁剪历史之前保存，不等下一次派发。
- `restarts` 只由 agent 的排队带进下一代 job；人的 Run again 从 0 开始。

## 4. 生命周期

### 4.1 排队与派发（dispatcher）

- **Run with agent**（`automation.queue`）：卡片未归档、不在 Done/Cancelled、项目已开启且 In review 开启、没有活着的 job。新 job 为 `queued`，`generation+1`，沿用上一次的 implementer 与 reviewer session。活动记一条 `automation_queued`。
- dispatcher 每 15 秒一次；排队、停止、移动卡片、**每个被监督 session 的回合结束**（即使这次回合结束不归 job 判断）时也立即跑一次；保存项目设置、归档或取消归档卡片、删除卡片时在后台跑一次，RPC 不等它。并发调用合并为下一次。冻结的项目（§2）整个跳过。每个开启的项目：到期的 `retry_wait` 先恢复；再按优先级（urgent > high > normal > low）、排队时间把满足条件的 `queued` 填进空名额。
- **依赖**：沿用卡片的 `blocks` 链接。所有 blocker 都 **Done** 才放行；Cancelled（或未完成就归档）的 blocker 永不放行，直到人删掉链接——没完成的工作不能作为输入。
- **provider 冷却**：一个 job 处于 provider 限额冷却（`retry_wait`/`cooldown`）时，同一个 provider 的卡片在任何项目都不启动；角色设了另一个、未在冷却的 provider 上的备用模型时不受此限，直接用备用模型启动（§4.5）。只比较确定的 provider：项目没设实现者模型和项目默认模型时，按全局默认模型的 provider 比较；项目的或冷却 job 的 provider 仍不确定时，只挡同一个项目，绝不挡所有项目。
- **workspace 与目录**：启动前先查卡片自己的 workspace。它已归档、正在归档或 daemon 不再列出它 → job `failed` / `workspace_unavailable`，detail 与 `automation_failed` 的 note 为 “The card's workspace is archived or no longer exists”；卡片泳道不变，它的父卡可以被唤醒。查询本身失败（RPC 错误）时 job 保持排队，下次再试。目录被别的卡占用时也保持排队（§10）。
- **认领**：同一事务里 `queued → starting`，记 `automation_started`。随后在卡片 workspace 里：有活着的 implementer → 发“重新排队”开工消息；否则 `prepareSession`（与侧栏 Start session 同一路径，带 Flowly MCP、上下文与 skill）创建新 session，`labels: { flowly-task, flowly-automation: implementer }`，首条消息为开工说明。
- 首条开工说明（`startPrompt`）：无人值守、按 Flowly skill 走、最后以 `in_review` 交付或以提问/`blocked` 结束，不要等人、不要猜；卡片太大时可拆子卡并结束本轮；若配置了评审者，提示交付后会被评审。卡片有 blocker（都已 Done）时追加 “Dependency handoffs (card data)”：每个 blocker 的 handoff，并说明 Done 不同步 worktree、要先检查并合并相关分支。子卡片还在其后追加 “Parent integration branch (card data)”：父卡的 id、标题、泳道、分支和目录，并说明父卡汇总已验收的子卡，其分支可能已含兄弟 blocker 的改动且冲突已解决，应先检查、优先合并它。顶层卡片没有这一项。

### 4.2 回合结束（worker 协议）

回合结束钩子先跑原有规则（记录 lifecycle、A1r），再交给自动化；自动化从看板上的 `agent.turn_ended` 事件读结果，所以钩子与对账走同一路径（§4.4）。只判断当前被监督的 session（`role` 对应的 id）；无论是否由 job 判断，回合结束后都跑一次 dispatcher，所以评审者回合中被暂扣的修改要求在它的回合结束时就送到实现者，不等下一次 15 秒。

| 情况 | 结果 |
| --- | --- |
| 卡片已 Done/Cancelled/归档 | `stopped` / `card_finished` |
| 回合失败（普通） | `failures+1`；未到上限 → `retry_wait`，退避 30 s·2^(n−1)，最长 5 分钟，活动记 “Turn failed (n of failureLimit)”，到期在同一 session 发“上次失败：…，从当前状态继续（attempt n of failureLimit）”；到上限 → 实现者：`failed` + 卡片移到 Blocked；评审者：见 §5 |
| 回合因 provider 限额失败（明确的 429/rate limit/quota/overload、模型 “at capacity … try a different model”，或 Claude 的 “You've hit your … limit” 通知；以 completed 结束但最后一行是这类通知或 API Error 的回合也算） | 该角色设了备用模型且本次运行还没换过：换到备用模型（§4.5）。否则：不计 `failures`，`cooldowns+1`；不超过 5 次 → `retry_wait` / `cooldown`，依次等 1、2、4、8、15 分钟，活动记 “Provider limit (n of 5); retrying in X min: <error>”，到期发 “The last turn stopped at a provider limit: … (provider limit retry n of 5)”；超过 → `needs_human` / `cooldown`，不把卡片移到 Blocked |
| 回合被中断 | `needs_human` / `interrupted` |
| 实现者有**新交付**（卡片在 In review，交付不是 `reviewedEvent`） | 有评审者且本周期轮次未满 → 开始评审（§5）。没有评审者（例如两次交付之间删掉了评审者）→ `delivered`，并丢掉之前的结论，未经评审的工作不会显示 “Agent review passed”。周期未被重开而轮次用完 → `delivered` / `review_rounds`，保留最后一轮的 `changes` 结论（“Review needs you”） |
| 回合结束时卡片仍停在得到结论的那次交付上（随口回答） | 保留该结论，`delivered` |
| 评审进行中、尚无结论时实现者随口答了一轮（卡片停在同一交付上） | 恢复同一交付的同一评审轮次，不加轮次、不重发已送达的指令；尚在准备或发送的 reviewer 指令与 preparation 身份保留，闲聊结束后接着发送。评审者对这次交付的结论在闲聊期间也有效 |
| 实现者本回合自己把卡片设为 Blocked（包括卡片已在 Blocked 时再设 `blocked`，记为 Blocked→Blocked 的进度报告） | `needs_human` / `blocked`（“The agent reported a blocker”）。卡片因别的原因停在 Blocked，例如重新运行时 A1r 在静默回合后把它恢复为 Blocked，按静默结束处理 |
| 本回合提了问题或报了 blocker（`kind=question/blocker`） | `needs_human` / `question` |
| 有子卡片仍在推进 | `waiting` / `sub_cards`（SUB-CARDS-SPEC §5） |
| 其它（静默结束） | 提醒未满 → `nudges+1`，发提醒；满了 → 实现者：`failed` / `no_delivery`，卡片移到 Blocked；评审者：见 §5 |

成功的回合把连续失败计数清零；provider 冷却计数不清零。

被监督 session 开始下一回合时：
- `needs_human`（人回复了）→ 回到 `working`/`reviewing`，提醒计数清零。权限请求：`agent.permission_requested` → `needs_human` / `permission`，`permission_resolved` → 恢复。
- `retry_wait`（失败退避或 provider 冷却期间，人在该 session 里发了消息）→ 回到 `working`（评审者为 `reviewing`），清掉重试时间和失败文本，失败与冷却计数保留。这一回合的结束按上表正常判断（提问、交付、提醒），过时的 “The last turn failed” 重试不再发送。
- `delivered` 后实现者因人的反馈开始新回合 → 回到 `working`，并开始新的评审周期（§5，Hermes reopen-review），下次新交付再评审。

放弃时移到 Blocked 的条件：Blocked 泳道开启，卡片在 Backlog/Todo 或工作阶段；In review 的卡不动。

### 4.3 人的操作

- **Stop automation**（`automation.stop`）：job → `stopped`；不打断、不归档任何 session（要打断用 Paseo 自己的停止）。
- 人把卡片移到 Done/Cancelled → `stopped`/`card_finished`；移到 Backlog，或在 agent 已开工后移到 Todo/Blocked → `stopped`/`card_moved`。只有这几种移动结束 job，`delivered` 的 job 也一样。工作阶段之间的移动不影响活着的 job；已交付的卡片在工作阶段之间移动（例如从 In review 拖回 Development）后 job 仍是 `delivered`，给实现者发反馈即重开，它的下一次交付会被评审。
- 卡片的另一个 Flowly 管理的 session 开始回合、接管卡片 → job `stopped` / `taken_over`，并记一条 `automation_stopped` 活动，daemon note 为 “Another session took over the card”。job 自己的评审者在本轮之外开始回合（人问它结论、返工期间、Run again 保留它之后）不算接管，job 不变（§5）。
- 归档、取消归档卡片：归档停止该卡（及其后代）的 job，不改后代泳道；dispatcher 在后台跑一次，RPC 保存好就返回，由此引起的 job 变化在下一次看板读取时出现。
- 删卡、移除项目：job 一并删除；session 照旧（删卡本身的归档选项不变）。

### 4.4 重启与漏掉的钩子（对账）

每次派发前对每个活着的 job：
- 只有 `starting`、`working`、`reviewing` 的 job 参与重启恢复。`starting` 或有 `pendingOp` 且超过 2 分钟没进展：用同一个 op 重新 `prepareSession`（得到同一 agentId），已存在就只补状态，不存在才创建（idempotencyKey 同侧栏）。
- `unconfirmedStart` 把未知结果绑定到原 role 和 session，区分 create 与 send，并保存原 code/detail 和评审交付。实现者的闲聊或新交付不能确认 reviewer 的请求。创建的 session 迟到并开始回合后恢复；未知 send 不能仅凭 session 已存在或 refresh 成功确认，只等那个 session 的真实新回合，不自动重发。
- session 的创建或发送得到未知结果（`agent_request_outcome_unknown`），或在启动 session 时用完了 provider 限额预算：job 等人（`needs_human` / `interrupted` 或 `needs_human` / `cooldown`），不保留指令，也不保留 session preparation。在人回复该 session（在记录的 session 上恢复监督）或选择 Run again 之前，不重发、不重新准备、不重新创建任何东西。
- 被监督的 session 已归档或不存在：实现者 → `failed`/`session_unavailable`；评审者 → 交付保留给人（`incomplete`）。refresh RPC 失败是未知状态，不当作 session 消失。启动结果未知或冷却预算用尽而尚未确认存在的 session（`unconfirmed`）一直保留等人状态；后续刷新仍为空不转成失败。session 迟到并开始回合后恢复监督。
- 卡片自己的 workspace 已归档或不存在：job `failed` / `workspace_unavailable`，记录 `automation_failed`，不要求它曾启动过 session。祖先卡片取消、归档或缺失：后代 job `stopped` / `ancestor_finished`，记录 `automation_stopped`（“An ancestor card was cancelled, archived or removed”），不移动后代卡片。
- 看板上已有晚于 `turnAt` 的 `agent.turn_ended`（钩子在处理前插件被重载等）：补做 §4.2。`needs_human` 时已有更晚的 `agent.turn_started`：补做恢复。
- 回合结束完全丢失（插件重载或重启时钩子没送到）：2 分钟宽限后，被监督 session 没有 activeTurn、没有待处理权限，也没有记录到回合结束。先用 daemon 自己对这个 session 的记录恢复结果（用户决定 2026-10-23：重载后要能接着跑）：session 处于 `error` → 失败的回合（消息为它的 lastError）；最近一条指令之后 session 发出的 attention 为 `finished` → 完成的回合，为 `error` → 失败的回合。恢复的结果像钩子那样记成一条 `agent.turn_ended`（完成的回合 note 为 “Recovered from the session's state after a missed turn hook”），再按 §4.2 判断：交付、提问、提醒、重试或限额照常处理。daemon 没留下记录（attention 已被人读过而清掉）或 session 已 `closed` → `needs_human` / `interrupted`，释放名额，detail 说明 session 是空闲、出错停止（附 lastError）还是已关闭，不伪造结果。

### 4.5 Provider 限额与备用模型

用户决定（2026-10-23）：评审者可能用 Opus 5.5 max 这类容易触及限额的模型，所以每个角色可以设一个备用模型。只靠 rate-fallback 插件不够：它为 Claude 会话另建的 GPT 备用 session 不是 Flowly 准备的，没有 Flowly 工具，也不是 job 绑定的评审者，提交不了评审结论；Flowly 自己的冷却最多约 30 分钟，等不到 Claude 的 5 小时或每周额度重置。

- **触发**：角色的回合因 provider 限额失败；以 completed 结束、但时间线最后一行（最近一条用户消息之后）是 Claude 的额度通知、`API Error` 或错误行（只读最后 30 条，引用通知的普通回答、其后的工具调用都不算）；创建或发消息给该角色的 session 时被限额拒绝。
- **换模型**：记录 `providerLimit`（该角色原模型 `provider/model`；原模型不确定时只记 provider），30 分钟内任何卡片的新 session 都直接用其角色的备用模型；标记 `fallback[role]`；替换该角色的 session：
  - 评审者：在新的 Flowly 准备的 session（备用模型）里重做**同一轮**评审（轮次不加），开头说明上一个评审模型触及上限。被替换的评审者迟到的结论被拒（`NOT_REVIEWER`）。
  - 实现者：新的 session（备用模型）接手，首条消息是接手说明（读 flowly_get_task 的 workpad、进度、评论和活动，检查 git status/diff/log，从已完成处继续，不重做）加开工说明、父卡反馈，以及上一个 session 没收到的指令或评审者尚未完成的修改要求。
  - 尚未创建成功的 session（创建时被拒）：保留原来的首条指令，用新的 preparation 在备用模型上创建。
  - 计数清零（失败、冷却、提醒），活动记 `automation_fallback`（“<model> reported a provider limit; the <role> continues on its fallback model”）。原 session 保留、不归档、不再受监督。
- **之后**：该角色在本次运行剩下的时间里一直用备用模型（不在中途换回）。备用模型也触及上限时按原来的冷却处理，不再换。Run again 开始新的运行：实现者沿用原 session（及其模型标记）以保持上下文；评审者不沿用备用 session，`providerLimit` 到期后重新用评审者自己的模型。
- **启动时**：角色原模型有未到期的 `providerLimit`，或其 provider 正在冷却，而备用模型可用：直接用备用模型创建，并记 `automation_fallback`（“… recently reported a provider limit; the … starts on its fallback model”）。Full access 同样作用于备用模型（§2）。
- **与 rate-fallback 插件**：自动化 session 带 label `paseo-rate-fallback=off`，rate-fallback 不再为它们建备用 session 或原地换模型，避免同一次限额出现两个接手者在同一个 worktree 里工作。人自己开的卡片 session 不带这个 label，仍由 rate-fallback 处理。

插件 SDK 只在 RPC/钩子上下文里提供 Paseo 连接；dispatcher 用最近一次拿到的连接。daemon 重启后在第一次 RPC 或钩子到来前不派发（看板打开即会到来）。

## 5. 评审回路

- 实现者交付后：`role=reviewer`、`reviewing`、`reviewRounds+1`，`deliveryEvent` 记这次交付，记 `automation_review_started`。首轮在同一 workspace 创建评审 session（`labels.flowly-automation=reviewer`，标题 `Review: <卡片>`）；之后各轮复用它，被归档则新建。
- 实现者在同一交付的评审期间随口回答：保留原轮次、原指令与 preparation。`reviewPause` 保存评审原来的等人、重试、失败/冷却计数与 retryAt，闲聊结束后恢复；实现者的回合不会替评审者回答问题或消耗其重试预算。创建/发送的异步失败即使在这段暂停期间返回，也归属于原评审请求：明确拒绝撤销 `dispatched`，未知结果进入原等待，不丢失、不立即重发。
- **评审周期**：从排队开始，或从交付后（或评审中）给实现者的反馈开始。反馈开始新周期：下一次新交付从第 1 轮评审，即使上一个周期已用完所有轮次（Review rounds = 1，或在最后一轮批准）也不再记为 “Review rounds used up”。`maxReviewRounds` 只限制一个周期内的轮数。
- 评审说明（`reviewPrompt`）沿用 Hermes `sdlc-review` 的分轮视角：第 1 轮先冷读 diff 再对照交付说明；第 2 轮亲自运行构建、测试与所述行为；第 3 轮起逐条对照原卡验收标准和此前每轮的修改要求。只评审，不改文件、不提交、不改卡片状态。
- **规则 A1 例外**：job 活着或 `delivered` 时，job 自己的评审 session 开始回合不把卡片从 In review 拉回工作阶段（它不是在做卡片的工作），不只是在它评审的时候。
- 评审者在本轮之外开始回合（人问它结论、返工期间、Run again 保留它之后）：job 不变，不视为接管。
- 新工具 `flowly_submit_review { verdict: approve | changes, summary, findings[] }`（MCP；CLI fallback 为 `submit-review --review <JSON>`，不需要 request file，同一 API 动作 `review` 与校验）：
  - 只接受该卡当前 job 的 `reviewerId`，否则 `NOT_REVIEWER`；本轮已结束或卡片不在 In review → `REVIEW_CLOSED`；同一结论重复调用 → `replayed`。结论记在 `reviewedEvent`（本轮的交付）上。新轮的指令携带 `reviewDelivery`；它尚未到达评审者时，旧结论为 `REVIEW_CLOSED`。真实 reviewer turn 可以确认正在创建或已发出的同一条指令，即使 create/send 的响应还未返回；明确失败的旧调用不能被无关回合当作送达。
  - `approve`：job `delivered`、`verdict=approved`，卡片留在 In review，记 `automation_review_approved`（附摘要）。
  - `changes`：卡片回到 `resumeStage`（通常 Development，`rule="REVIEW"`），job 回到实现者 `working`，把摘要与发现以 `[Flowly automation] The reviewer requested changes …` 发给实现者，记 `automation_changes_requested`。评审者回合仍在进行时这条消息暂扣，回合一结束就送出（§4.2）。
- 评审者回合结束没给结论：提醒（同 §4.2）；满了或失败到上限 → job `delivered`、`verdict=incomplete`，卡片留在 In review 给人。

## 6. 界面

1. **卡片信号行**：Queued for agent / Starting agent… / Agent working / Agent reviewing（脉冲点）/ Agent retrying / Agent waiting for you / Agent needs permission / Agent review passed / Review needs you / Automation stopped（失败时）。`stopped` 与不带评审的 `delivered` 不显示（泳道已说明）。
2. **卡片详情**：标题与标签下一行 “Agent automation · 状态”，附原因、daemon 文本与计数（评审第 n/m 轮、提醒 n/m、失败 n/m），按钮 Run with agent / Run again / Stop。项目未开启且没有 job 时不显示。原因行按状态措辞：
   - `retry_wait` / `failed`：“The last turn failed; retrying”；`retry_wait` / `start_failed`：“The agent session could not be started; retrying”；`retry_wait` / `cooldown`：“Provider limit reached; retrying later”。
   - `needs_human` / `cooldown`（冷却预算用完）：“The provider limit kept recurring; reply in the session, or Stop and Run again”。
   - 活着的 job 当前角色已换到备用模型时另起一行 “On the fallback model after a provider limit”。
   - `failed` 状态保留 “Turns kept failing” 与 “The agent session could not be started”。
   - `workspace_unavailable`：“The card's workspace is no longer available”；`taken_over`：“Another session took over the card”；`ancestor_finished`：“An ancestor card was cancelled, archived or removed”。它们不再复用 session 消失或卡片移动的原因。
3. **菜单**：卡片右键/⋯、手机操作表、详情菜单都有 Run with agent（项目开启且卡片未结束）或 Stop automation（job 活着）。卡片的 workspace 不在已加载的 Paseo workspace 列表里时，看板右键菜单和手机操作表与详情一样把 Run with agent 显示为不可用；workspace 列表还在加载，或列表最后成功刷新早于卡片创建时，不因此禁用（agent 或其它设备创建的卡片可能先到达看板）。活着的 job 的 Stop automation 不受影响。
4. **Needs attention 与侧栏角标**：只在项目的 Agent automation 开启时列出卡片的自动化条目；关闭自动化后，它冻结的 job（包括 `needs_human`、`failed` 和等待评审的交付）的条目都消失。失败的 job 在失败后卡片状态被改过（自动化自己移到 Blocked，即 `rule="AUTO"` 的那次除外，例如人把它从 Blocked 拖回 Development）后离开 Needs attention；job 本身仍是 `failed`，详情里仍有 Run again。条目的自动化部分跟随卡片的信号：失败为 “Automation stopped”，等权限为 “Agent needs permission”，评审者没能定论的交付为 “Review needs you”，其它等待仍为 “Agent waiting for you”。
5. **编辑项目**：Agent automation 开关；开启后 Cards at once（1/2/3/5）、Implementer、Implementer fallback、Reviewer、Reviewer fallback（有评审者时）（模型选择沿用默认模型控件，“无”分别为项目默认模型 / 不评审 / No fallback）、Review rounds（有评审者时）、Full access。In review 关闭时显示 “Agent automation requires the In review lane.”。
6. **活动**：`automation_*` 事件各有文案；daemon 写的 note（“Reminder 1 of 2”、“Provider limit (1 of 5); retrying in 1 min”、“Another session took over the card” 等）保持英文。
7. **新手引导**：一次性提示 `agent-automation`（项目有 Backlog/Todo 卡、未打开卡片时，排在 first-card、task-intake 之后）；欢迎页 More features 增加 Agent automation（[ONBOARDING-SPEC](ONBOARDING-SPEC.md) §2、§5）。README Highlights 增加一节。

## 7. Skill

`skills/flowly/SKILL.md` 新增 “Automated runs”：首条指令以 `[Flowly automation]` 开头时无人值守，一次做到交付；每回合以交付、提问或 blocked 结束；按 `[Flowly automation]` 消息行事；评审者只评审，用 `flowly_submit_review` 结束本轮。实现者与评审者之间的交接由 daemon 做。原有 “不要自行分派或完成” 已按 [SUB-CARDS-SPEC](SUB-CARDS-SPEC.md) 放宽：agent 可以建卡与子卡片，并启动、验收（In review → Done）、取消**自己的直接子卡片**；agent 自己那张顶层卡片的 Done/Cancelled 仍由人决定。

## 8. 验收

- 纯函数（`shared/automation.test.ts`、`shared/automation-round2.test.ts`）：依赖必须 Done、Cancelled 不放行；按优先级填名额、等人回复不占名额、关闭或冻结的项目不派发；重试到期；交付→评审/交付给人/轮次用完；评审周期在反馈后重开、结论属于它所评的交付；提问与 blocker 等人；静默提醒到上限后 block；失败重试与放弃；中断等待；评审者无结论提醒后交给人且不 block；非监督 session 忽略；job 活着或已交付时它的评审者豁免 A1；provider 冷却只挡确定的同一 provider。
- 服务（`server/automation.test.ts` 与 `server/automation-*.test.ts`，假 SDK）：未开启时拒绝排队；排队后在卡片 workspace 创建无人值守 session（模型、模式、标签、开工说明）；名额、优先级与 blocker；提醒与 block 且同一回合结束不处理两次；提问等待与回复恢复；失败退避重试与放弃、退避期间人的回合取代重试；创建失败重试后报告且不动卡片；未知结果等人且不重发；评审回路（非评审者拒绝、修改→Development 并发给实现者、重复结论 replayed、第二轮复用评审 session、批准后留在 In review、反馈后新周期）；人移动卡片停止且不动 session、已交付卡在工作阶段间移动仍为 delivered、再次排队复用 session；钩子漏掉的回合结束由对账补上；idle/error/closed 的 session 丢失回合后等人；被监督 session 或卡片 workspace 归档后结束；共享目录占用。
- 备用模型（`server/automation-fallback.test.ts`、`shared/automation-fallback.test.ts`）：评审者触及上限后在备用模型上重做同一轮、旧评审者结论被拒、新评审者结论生效；实现者触及上限后新 session 接手（接手说明、Full access、opt-out label），旧 session 的回合不再处理；接手带上未完成的修改要求；无备用模型时仍是冷却；备用模型也触及上限时冷却、不再换；completed 回合末尾的 Claude 额度通知算上限，引用通知的普通回答不算；上限记录期间新卡片直接用备用模型、到期后回到原模型；冷却中的 provider 不挡有备用模型的角色；创建时被拒则在备用模型上用原首条指令创建；Run again 在记录到期后回到评审者自己的模型。限额文字识别与冷却闸门的纯函数测试。
- 真实 daemon + Web UI（按 open-paseo-plugins/AGENTS.md）：安装到本机 daemon，用 app.paseo.sh 验证设置、排队、真实 agent 跑到交付、评审回路与卡片/详情显示；fixture 项目与 session 用后清理。结果记在 [verification/automation.md](verification/automation.md)。

## 9. 不做（本期）与后续

- **编排**：已由 [SUB-CARDS-SPEC](SUB-CARDS-SPEC.md) 实现（agent 建卡/子卡、依赖、父卡等待与唤醒）。仍不做：triage 列由 LLM 自动拆卡（Hermes decomposer）。
- goal 模式（每回合由裁判模型判定是否达成）、定时开始（`scheduled_at`）、按卡片指定执行者/模型、per-profile 并发、心跳/超时回收（Paseo 自己的 session 状态已覆盖进程存活；长时间 running 只靠人看）。
- 依赖 Done 不等于上游代码已进入下游 worktree（此前设计稿指出）：Flowly 不同步分支；开工说明附 blocker 的 handoff 与分支（子卡片另附父卡集成分支，§4.1），由执行者检查后合并。
- 降级到上游 Flowly：旧版本解析 `board.json` 时会丢弃 `automation` 与 `project.automation`（zod 非严格对象），卡片与其它数据不受影响。


## 10. Review hardening (2026-10-22)

- Stop、人的接管、卡片/项目归档优先于旧异步操作。每次事务与创建/发送之前重读 generation、role、当前归属和 enabled；关闭项目自动化冻结 job，归档停止 job，但不打断或归档 session。取消/归档祖先也停止后代的 job，不改后代泳道。
- `pendingOp` 增加 `pendingRole`。实现者与评审者不得使用同一 preparation/session；放弃评审、角色转换和确认创建后清除 preparation。Run again 保留已知的两种角色 session 供复用。
- 修订 §1 的 outbox 取舍：每个 job 只保存一个 `instruction {id, role, text, fresh}`，与状态转换同事务写入。原文及稳定 messageId 在重载/发送失败后保留；确认送达后删除。它不是通用工作流队列。`feedback` 保存父卡给子卡的修改要求。
- 发送前检查实际 session 的 running/initializing、activeTurn 和 pending permissions，忙时保留指令，下一次派发再试；显式 `activeTurnBehavior=steer`。Paseo 0.12 没有原子的 idle-only send：检查与请求到达之间仍有竞态，且 steer 不可用时 daemon 可回退为 interrupt；这是宿主 API 限制，所以只能说自动化**不主动**打断，不能声称严格不打断。已完成 message receipt 可安全重放；`agent_request_outcome_unknown` 按 §4.4 等人，绝不换 ID 盲发。
- 真实 refresh RPC 失败是未知状态，不当作 session 消失。启动结果未知或冷却预算用尽而尚未确认存在的 session（`unconfirmed`）一直保留等人状态；后续刷新仍为空不转成失败。session 迟到并开始回合后恢复监督。只有确定不存在/已归档/工作区不匹配才结束或替换。stale starting 或缺少角色 session 会重做原创建路径。回合钩子完全丢失时按 §4.4 保守地等人并释放名额。
- 交付、`deliveryEvent`/`reviewedEvent` 与评审周期见 §3、§4.2、§5：A1r 恢复旧 In review 不启动新评审；结论只属于它所评的那次交付；实现者在评审期间开始工作会关闭旧评审归属，旧 reviewer 的迟到结论不生效；别的 managed session 接管时停止原自动化（§4.3）。
- 成功回合清零连续失败计数。明确的 429/rate-limit/quota/overload 失败使用 `cooldowns`（最多 5 次，1、2、4、8、15 分钟，§4.2），不消耗普通 failureLimit；`provider` 来自实际当前 session，冷却按 §4.1 只挡确定的同一 provider。超过上限等人处理，不把整个队列刷成 Blocked。
- 自动化需要启用 In review（§2）；旧的无效配置冻结，不派发也不关闭 job。
- **共享目录**：启动与父卡唤醒都检查 maxRunning 和工作区实际目录（realpath）。Flowly 不会向另一张卡的自动化 session 正在用的物理目录派发 worker：另一张**仍在进行**的卡（未归档、不在 Done/Cancelled）的 job 占名额时，或它的自动化 session 仍在运行、在回合中或等权限时（包括 stopped 或等权限的 job），都算占用。Done、Cancelled 或已归档卡片的 job 不再占用目录，即使它的 session 仍在运行（那个 session 已是人的）。每次占用判断只扫描一遍 workspace 分页列表，再按 id 复用；先排除既不占名额也没有 session 的旧 job，避免每张卡分别触发完整扫描。**这个保护只看自动化 job 的 session**：没有 job 的卡片上的普通 session（人自己开的，或在普通 session 里拆出子卡的父卡 agent）不被考虑，所以在非 git 项目（目录 workspace 共享项目根）里，普通 session 与自动化 worker 可能同时改同一份 checkout，这由用户自己协调（例如用 worktree 项目，或等普通 session 的回合结束再启动子卡）。人的直接操作也不受此调度规则控制。
- `waiting`、`sub_cards`、`subSeen` 为子卡等待协议字段；父卡唤醒遵守同一项目开关、冻结、归属和名额。发送的是当前子卡 handoff（有界的交付、workpad 检查、目录、分支、未满足 blocker），原文失败后保留。
- daemon 发出的 `[Flowly automation]` 文本不计入人的 memory clue 或 next-move 选择率；摘要保留内容但标作 Flowly automation。
